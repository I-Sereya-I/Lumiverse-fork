export const CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS = 15 * 60_000;
export const CHAT_CHUNK_VECTORIZATION_WATCHDOG_GRACE_MS = 30_000;
export const CHAT_CHUNK_VECTORIZATION_FORCE_KILL_GRACE_MS = 5_000;
export const CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_ERROR_NAME = "ChatChunkVectorizationBatchTimeoutError";
export function createChatChunkVectorizationBatchTimeoutError(timeoutMs = CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_MS) {
    const err = new Error(`Chat chunk vectorization batch timed out after ${Math.floor(timeoutMs / 1000)}s`);
    err.name = CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_ERROR_NAME;
    return err;
}
export function isChatChunkVectorizationBatchTimeoutError(err) {
    return err instanceof Error && err.name === CHAT_CHUNK_VECTORIZATION_BATCH_TIMEOUT_ERROR_NAME;
}
