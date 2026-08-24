import { parseWebPage, WebPageParseError, } from "./web-page-parser";
self.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== "parse")
        return;
    try {
        const result = parseWebPage(message.html, message.url);
        postMessage({
            type: "result",
            requestId: message.requestId,
            result,
        });
    }
    catch (err) {
        postMessage({
            type: "error",
            requestId: message.requestId,
            error: err instanceof Error ? err.message : "Failed to parse page content",
            code: err instanceof WebPageParseError ? err.code : "parse_error",
        });
    }
};
