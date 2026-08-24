/**
 * Rate-limit middleware (token bucket, in-process).
 *
 * Designed for endpoints whose backing work is expensive enough that a flood
 * is a credible DoS — primarily the auth and credential-touching routes
 * (sign-in, sign-up, password change/reset, ephemeral re-auth). scrypt costs
 * 50–500 ms of thread-pool work per call, so without this guard a script can
 * keep every libuv worker busy and starve unrelated traffic.
 *
 * Storage is a per-process Map. Lumiverse runs as a single Bun process, so
 * this is sufficient; if we ever shard across nodes the limiter would need a
 * shared backend.
 */
import { getClientIp } from "../utils/client-ip";
const buckets = new Map();
const MAX_BUCKETS = 10_000;
let _sweepTimer = null;
function startSweep() {
    if (_sweepTimer)
        return;
    // Drop bucket entries that have fully refilled and aren't being touched —
    // keeps memory bounded for endpoints with bursty traffic from rotating IPs.
    _sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of buckets) {
            if (now - entry.updatedAt > 10 * 60 * 1000) {
                buckets.delete(key);
            }
        }
    }, 60_000);
    // Don't keep the process alive on this timer alone.
    if (typeof _sweepTimer.unref === "function") {
        _sweepTimer.unref();
    }
}
export function stopRateLimitSweep() {
    if (_sweepTimer) {
        clearInterval(_sweepTimer);
        _sweepTimer = null;
    }
}
function defaultKey(c, bucket) {
    return `${bucket}:${getClientIp(c)}`;
}
function consumeToken(key, max, windowMs, now) {
    // Hard cap on bucket count so a flood of unique IPs can't grow the Map
    // without bound. We evict the oldest entry (insertion order).
    while (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
        const oldest = buckets.keys().next();
        if (oldest.done)
            break;
        buckets.delete(oldest.value);
    }
    const refillRatePerMs = max / windowMs;
    let entry = buckets.get(key);
    if (!entry) {
        entry = { tokens: max - 1, updatedAt: now };
        buckets.set(key, entry);
        return { allowed: true, retryAfterMs: 0 };
    }
    const elapsed = Math.max(0, now - entry.updatedAt);
    entry.tokens = Math.min(max, entry.tokens + elapsed * refillRatePerMs);
    entry.updatedAt = now;
    if (entry.tokens >= 1) {
        entry.tokens -= 1;
        return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil((1 - entry.tokens) / refillRatePerMs);
    return { allowed: false, retryAfterMs };
}
/**
 * Build a Hono middleware that enforces a token-bucket limit. Use
 * `bucket` to scope different routes against the same key so a sign-in
 * flood doesn't lock the user out of the password-reset endpoint.
 */
export function rateLimit(options) {
    startSweep();
    const bucket = options.bucket ?? "default";
    const message = options.message ?? "Too many requests, please slow down.";
    return async (c, next) => {
        const key = options.key ? options.key(c) : defaultKey(c, bucket);
        const decision = consumeToken(key, options.max, options.windowMs, Date.now());
        if (decision.allowed)
            return next();
        const retrySec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        c.header("Retry-After", String(retrySec));
        return c.json({ error: message, retryAfterSeconds: retrySec }, 429);
    };
}
