import { runRegexRequest } from "./regex-sandbox-core";
/**
 * Worker-side regex evaluator. Runs untrusted patterns inside a Bun Worker so
 * a catastrophic-backtracking pattern blocks ONLY the worker's thread, not the
 * main HTTP/event loop. The parent process kills and respawns this worker if
 * an evaluation exceeds its timeout.
 *
 * Protocol:
 *   in:  { id, op: "replace" | "test" | "collect" | "capture-replacements",
 *          pattern, flags, input, replacement? }
 *   out: { id, ok: true, result } | { id, ok: false, error }
 */
// `self` is a global inside Bun Workers. We narrow its type here without
// re-declaring it (which would conflict with lib.dom).
const workerSelf = self;
workerSelf.addEventListener("message", (event) => {
    const data = event.data;
    try {
        workerSelf.postMessage({ id: data.id, ok: true, result: runRegexRequest(data) });
    }
    catch (err) {
        workerSelf.postMessage({
            id: data.id,
            ok: false,
            error: err instanceof Error ? err.message : "Regex evaluation failed",
        });
    }
});
