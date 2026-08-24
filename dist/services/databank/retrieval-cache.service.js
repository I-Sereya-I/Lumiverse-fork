const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const resultCache = new Map();
function pruneResultCache(now) {
    for (const [key, cached] of resultCache) {
        if (now - cached.cachedAt > CACHE_TTL_MS)
            resultCache.delete(key);
    }
    while (resultCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = resultCache.keys().next().value;
        if (oldestKey === undefined)
            break;
        resultCache.delete(oldestKey);
    }
}
export function databankCacheKey(userId, chatId, databankIds, queryText, limit) {
    return JSON.stringify([userId, chatId, limit, [...databankIds].sort(), queryText]);
}
export function getCachedDatabankResult(userId, chatId, databankIds, queryText, limit) {
    const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
    const cached = resultCache.get(key);
    if (!cached)
        return null;
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
        resultCache.delete(key);
        return null;
    }
    resultCache.delete(key);
    resultCache.set(key, cached);
    return cached.result;
}
export function setCachedDatabankResult(userId, chatId, databankIds, queryText, limit, result) {
    const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
    const now = Date.now();
    resultCache.delete(key);
    pruneResultCache(now);
    resultCache.set(key, {
        result,
        cachedAt: now,
        userId,
        chatId,
        databankIds: [...databankIds],
    });
}
export function clearCache(userId, chatId) {
    for (const [key, cached] of resultCache.entries()) {
        if (cached.userId === userId && cached.chatId === chatId)
            resultCache.delete(key);
    }
}
/** Invalidate every cached query that could contain content from this bank. */
export function invalidateDatabankCache(userId, databankId) {
    for (const [key, cached] of resultCache.entries()) {
        if (cached.userId === userId && cached.databankIds.includes(databankId)) {
            resultCache.delete(key);
        }
    }
}
/** Drop every reconstructable retrieval result. */
export function clearAllDatabankCache() {
    resultCache.clear();
}
/** Test-only alias for keeping module-global cache state isolated. */
export const resetDatabankCacheForTests = clearAllDatabankCache;
