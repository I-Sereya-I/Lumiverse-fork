import os from "node:os";
import { registry } from "../macros";
import { macroInterceptorChain } from "../spindle/macro-interceptor";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
function workerDisabledByEnv() {
    return process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER === "false";
}
function hasMainProcessOnlyMacros() {
    return registry.getAllMacros().some((macro) => !macro.builtIn);
}
export function canUsePromptAssemblyWorker() {
    if (workerDisabledByEnv())
        return false;
    // Extension macros are registered in the main process and cannot yet execute
    // inside the assembly worker. Keep behavior correct by falling back to the
    // in-process pipeline when any non-built-in macro is registered.
    if (hasMainProcessOnlyMacros())
        return false;
    if (macroInterceptorChain.count > 0)
        return false;
    if (worldInfoInterceptorChain.count > 0)
        return false;
    return true;
}
// ─── Worker pool ──────────────────────────────────────────────────────────
//
// Assembly workers are REUSED rather than spawned-and-terminated per request.
// A fresh isolate pays the tokenizer module cold-load every generation (GLM
// ~1.1s, Claude ~130ms) and starts the token-count + databank result caches
// empty — so a per-call worker never benefits from the cross-generation
// caching that makes regenerate/swipe cheap. A reused worker loads tokenizers
// once and keeps those caches warm.
//
// One job per worker at a time; concurrent assemblies (council mode, multiple
// tabs) fan out across the pool. Workers are evicted after a quiet period so an
// idle instance doesn't hold tokenizer/LanceDB memory indefinitely.
const IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_WORKERS = 2;
const MAX_WORKERS = (() => {
    const raw = Number(process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS);
    const want = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_WORKERS;
    let ceil = DEFAULT_MAX_WORKERS;
    try {
        ceil = Math.max(1, os.availableParallelism() - 1);
    }
    catch {
        /* availableParallelism unavailable — keep the default ceiling */
    }
    return Math.max(1, Math.min(want, ceil));
})();
const pool = [];
const waiting = [];
function settleJob(job, fn) {
    if (job.settled)
        return;
    job.settled = true;
    if (job.signal && job.onAbort) {
        job.signal.removeEventListener("abort", job.onAbort);
    }
    fn();
}
function spawnWorker() {
    const worker = new Worker(new URL("./prompt-assembly-worker.ts", import.meta.url), {
        type: "module",
    });
    const pw = { worker, job: null, lastChatId: null, idleTimer: null };
    worker.onmessage = (event) => onMessage(pw, event.data);
    worker.onerror = (event) => onError(pw, event.message || "Prompt assembly worker crashed");
    pool.push(pw);
    return pw;
}
function destroyWorker(pw) {
    const idx = pool.indexOf(pw);
    if (idx >= 0)
        pool.splice(idx, 1);
    if (pw.idleTimer) {
        clearTimeout(pw.idleTimer);
        pw.idleTimer = null;
    }
    pw.worker.onmessage = null;
    pw.worker.onerror = null;
    pw.worker.terminate();
}
/** Terminate only workers that are not serving a prompt or queueing work. */
export function releaseIdlePromptAssemblyWorkers() {
    if (waiting.length > 0)
        return 0;
    let released = 0;
    for (const pw of [...pool]) {
        if (pw.job)
            continue;
        destroyWorker(pw);
        released++;
    }
    return released;
}
function markIdle(pw) {
    if (pw.idleTimer)
        clearTimeout(pw.idleTimer);
    pw.idleTimer = setTimeout(() => {
        pw.idleTimer = null;
        if (!pw.job)
            destroyWorker(pw);
    }, IDLE_TTL_MS);
}
function onMessage(pw, msg) {
    const job = pw.job;
    if (!job || !msg || msg.requestId !== job.requestId)
        return;
    pw.job = null;
    if (msg.type === "result") {
        settleJob(job, () => job.resolve(msg.result));
    }
    else {
        const err = new Error(msg.error);
        err.name = msg.name || "PromptAssemblyWorkerError";
        if (msg.stack)
            err.stack = msg.stack;
        settleJob(job, () => job.reject(err));
    }
    markIdle(pw);
    drain();
}
function onError(pw, message) {
    const job = pw.job;
    pw.job = null;
    // The worker is in an unknown state — discard it so a fresh one respawns.
    destroyWorker(pw);
    // Reject the in-flight job (generate.service falls back to in-process).
    if (job)
        settleJob(job, () => job.reject(new Error(message)));
    drain();
}
function abortJob(job) {
    if (job.settled)
        return;
    // Still queued — just drop it.
    const wIdx = waiting.indexOf(job);
    if (wIdx >= 0)
        waiting.splice(wIdx, 1);
    // In-flight — the worker's CPU-bound assembly can't be cancelled (the signal
    // is stripped before postMessage), so discard the worker to stop the work.
    const pw = pool.find((p) => p.job === job);
    if (pw) {
        pw.job = null;
        destroyWorker(pw);
    }
    settleJob(job, () => job.reject(job.signal?.reason ?? new DOMException("Aborted", "AbortError")));
    drain();
}
function assign(pw, job) {
    if (pw.idleTimer) {
        clearTimeout(pw.idleTimer);
        pw.idleTimer = null;
    }
    pw.job = job;
    pw.lastChatId = job.chatId;
    pw.worker.postMessage({
        type: "assemble",
        requestId: job.requestId,
        ctx: job.ctx,
    });
}
function pickIdleWorker(chatId) {
    // Sticky: prefer the worker already warm for this chat.
    if (chatId) {
        for (const pw of pool) {
            if (!pw.job && pw.lastChatId === chatId)
                return pw;
        }
    }
    for (const pw of pool) {
        if (!pw.job)
            return pw;
    }
    return null;
}
function drain() {
    while (waiting.length > 0) {
        const next = waiting[0];
        let pw = pickIdleWorker(next.chatId);
        if (!pw && pool.length < MAX_WORKERS)
            pw = spawnWorker();
        if (!pw)
            break; // all busy and at capacity — wait for a worker to free up
        waiting.shift();
        assign(pw, next);
    }
}
export function assemblePromptInWorker(ctx) {
    const { signal, prefetched: _prefetched, ...workerCtx } = ctx;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            return;
        }
        const job = {
            requestId: crypto.randomUUID(),
            ctx: workerCtx,
            chatId: workerCtx.chatId ?? null,
            signal,
            resolve,
            reject,
            settled: false,
        };
        if (signal) {
            job.onAbort = () => abortJob(job);
            signal.addEventListener("abort", job.onAbort, { once: true });
        }
        waiting.push(job);
        drain();
    });
}
