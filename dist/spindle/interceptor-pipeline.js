import { DEFAULT_INTERCEPTOR_TIMEOUT_MS } from "../services/spindle-settings.service";
import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";
import { collectSourceMessageMetadata, restoreSourceMessageMetadata, } from "./source-message-metadata";
function getChatId(context) {
    if (!context || typeof context !== "object")
        return null;
    const chatId = context.chatId;
    return typeof chatId === "string" && chatId ? chatId : null;
}
function matchesInterceptorContext(match, context) {
    if (!match)
        return true;
    if (!context || typeof context !== "object")
        return false;
    const value = context;
    if (match.generationTypes?.length) {
        if (typeof value.generationType !== "string" || !match.generationTypes.includes(value.generationType)) {
            return false;
        }
    }
    if (match.isDryRun !== undefined && value.isDryRun !== match.isDryRun)
        return false;
    const presetField = match.presetField;
    if (!presetField)
        return true;
    let field = value.presetMetadata;
    for (const key of presetField.path) {
        if (!field || typeof field !== "object" || Array.isArray(field)) {
            field = undefined;
            break;
        }
        field = field[key];
    }
    if (presetField.exists !== undefined && (field !== undefined) !== presetField.exists)
        return false;
    if (presetField.oneOf && !presetField.oneOf.some((candidate) => Object.is(candidate, field)))
        return false;
    if (presetField.notIn?.some((candidate) => Object.is(candidate, field)))
        return false;
    return true;
}
class InterceptorPipeline {
    interceptors = [];
    register(interceptor) {
        this.interceptors.push(interceptor);
        this.interceptors.sort((a, b) => a.priority - b.priority);
        return () => {
            const idx = this.interceptors.indexOf(interceptor);
            if (idx !== -1)
                this.interceptors.splice(idx, 1);
        };
    }
    unregisterByExtension(extensionId) {
        this.interceptors = this.interceptors.filter((i) => i.extensionId !== extensionId);
    }
    async run(messages, context, userId, signal) {
        let result = messages;
        const sourceMessageMetadata = collectSourceMessageMetadata(messages);
        let mergedParameters;
        const mergedBreakdown = [];
        const chatId = getChatId(context);
        for (const interceptor of this.interceptors) {
            if (interceptor.userId && interceptor.userId !== userId) {
                continue;
            }
            if (!matchesInterceptorContext(interceptor.match, context)) {
                continue;
            }
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            let timeoutMs = DEFAULT_INTERCEPTOR_TIMEOUT_MS;
            if (interceptor.resolveTimeoutMs) {
                try {
                    const resolved = interceptor.resolveTimeoutMs();
                    if (Number.isFinite(resolved) && resolved > 0)
                        timeoutMs = resolved;
                }
                catch (err) {
                    console.warn(`[Spindle] Interceptor timeout resolver threw for ${interceptor.extensionId}:`, err);
                }
            }
            emitSpindlePreGenerationActivity({
                chatId,
                userId,
                phase: "interceptor",
                status: "started",
                extensionId: interceptor.extensionId,
                extensionName: interceptor.extensionName,
            });
            let timeout;
            let abortHandler;
            try {
                restoreSourceMessageMetadata(result, sourceMessageMetadata);
                const output = await Promise.race([
                    interceptor.handler(result, context),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error(`Interceptor from ${interceptor.extensionId} timed out (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
                        if (signal) {
                            abortHandler = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                            signal.addEventListener("abort", abortHandler, { once: true });
                        }
                    }),
                ]);
                result = output.messages;
                emitSpindlePreGenerationActivity({
                    chatId,
                    userId,
                    phase: "interceptor",
                    status: "completed",
                    extensionId: interceptor.extensionId,
                    extensionName: interceptor.extensionName,
                });
                if (output.parameters && Object.keys(output.parameters).length > 0) {
                    mergedParameters = { ...mergedParameters, ...output.parameters };
                }
                if (output.breakdown && output.breakdown.length > 0) {
                    mergedBreakdown.push(...output.breakdown);
                }
            }
            catch (err) {
                if (signal?.aborted) {
                    emitSpindlePreGenerationActivity({
                        chatId,
                        userId,
                        phase: "interceptor",
                        status: "aborted",
                        extensionId: interceptor.extensionId,
                        extensionName: interceptor.extensionName,
                    });
                    throw err;
                }
                emitSpindlePreGenerationActivity({
                    chatId,
                    userId,
                    phase: "interceptor",
                    status: "error",
                    extensionId: interceptor.extensionId,
                    extensionName: interceptor.extensionName,
                    error: err instanceof Error ? err.message : String(err),
                });
                console.error(`[Spindle] Interceptor error from ${interceptor.extensionId}:`, err);
                // Continue with previous result on error
            }
            finally {
                if (timeout)
                    clearTimeout(timeout);
                if (signal && abortHandler) {
                    signal.removeEventListener("abort", abortHandler);
                }
            }
        }
        return {
            messages: result,
            parameters: mergedParameters,
            ...(mergedBreakdown.length > 0 ? { breakdown: mergedBreakdown } : {}),
        };
    }
    get count() {
        return this.interceptors.length;
    }
}
export const interceptorPipeline = new InterceptorPipeline();
