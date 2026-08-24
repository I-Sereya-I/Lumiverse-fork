/**
 * Databank Mention Resolver — Resolves #document-name references in chat history.
 *
 * Refactored to a batch-oriented API so prompt assembly can:
 *   1. Extract slugs from every user message (pure regex)
 *   2. Look up the union of slugs once (single sync pass — no duplicate DB hits)
 *   3. Strip resolved #mentions from every message in history (pure string ops)
 *   4. Run the expensive content fetch + vector search ONLY for the last user
 *      message's slugs (the only ones that contribute to the appendix)
 *
 * Heavy resolution results are cached for 5 minutes keyed by
 * (userId, chatId, sortedSlugs, queryContext) so regens/swipes that re-trigger
 * assembly with the same trailing context hit the cache instead of re-embedding.
 */
import * as crud from "./databank-crud.service";
import * as embeddingsSvc from "../embeddings.service";
import { resolveActiveDatabankIds } from "./scope-resolver.service";
/** Regex matching #slug in user messages. Slug = lowercase alphanumeric + hyphens. */
const MENTION_PATTERN = /(?:^|\s)#([a-z0-9][a-z0-9-]*)/gi;
/** Max tokens for direct document injection. Above this, use vector search. */
const DIRECT_INJECT_TOKEN_BUDGET = 2000;
/** Approximate token count for budget check. */
function approxTokens(text) {
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.33);
}
// ─── Extraction & Stripping (pure) ────────────────────────────
/** Pull every unique #slug out of a single message. Pure regex, no I/O. */
export function extractMentionSlugs(content) {
    const slugs = new Set();
    if (!content.includes("#"))
        return slugs;
    const regex = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
        slugs.add(match[1].toLowerCase());
    }
    return slugs;
}
/**
 * Remove `#slug` tokens (only those in `validSlugs`) from a message, preserving
 * the leading whitespace/start-of-string anchor. Collapses double spaces.
 */
