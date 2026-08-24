const SUPERSEDED = { mainResult: null, linkedResult: null };
let worker = null;
let inflight = null;
const queue = [];
/** Operators can force the in-process (blocking) path with this env flag. */
export function canUseCortexWorker() {
    return process.env.LUMIVERSE_CORTEX_WORKER !== "false";
}
function disposeWorker() {
    if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
    }
}
/** Release the warm worker only when no request depends on its isolate. */
export function releaseIdleCortexWarmWorker() {
    if (!worker || inflight || queue.length > 0)
        return 0;
    disposeWorker();
    return 1;
}
function handleMessage(event) {
    const message = event.data;
    if (!message || !inflight || message.requestId !== inflight.requestId)
        return;
    const item = inflight;
    inflight = null;
    if (message.type === "result") {
        item.resolve(message.result);
    }
    else {
        const err = new Error(message.error);
        err.name = message.name || "CortexWarmWorkerError";
        if (message.stack)
            err.stack = message.stack;
        item.reject(err);
    }
    pump();
}
function handleError(event) {
    const err = new Error(event.message || "Cortex warm worker crashed");
    // The worker is in an unknown state — tear it down so the next job respawns.
    disposeWorker();
    if (inflight) {
        const item = inflight;
        inflight = null;
        item.reject(err);
    }
    pump();
}
function ensureWorker() {
    if (worker)
        return worker;
    worker = new Worker(new URL("./cortex-warm-worker.ts", import.meta.url), {
        type: "module",
    });
    worker.onmessage = handleMessage;
    worker.onerror = handleError;
    return worker;
}
function pump() {
    if (inflight || queue.length === 0)
        return;
    const item = queue.shift();
    inflight = item;
    try {
        ensureWorker().postMessage({
            type: "warm",
            requestId: item.requestId,
            job: item.job,
        });
    }
    catch (err) {
        // Spawn / postMessage failed — reject this job (caller falls back
        // in-process) and reset so the next one can retry a fresh worker.
        inflight = null;
        disposeWorker();
        item.reject(err);
        pump();
    }
}
/**
 * Run a cortex warm-cache retrieval off the main thread. Resolves with the
 * computed results (to be mirrored into the host cache by the caller), or a
 * no-op `{ null, null }` when superseded by a newer job for the same chat.
 * Rejects if the worker fails — callers should fall back to in-process work.
 */
export function warmCortexInWorker(job) {
    return new Promise((resolve, reject) => {
        // Drop any still-queued job for this chat — a newer query supersedes it.
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].chatId === job.chatId) {
                const stale = queue.splice(i, 1)[0];
                stale.resolve(SUPERSEDED);
            }
        }
        queue.push({
            requestId: crypto.randomUUID(),
            chatId: job.chatId,
            job,
            resolve,
            reject,
        });
        pump();
    });
}
