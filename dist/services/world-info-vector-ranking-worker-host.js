import { rankVectorWorldInfoCandidates, } from "./world-info-vector-ranking";
import { shouldUseBunWorkers, warnBunWorkerFallback, } from "../utils/bun-worker-guard";
export function rankVectorWorldInfoCandidatesInWorker(payload, signal) {
    if (!shouldUseBunWorkers()) {
        warnBunWorkerFallback("world-info vector ranking");
        return Promise.resolve(rankVectorWorldInfoCandidates(payload));
    }
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            return;
        }
        const requestId = crypto.randomUUID();
        const worker = new Worker(new URL("./world-info-vector-ranking-worker.ts", import.meta.url).href, { type: "module" });
        let settled = false;
        const cleanup = () => {
            signal?.removeEventListener("abort", onAbort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
        };
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            fn();
        };
        const onAbort = () => {
            settle(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.onmessage = (event) => {
            const message = event.data;
            if (!message || message.requestId !== requestId)
                return;
            if (message.type === "result") {
                settle(() => resolve(message.result));
            }
            else {
                settle(() => reject(new Error(message.error)));
            }
        };
        worker.onerror = (event) => {
            settle(() => reject(new Error(event.message || "Vector WI ranking worker failed")));
        };
        worker.postMessage({
            type: "rank",
            requestId,
            payload,
        });
    });
}
