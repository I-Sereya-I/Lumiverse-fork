import { runHeuristicAnalysis } from "./heuristic-analysis";
self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "run")
        return;
    try {
        const response = {
            type: "result",
            requestId: msg.requestId,
            result: runHeuristicAnalysis(msg.payload),
        };
        self.postMessage(response);
    }
    catch (err) {
        const response = {
            type: "error",
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : "Heuristic worker failed",
        };
        self.postMessage(response);
    }
};
