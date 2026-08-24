const DEFAULT_WINDOW_MS = 60_000;
const STALE_GATE_TTL_MS = 10 * 60_000;
const gates = new Map();
let sweepTimer = null;
function getAbortReason(signal) {
    return signal?.reason ?? new DOMException("Aborted", "AbortError");
}
function getGate(key) {
    let gate = gates.get(key);
    if (gate)
        return gate;
    gate = {
        timestamps: [],
        tail: Promise.resolve(),
        lastTouchedAt: Date.now(),
    };
    gates.set(key, gate);
    startSweep();
    return gate;
}
function startSweep() {
    if (sweepTimer)
        return;
    sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, gate] of gates) {
            pruneExpired(gate.timestamps, now, DEFAULT_WINDOW_MS);
            if (gate.timestamps.length === 0 && now - gate.lastTouchedAt > STALE_GATE_TTL_MS) {
                gates.delete(key);
            }
        }
    }, 60_000);
    if (typeof sweepTimer.unref === "function") {
        sweepTimer.unref();
    }
}
function stopSweepIfIdle() {
    if (gates.size === 0 && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}
function pruneExpired(timestamps, now, windowMs) {
    while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
        timestamps.shift();
    }
}
function waitForDelay(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    if (!signal)
        return new Promise((resolve) => setTimeout(resolve, ms));
    if (signal.aborted)
        return Promise.reject(getAbortReason(signal));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(getAbortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
export async function waitForCortexSidecarRpmSlot(options) {
    const requestsPerMinute = Math.max(0, Math.floor(options.requestsPerMinute ?? 0));
    if (requestsPerMinute <= 0)
        return;
    const windowMs = Math.max(1, Math.floor(options.windowMs ?? DEFAULT_WINDOW_MS));
    const key = `${options.userId}:${options.provider}`;
    const gate = getGate(key);
    let releaseLock;
    const previous = gate.tail;
    gate.tail = new Promise((resolve) => {
        releaseLock = resolve;
    });
    await previous;
    try {
        while (true) {
            if (options.signal?.aborted)
                throw getAbortReason(options.signal);
            const now = Date.now();
            pruneExpired(gate.timestamps, now, windowMs);
            if (gate.timestamps.length < requestsPerMinute) {
                gate.timestamps.push(now);
                gate.lastTouchedAt = now;
                return;
            }
            const oldest = gate.timestamps[0];
            const waitMs = Math.max(1, windowMs - (now - oldest));
            await waitForDelay(waitMs, options.signal);
        }
    }
    finally {
        gate.lastTouchedAt = Date.now();
        releaseLock();
        if (gate.timestamps.length === 0) {
            gates.delete(key);
            stopSweepIfIdle();
        }
    }
}
export function resetCortexSidecarRpmGateForTests() {
    gates.clear();
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}
