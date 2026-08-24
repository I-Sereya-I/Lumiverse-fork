import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";
function getChatId(value) {
    if (!value || typeof value !== "object")
        return null;
    const chatId = value.chatId;
    return typeof chatId === "string" && chatId ? chatId : null;
}
class ContextHandlerChain {
    handlers = [];
    register(handler) {
        this.handlers.push(handler);
        this.handlers.sort((a, b) => a.priority - b.priority);
        return () => {
            const idx = this.handlers.indexOf(handler);
            if (idx !== -1)
                this.handlers.splice(idx, 1);
        };
    }
    unregisterByExtension(extensionId) {
        this.handlers = this.handlers.filter((h) => h.extensionId !== extensionId);
    }
    async run(context, userId, signal) {
        let result = context;
        for (const handler of this.handlers) {
            if (handler.userId && handler.userId !== userId) {
                continue;
            }
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            const chatId = getChatId(result);
            emitSpindlePreGenerationActivity({
                chatId,
                userId,
                phase: "context_handler",
                status: "started",
                extensionId: handler.extensionId,
                extensionName: handler.extensionName,
            });
            const timeoutMs = handler.timeoutMs ?? 10_000;
            let timeout;
            let abortHandler;
            try {
                result = await Promise.race([
                    handler.handler(result),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error(`Context handler from ${handler.extensionId} timed out (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
                        if (signal) {
                            abortHandler = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                            signal.addEventListener("abort", abortHandler, { once: true });
                        }
                    }),
                ]);
                emitSpindlePreGenerationActivity({
                    chatId,
                    userId,
                    phase: "context_handler",
                    status: "completed",
                    extensionId: handler.extensionId,
                    extensionName: handler.extensionName,
                });
            }
            catch (err) {
                if (signal?.aborted) {
                    emitSpindlePreGenerationActivity({
                        chatId,
                        userId,
                        phase: "context_handler",
                        status: "aborted",
                        extensionId: handler.extensionId,
                        extensionName: handler.extensionName,
                    });
                    throw err;
                }
                emitSpindlePreGenerationActivity({
                    chatId,
                    userId,
                    phase: "context_handler",
                    status: "error",
                    extensionId: handler.extensionId,
                    extensionName: handler.extensionName,
                    error: err instanceof Error ? err.message : String(err),
                });
                console.error(`[Spindle] Context handler error from ${handler.extensionId}:`, err);
            }
            finally {
                if (timeout)
                    clearTimeout(timeout);
                if (signal && abortHandler) {
                    signal.removeEventListener("abort", abortHandler);
                }
            }
        }
        return result;
    }
    get count() {
        return this.handlers.length;
    }
}
export const contextHandlerChain = new ContextHandlerChain();
