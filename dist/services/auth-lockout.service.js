const FAILURE_THRESHOLD = 5;
const INITIAL_LOCKOUT_STEPS_MS = [
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
    6 * 60 * 60 * 1000,
];
const MAX_LOCKOUT_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const states = new Map();
let sweepTimer = null;
function formatSeconds(ms) {
    return Math.max(1, Math.ceil(ms / 1000));
}
function startSweep() {
    if (sweepTimer)
        return;
    sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [clientId, state] of states) {
            const hasActiveFailures = Object.values(state.failures).some((count) => count > 0);
            const activeUntil = Math.max(state.lastActivityAt, state.lockedUntil);
            if (!hasActiveFailures && now - activeUntil > STATE_TTL_MS) {
                states.delete(clientId);
            }
        }
    }, 60_000);
    if (typeof sweepTimer.unref === "function") {
        sweepTimer.unref();
    }
}
function getOrCreateState(clientId, now) {
    let state = states.get(clientId);
    if (state) {
        state.lastActivityAt = now;
        return state;
    }
    while (states.size >= MAX_ENTRIES && !states.has(clientId)) {
        const oldest = states.keys().next();
        if (oldest.done)
            break;
        states.delete(oldest.value);
    }
    state = {
        failures: { unauthorized: 0, login: 0, origin: 0 },
        level: 0,
        lockedUntil: 0,
        lastActivityAt: now,
        lastReason: null,
    };
    states.set(clientId, state);
    return state;
}
function nextLockoutMs(level) {
    if (level <= INITIAL_LOCKOUT_STEPS_MS.length) {
        return INITIAL_LOCKOUT_STEPS_MS[level - 1];
    }
    const extraLevels = level - INITIAL_LOCKOUT_STEPS_MS.length;
    const ms = INITIAL_LOCKOUT_STEPS_MS[INITIAL_LOCKOUT_STEPS_MS.length - 1] * (2 ** extraLevels);
    return Math.min(ms, MAX_LOCKOUT_MS);
}
function toLockoutInfo(clientId, state, now) {
    if (state.lockedUntil <= now)
        return null;
    return {
        clientId,
        level: state.level,
        lockedUntil: state.lockedUntil,
        retryAfterMs: state.lockedUntil - now,
        reason: state.lastReason,
    };
}
function detailsToLog(details) {
    const out = [];
    for (const [key, value] of Object.entries(details)) {
        if (value == null || value === "")
            continue;
        out.push(`${key}=${JSON.stringify(value)}`);
    }
    return out.length > 0 ? ` ${out.join(" ")}` : "";
}
function resetReasons(state, reasons) {
    for (const reason of reasons) {
        state.failures[reason] = 0;
    }
}
class AuthLockoutService {
    constructor() {
        startSweep();
    }
    getActiveLockout(clientId, now = Date.now()) {
        const state = states.get(clientId);
        if (!state)
            return null;
        if (state.lockedUntil <= now)
            return null;
        return toLockoutInfo(clientId, state, now);
    }
    recordFailure(clientId, reason, details = {}, now = Date.now()) {
        // Don't lock out loopback — it's almost always the server owner, and
        // polling components (Operator Panel, generation recovery watchdog) can
        // hit 401s rapidly when a session expires.  Rate-limiting still applies.
        if (clientId === "127.0.0.1" || clientId === "::1") {
            return { count: 0, lockout: null };
        }
        // Clients with no resolvable peer address ("unknown") stay lockable under
        // that shared key. Bun resolves peers for real connections, so the bucket
        // is normally empty; if it ever isn't, a client that defeats IP resolution
        // must not get an unthrottled brute-force lane. The shared key means such
        // clients lock each other out — an acceptable trade for a state that
        // should not exist in practice.
        const state = getOrCreateState(clientId, now);
        state.failures[reason] += 1;
        state.lastReason = reason;
        console.warn(`[auth-lockout] ${reason} failure ${state.failures[reason]}/${FAILURE_THRESHOLD} for ${clientId}${detailsToLog(details)}`);
        if (state.failures[reason] < FAILURE_THRESHOLD) {
            return { count: state.failures[reason], lockout: null };
        }
        state.level += 1;
        state.lockedUntil = now + nextLockoutMs(state.level);
        state.lastReason = reason;
        resetReasons(state, ["unauthorized", "login", "origin"]);
        const lockout = toLockoutInfo(clientId, state, now);
        console.warn(`[auth-lockout] Locked ${clientId} for ${formatSeconds(lockout.retryAfterMs)}s at level ${lockout.level} after repeated ${reason} failures${detailsToLog(details)}`);
        return { count: FAILURE_THRESHOLD, lockout };
    }
    recordSuccess(clientId, reasons, now = Date.now()) {
        const state = states.get(clientId);
        if (!state)
            return;
        state.lastActivityAt = now;
        resetReasons(state, Array.isArray(reasons) ? reasons : [reasons]);
    }
    logBlockedRequest(clientId, info, details = {}) {
        console.warn(`[auth-lockout] Blocked locked client ${clientId} for ${formatSeconds(info.retryAfterMs)}s more at level ${info.level}${detailsToLog(details)}`);
    }
    buildPayload(info, message) {
        return {
            error: message,
            retryAfterSeconds: formatSeconds(info.retryAfterMs),
            lockedUntil: new Date(info.lockedUntil).toISOString(),
            lockoutLevel: info.level,
            reason: info.reason,
        };
    }
}
export const authLockoutService = new AuthLockoutService();
