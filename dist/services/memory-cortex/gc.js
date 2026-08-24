/**
 * Memory Cortex — Garbage collection and embedding optimization.
 *
 * Solves:
 *   - Redundant re-vectorization on chunk append (debounce)
 *   - Stale vectors from consolidated chunks (compaction)
 *   - Expired query cache entries (cleanup)
 *   - Disk usage visibility for users
 */
import { getDb } from "../../db/connection";
/**
 * Bounded debounce queue. Bulk imports or rapid message replay used to grow
 * this Map without bound between timer firings; a hard cap with FIFO eviction
 * keeps it predictable. The eviction path also fires the queued vectorization
 * immediately so the chunk isn't silently dropped.
 */
const MAX_DIRTY_CHUNKS = 5_000;
const dirtyChunks = new Map();
const pendingExecutors = new Map();
/**
 * Mark a chunk as needing vectorization, but debounce for `delayMs`.
 * If the chunk is mutated again within the delay window, the timer resets.
 * Prevents re-embedding a chunk 3x when 3 messages are appended in succession.
 */
export function debouncedVectorize(userId, chatId, chunkId, queueFn, delayMs = 30_000) {
    const key = chunkId;
    const existing = dirtyChunks.get(key);
    if (existing)
        clearTimeout(existing.timer);
    const fire = () => {
        dirtyChunks.delete(key);
        pendingExecutors.delete(key);
        queueFn(userId, chatId, chunkId, 3);
    };
    pendingExecutors.set(key, fire);
    const timer = setTimeout(fire, delayMs);
    dirtyChunks.set(key, { timer, chatId });
    // Evict-and-flush oldest if we exceed the cap.
    while (dirtyChunks.size > MAX_DIRTY_CHUNKS) {
        const oldest = dirtyChunks.keys().next();
        if (oldest.done)
            break;
        const oldestKey = oldest.value;
        const oldestEntry = dirtyChunks.get(oldestKey);
        if (oldestEntry)
            clearTimeout(oldestEntry.timer);
        const exec = pendingExecutors.get(oldestKey);
        if (exec)
            exec();
        else {
            dirtyChunks.delete(oldestKey);
            pendingExecutors.delete(oldestKey);
        }
    }
}
/** Drop all pending debounced vectorizations for a chat (call on chat delete). */
export function clearDebouncedVectorizationsForChat(chatId) {
    for (const [key, entry] of dirtyChunks) {
        if (entry.chatId === chatId) {
            clearTimeout(entry.timer);
            dirtyChunks.delete(key);
            pendingExecutors.delete(key);
        }
    }
}
/** Flush all pending debounced vectorizations (call on shutdown) */
export function flushDebouncedVectorizations() {
    for (const [, entry] of dirtyChunks) {
        clearTimeout(entry.timer);
    }
    dirtyChunks.clear();
    pendingExecutors.clear();
}
/** Check if a chunk has a pending debounced vectorization */
export function hasPendingVectorization(chunkId) {
    return dirtyChunks.has(chunkId);
}
// ─── Stale Vector Compaction ───────────────────────────────────
/**
 * Remove LanceDB vectors for chunks that have been consolidated.
 * Once a chunk is rolled into a tier-1 consolidation, its individual vector
 * is redundant only after the consolidation itself has been vectorized.
 *
 * @returns Number of vectors removed
 */
export async function compactConsolidatedVectors(userId, chatId, deleteVectorFn) {
    const db = getDb();
    const staleChunks = db
        .query(`SELECT cc.id FROM chat_chunks cc
       JOIN memory_consolidations mc ON mc.id = cc.consolidation_id
       WHERE cc.chat_id = ?
         AND cc.consolidation_id IS NOT NULL
         AND cc.vectorized_at IS NOT NULL
         AND mc.vectorized_at IS NOT NULL`)
        .all(chatId);
    let removed = 0;
    for (const chunk of staleChunks) {
        try {
            await deleteVectorFn(userId, "chat_chunk", chunk.id);
            db.query("UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL WHERE id = ?")
                .run(chunk.id);
            removed++;
        }
        catch {
            // Non-fatal: vector may already be gone
        }
    }
    if (removed > 0) {
        console.info(`[memory-cortex] Compacted ${removed} stale vectors for chat ${chatId}`);
    }
    return removed;
}
// ─── Query Cache Cleanup ───────────────────────────────────────
/** Remove expired entries from the query vector cache. */
export function cleanupQueryCache() {
    const now = Math.floor(Date.now() / 1000);
    const result = getDb()
        .query("DELETE FROM query_vector_cache WHERE expires_at < ?")
        .run(now);
    return result.changes;
}
/**
 * Get usage statistics for a chat's cortex data.
 * Designed to be surfaced in a user-facing stats panel.
 */
export function getCortexUsageStats(chatId) {
    const db = getDb();
    const chunks = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(chatId);
    const vectorized = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ? AND vectorized_at IS NOT NULL").get(chatId);
    const entities = db.query("SELECT COUNT(*) as c FROM memory_entities WHERE chat_id = ?").get(chatId);
    const activeEntities = db.query("SELECT COUNT(*) as c FROM memory_entities WHERE chat_id = ? AND status != 'inactive'").get(chatId);
    const consolidations = db.query("SELECT COUNT(*) as c FROM memory_consolidations WHERE chat_id = ?").get(chatId);
    const salience = db.query("SELECT COUNT(*) as c FROM memory_salience WHERE chat_id = ?").get(chatId);
    const mentions = db.query("SELECT COUNT(*) as c FROM memory_mentions WHERE chat_id = ?").get(chatId);
    const relations = db.query("SELECT COUNT(*) as c FROM memory_relations WHERE chat_id = ?").get(chatId);
    return {
        chunkCount: chunks?.c ?? 0,
        vectorizedChunkCount: vectorized?.c ?? 0,
        entityCount: entities?.c ?? 0,
        activeEntityCount: activeEntities?.c ?? 0,
        consolidationCount: consolidations?.c ?? 0,
        salienceRecordCount: salience?.c ?? 0,
        mentionCount: mentions?.c ?? 0,
        relationCount: relations?.c ?? 0,
        estimatedEmbeddingCalls: (vectorized?.c ?? 0) + Math.floor((chunks?.c ?? 0) * 0.3),
    };
}
// ─── Periodic Maintenance ──────────────────────────────────────
/**
 * Run all maintenance tasks. Called periodically or after bulk operations.
 */
export async function runMaintenance(userId, chatId, deleteVectorFn) {
    const cacheEntriesCleaned = cleanupQueryCache();
    const vectorsCompacted = await compactConsolidatedVectors(userId, chatId, deleteVectorFn);
    return { cacheEntriesCleaned, vectorsCompacted };
}