export function stripMentions(content, validSlugs) {
    if (validSlugs.size === 0 || !content.includes("#"))
        return content;
    let out = content;
    for (const slug of validSlugs) {
        out = out.replace(new RegExp(`(^|\\s)#${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "$1");
    }
    return out.replace(/\s{2,}/g, " ").trim();
}
/**
 * Sync batch lookup: for a deduped set of slugs, return the subset that maps
 * to ready documents in active databanks (plus the doc rows themselves).
 * One indexed SQL query per unique slug — cheap enough to call unconditionally.
 */
export function lookupSlugsInScope(userId, slugs, chatId, characterIds) {
    const validSlugs = new Set();
    const docs = new Map();
    const slugArr = Array.from(slugs);
    if (slugArr.length === 0)
        return { validSlugs, docs };
    const activeBankIds = resolveActiveDatabankIds(userId, chatId, characterIds);
    if (activeBankIds.length === 0)
        return { validSlugs, docs };
    const activeBankSet = new Set(activeBankIds);
    for (const slug of slugArr) {
        const doc = crud.getDocumentBySlug(userId, slug);
        if (!doc)
            continue;
        if (!activeBankSet.has(doc.databankId))
            continue;
        validSlugs.add(slug);
        docs.set(slug, doc);
    }
    return { validSlugs, docs };
}
// ─── Heavy Resolution (async, cached) ─────────────────────────
const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 256;
const resolveCache = new Map();
function resolveCacheKey(userId, chatId, slugs, queryContext) {
    const sorted = Array.from(slugs).sort().join(",");
    return `${userId}:${chatId}:${Bun.hash(sorted).toString(36)}:${Bun.hash(queryContext).toString(36)}`;
}
/** Drop cached resolutions for a user+chat (e.g. after a doc update). */
export function clearResolveCache(userId, chatId) {
    const prefix = `${userId}:${chatId}:`;
    for (const key of resolveCache.keys()) {
        if (key.startsWith(prefix))
            resolveCache.delete(key);
    }
}
/** Drop all reconstructable mention resolutions. */
export function clearAllResolveCache() {
    resolveCache.clear();
}
function cacheResolvedMentions(key, result, now) {
    for (const [cachedKey, cached] of resolveCache) {
        if (now - cached.cachedAt > RESOLVE_CACHE_TTL_MS)
            resolveCache.delete(cachedKey);
    }
    resolveCache.delete(key);
    while (resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
        const oldest = resolveCache.keys().next().value;
        if (oldest === undefined)
            break;
        resolveCache.delete(oldest);
    }
    resolveCache.set(key, { result, cachedAt: now });
}
export const __mentionResolveCacheTest = {
    clear: clearAllResolveCache,
    keys: () => [...resolveCache.keys()],
    set: (key, result, cachedAt = Date.now()) => {
        cacheResolvedMentions(key, result, cachedAt);
    },
    size: () => resolveCache.size,
};
/**
 * Resolve a set of slugs to their injectable content.
 *  - Small docs (≤ DIRECT_INJECT_TOKEN_BUDGET): full text inline.
 *  - Large docs: a single vector search against the slug's databank, filtered
 *    to the document's chunks; falls back to the first ~3000 chars if no
 *    chunks return.
 *
 * Cached for 5 min by (userId, chatId, slug-set, queryContext) so regens/swipes
 * skip the embedding + LanceDB round trip when nothing material has changed.
 */
export async function resolveSlugContent(userId, chatId, slugs, docs, queryContext, signal) {
    const slugArr = Array.from(slugs).filter((s) => docs.has(s));
    if (slugArr.length === 0)
        return [];
    const key = resolveCacheKey(userId, chatId, slugArr, queryContext);
    const cached = resolveCache.get(key);
    if (cached && Date.now() - cached.cachedAt <= RESOLVE_CACHE_TTL_MS) {
        resolveCache.delete(key);
        resolveCache.set(key, cached);
        return cached.result;
    }
    if (cached)
        resolveCache.delete(key);
    const resolved = [];
    // Embedded lazily on the first large-doc miss, then reused for the rest of
    // the batch — every large-doc search in a single call uses the same
    // queryContext, so we only need one embedding round trip.
    let queryVector = null;
    for (const slug of slugArr) {
        if (signal?.aborted)
            break;
        const doc = docs.get(slug);
        const fullText = crud.getFullDocumentText(userId, doc.id);
        if (!fullText)
            continue;
        let content;
        let truncated = false;
        if (approxTokens(fullText) <= DIRECT_INJECT_TOKEN_BUDGET) {
            content = fullText;
        }
        else {
            truncated = true;
            try {
                if (!queryVector) {
                    const [v] = await embeddingsSvc.cachedEmbedTexts(userId, [queryContext], { signal, inputType: "query" });
                    if (signal?.aborted)
                        break;
                    queryVector = v;
                }
                const results = await embeddingsSvc.searchDatabankChunks(userId, [doc.databankId], queryVector, 4, queryContext, signal);
                const docResults = results.filter((r) => {
                    try {
                        const meta = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
                        return meta?.documentId === doc.id;
                    }
                    catch {
                        return false;
                    }
                });
                content = docResults.length > 0
                    ? docResults.map((r) => r.content).join("\n---\n")
                    : fullText.slice(0, 3000);
            }
            catch {
                content = fullText.slice(0, 3000);
            }
        }
        resolved.push({
            slug,
            documentName: doc.name,
            content,
            truncated,
        });
    }
    if (!signal?.aborted) {
        cacheResolvedMentions(key, resolved, Date.now());
    }
    return resolved;
}
// ─── Formatting ───────────────────────────────────────────────
/**
 * Format resolved mentions as an appendix to the user message.
 * Returns a single string to be appended after the user's text with clear separation.
 */
export function formatMentionsAsAppendix(mentions) {
    if (mentions.length === 0)
        return "";
    const docs = mentions.map((m) => {
        const truncNote = m.truncated ? " (most relevant excerpts)" : "";
        return `## ${m.documentName}${truncNote}\n${m.content}`;
    });
    return [
        "",
        "---",
        "",
        "# Additional Context",
        "The user has attached the following reference material for you to consider when responding.",
        "",
        docs.join("\n\n---\n\n"),
    ].join("\n");
}
