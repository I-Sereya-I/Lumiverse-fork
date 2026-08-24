import { rankVectorWorldInfoCandidates, } from "./world-info-vector-ranking";
self.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== "rank")
        return;
    try {
        const response = {
            type: "result",
            requestId: message.requestId,
            result: rankVectorWorldInfoCandidates(message.payload),
        };
        self.postMessage(response);
    }
    catch (err) {
        const response = {
            type: "error",
            requestId: message.requestId,
            error: err instanceof Error ? err.message : "Vector WI ranking worker failed",
        };
        self.postMessage(response);
    }
};
