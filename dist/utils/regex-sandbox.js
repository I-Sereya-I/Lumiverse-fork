import { shouldUseBunWorkers, warnBunWorkerFallback } from "./bun-worker-guard";
import { runRegexRequest } from "./regex-sandbox-core";
/**
 * Worker-backed regex sandbox.
 *
 * User-supplied patterns (regex scripts, the {{regex}} macro, the
 * {{regexInstalled}} macro, the test-regex API) used to run on the main event
 * loop, where catastrophic backtracking like `(a+)+$` would freeze the entire
 * server until the process was killed. This module evaluates those patterns
 * inside a Bun Worker pool with a hard wall-clock timeout. When the timeout
 * fires we kill the worker, reject the in-flight request, and respawn — the
 * main thread stays responsive.
 *
 * The pool is small (default 2 workers) because regex evaluation is normally
 * fast: the primary cost we're paying is the postMessage round-trip, not
 * concurrency. A second worker exists so that one runaway regex doesn't
 * stall every other regex in the same generation.
 */
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_POOL_SIZE = 2;
export class RegexTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`Regex evaluation exceeded ${timeoutMs}ms and was aborted`);
        this.timeoutMs = timeoutMs;
        this.name = "RegexTimeoutError";
    }
}
export class RegexSandboxError extends Error {
    constructor(message) {
        super(message);
        this.name = "RegexSandboxError";
    }
}
class RegexWorkerPool {
    maxSize;
    workers = new Set();
    idle = [];
    inflight = new Map();
    queue = [];
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    run(op, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            const item = {
                op,
                payload,
                timeoutMs,
                resolve: resolve,
                reject,
            };
            const worker = this.acquire();
            if (worker) {
                this.dispatch(worker, item);
            }
            else {
                this.queue.push(item);
            }
        });
    }
    acquire() {
        const idle = this.idle.pop();
        if (idle)
            return idle;
        if (this.workers.size < this.maxSize) {
            return this.spawn();
        }
        return null;
    }
    spawn() {
        const worker = new Worker(new URL("./regex-sandbox.worker.ts", import.meta.url).href, { type: "module" });
        worker.addEventListener("message", (e) => this.onMessage(worker, e));
        worker.addEventListener("error", (e) => this.onError(worker, e));
        this.workers.add(worker);
        return worker;
    }
    dispatch(worker, item) {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => this.onTimeout(worker), item.timeoutMs);
        this.inflight.set(worker, {
            id,
            timer,
            resolve: item.resolve,
            reject: item.reject,
            timeoutMs: item.timeoutMs,
        });
        worker.postMessage({ id, op: item.op, ...item.payload });
    }
    onMessage(worker, event) {
        const data = event.data;
        const flight = this.inflight.get(worker);
        if (!flight || flight.id !== data.id)
            return; // stale; ignore
        this.inflight.delete(worker);
        clearTimeout(flight.timer);
        if (data.ok)
            flight.resolve(data.result);
        else
            flight.reject(new RegexSandboxError(data.error || "Regex evaluation failed"));
        this.release(worker);
    }
    onError(worker, event) {
        const flight = this.inflight.get(worker);
        if (flight) {
            this.inflight.delete(worker);
            clearTimeout(flight.timer);
            flight.reject(new RegexSandboxError(`Regex worker crashed: ${event.message || "unknown"}`));
        }
        this.discard(worker);
        this.drainQueue();
    }
    onTimeout(worker) {
        const flight = this.inflight.get(worker);
        if (flight) {
            this.inflight.delete(worker);
            flight.reject(new RegexTimeoutError(flight.timeoutMs));
        }
        try {
            worker.terminate();
        }
        catch { /* ignore */ }
        this.discard(worker);
        this.drainQueue();
    }
    release(worker) {
        const next = this.queue.shift();
        if (next)
            this.dispatch(worker, next);
        else
            this.idle.push(worker);
    }
    discard(worker) {
        this.workers.delete(worker);
        this.idle = this.idle.filter((w) => w !== worker);
    }
    drainQueue() {
        while (this.queue.length > 0) {
            const worker = this.acquire();
            if (!worker)
                break;
            const item = this.queue.shift();
            if (!item) {
                this.idle.push(worker);
                break;
            }
            this.dispatch(worker, item);
        }
    }
    releaseIdle() {
        if (this.queue.length > 0)
            return 0;
        const idle = this.idle;
        this.idle = [];
        for (const worker of idle) {
            this.workers.delete(worker);
            try {
                worker.terminate();
            }
            catch { /* ignore */ }
        }
        return idle.length;
    }
    /** Tear down the pool — call from shutdown hooks. */
    shutdown() {
        for (const w of this.workers) {
            try {
                w.terminate();
            }
            catch { /* ignore */ }
        }
        this.workers.clear();
        this.idle = [];
        for (const flight of this.inflight.values()) {
            clearTimeout(flight.timer);
            flight.reject(new RegexSandboxError("Regex sandbox shut down"));
        }
        this.inflight.clear();
        for (const item of this.queue) {
            item.reject(new RegexSandboxError("Regex sandbox shut down"));
        }
        this.queue = [];
    }
}
let _pool = null;
function getPool() {
    if (!_pool)
        _pool = new RegexWorkerPool(DEFAULT_POOL_SIZE);
    return _pool;
}
function runRegexInline(op, payload) {
    // Windows Bun worker crashes are worse than losing timeout isolation here.
    warnBunWorkerFallback("regex sandbox");
    if (op === "replace") {
        return Promise.resolve(runRegexRequest({
            id: "inline",
            op,
            pattern: String(payload.pattern ?? ""),
            flags: String(payload.flags ?? ""),
            input: String(payload.input ?? ""),
            replacement: String(payload.replacement ?? ""),
        }));
    }
    if (op === "test") {
        return Promise.resolve(runRegexRequest({
            id: "inline",
            op,
            pattern: String(payload.pattern ?? ""),
            flags: String(payload.flags ?? ""),
            input: String(payload.input ?? ""),
            replacement: String(payload.replacement ?? ""),
        }));
    }
    if (op === "capture-replacements") {
        return Promise.resolve(runRegexRequest({
            id: "inline",
            op,
            pattern: String(payload.pattern ?? ""),
            flags: String(payload.flags ?? ""),
            input: String(payload.input ?? ""),
            replacement: String(payload.replacement ?? ""),
        }));
    }
    return Promise.resolve(runRegexRequest({
        id: "inline",
        op,
        pattern: String(payload.pattern ?? ""),
        flags: String(payload.flags ?? ""),
        input: String(payload.input ?? ""),
    }));
}
export function shutdownRegexSandbox() {
    if (_pool) {
        _pool.shutdown();
        _pool = null;
    }
}
export function releaseIdleRegexWorkers() {
    return _pool?.releaseIdle() ?? 0;
}
/** Validate the pattern compiles before sending to a worker. */
function assertCompilable(pattern, flags) {
    // A syntactically invalid pattern doesn't risk ReDoS — fail synchronously
    // so callers don't pay the worker round-trip just to get a SyntaxError.
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
}
export async function regexReplaceSandboxed(pattern, flags, input, replacement, timeoutMs = DEFAULT_TIMEOUT_MS) {
    assertCompilable(pattern, flags);
    if (!shouldUseBunWorkers()) {
        return runRegexInline("replace", { pattern, flags, input, replacement });
    }
    return getPool().run("replace", { pattern, flags, input, replacement }, timeoutMs);
}
export async function regexCollectSandboxed(pattern, flags, input, timeoutMs = DEFAULT_TIMEOUT_MS) {
    assertCompilable(pattern, flags);
    if (!shouldUseBunWorkers()) {
        return runRegexInline("collect", { pattern, flags, input });
    }
    return getPool().run("collect", { pattern, flags, input }, timeoutMs);
}
/**
 * Collect raw-mode replacement templates with captures already interpolated.
 * This keeps large capture arrays inside the worker instead of cloning them
 * across the worker boundary.
 */
export async function regexCaptureReplacementsSandboxed(pattern, flags, input, replacement, timeoutMs = DEFAULT_TIMEOUT_MS) {
    assertCompilable(pattern, flags);
    if (!shouldUseBunWorkers()) {
        return runRegexInline("capture-replacements", { pattern, flags, input, replacement });
    }
    return getPool().run("capture-replacements", { pattern, flags, input, replacement }, timeoutMs);
}
export async function regexTestSandboxed(pattern, flags, input, replacement, timeoutMs = DEFAULT_TIMEOUT_MS) {
    assertCompilable(pattern, flags);
    if (!shouldUseBunWorkers()) {
        return runRegexInline("test", {
            pattern,
            flags,
            input,
            replacement,
        });
    }
    return getPool().run("test", { pattern, flags, input, replacement }, timeoutMs);
}
