import { getDb } from "../db/connection";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../types/pagination";
const stmtCache = new Map();
let stmtCacheGen = -1;
function cachedQuery(sql) {
    const gen = require("../db/connection").getDbGeneration();
    if (gen !== stmtCacheGen) {
        stmtCache.clear();
        stmtCacheGen = gen;
    }
    let stmt = stmtCache.get(sql);
    if (!stmt) {
        stmt = getDb().query(sql);
        stmtCache.set(sql, stmt);
    }
    return stmt;
}
export function clearStmtCache() {
    stmtCache.clear();
}
export function parsePagination(rawLimit, rawOffset, defaultLimit = DEFAULT_LIMIT) {
    let limit = defaultLimit;
    if (rawLimit !== undefined) {
        const parsed = parseInt(rawLimit, 10);
        if (!isNaN(parsed))
            limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);
    }
    let offset = 0;
    if (rawOffset !== undefined) {
        const parsed = parseInt(rawOffset, 10);
        if (!isNaN(parsed) && parsed >= 0)
            offset = parsed;
    }
    return { limit, offset };
}
export function paginatedQuery(dataSql, countSql, params, pagination, rowMapper) {
    // Fetch one extra row to detect if there are more results (avoids COUNT query when possible)
    const rows = cachedQuery(`${dataSql} LIMIT ? OFFSET ?`)
        .all(...params, pagination.limit + 1, pagination.offset);
    const hasMore = rows.length > pagination.limit;
    if (hasMore)
        rows.length = pagination.limit; // trim the extra probe row
    // Only run the COUNT query if we actually need the exact total
    // (i.e., we're not on page 1 fetching everything, or there are more pages)
    let total;
    if (pagination.offset === 0 && !hasMore) {
        // First page and all results fit — total is just the row count
        total = rows.length;
    }
    else {
        const countRow = cachedQuery(countSql).get(...params);
        total = countRow?.count ?? 0;
    }
    return {
        data: rows.map(rowMapper),
        total,
        limit: pagination.limit,
        offset: pagination.offset,
    };
}
/**
 * Collect a paginated list to exhaustion by walking offset-forward pages.
 *
 * Consumers that treat a list as complete (e.g. the bootstrap payload, which
 * the client hydrates its stores from) must page past the MAX_LIMIT row cap —
 * a truncated first page silently hides entries.
 *
 * A first-page failure is rethrown for the caller's fallback; once pages are
 * in hand, a later failure keeps the already-collected rows instead of
 * discarding them.
 */
export function collectAll(fetchPage, pageSize = 200) {
    const data = [];
    let offset = 0;
    for (;;) {
        let page;
        try {
            page = fetchPage({ limit: pageSize, offset });
        }
        catch (err) {
            if (data.length === 0)
                throw err;
            console.warn(`[pagination] page fetch failed at offset ${offset}; returning ${data.length} already collected`, err);
            break;
        }
        data.push(...page.data);
        offset += page.data.length;
        if (page.data.length === 0 || offset >= page.total)
            break;
    }
    return { data, total: data.length, limit: data.length, offset: 0 };
}
