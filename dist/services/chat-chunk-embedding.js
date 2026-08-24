import { createHash } from "node:crypto";
import { chunkDocument } from "./databank/document-chunker.service";
const DEFAULT_SPLIT_TARGET_TOKENS = 220;
const DEFAULT_SPLIT_MAX_TOKENS = 320;
const DEFAULT_SPLIT_MAX_CHARS = 1200;
const DEFAULT_SPLIT_OVERLAP_TOKENS = 0;
const DEFAULT_SPLIT_MIN_CHARS = 160;
function normalizeContent(content) {
    return content.replace(/\r\n/g, "\n").trim();
}
export function estimateChatChunkTokens(content) {
    const normalized = normalizeContent(content);
    if (!normalized)
        return 0;
    return Math.ceil(normalized.length / 4);
}
export function hashChatChunkContent(content) {
    return createHash("sha1").update(normalizeContent(content)).digest("hex");
}
function chooseSplitPoint(text, minChars) {
    if (text.length < minChars * 2)
        return null;
    const midpoint = Math.floor(text.length / 2);
    const window = Math.max(minChars, Math.floor(text.length * 0.2));
    const start = Math.max(minChars, midpoint - window);
    const end = Math.min(text.length - minChars, midpoint + window);
    const region = text.slice(start, end);
    const candidates = [
        /\n\s*\n/g,
        /\n/g,
        /(?<=[.!?])\s+/g,
        /\s+/g,
    ];
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const pattern of candidates) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(region)) !== null) {
            const idx = start + match.index + Math.floor(match[0].length / 2);
            if (idx < minChars || text.length - idx < minChars)
                continue;
            const distance = Math.abs(idx - midpoint);
            if (distance < bestDistance) {
                best = idx;
                bestDistance = distance;
            }
        }
        if (best !== null)
            break;
    }
    if (best !== null)
        return best;
    return midpoint >= minChars && text.length - midpoint >= minChars ? midpoint : null;
}
function bisectContent(text, minChars) {
    const splitPoint = chooseSplitPoint(text, minChars);
    if (splitPoint == null)
        return [text];
    const left = normalizeContent(text.slice(0, splitPoint));
    const right = normalizeContent(text.slice(splitPoint));
    const parts = [left, right].filter((part) => part.length > 0);
    return parts.length >= 2 ? parts : [text];
}
export function splitChatChunkContent(content, options) {
    const normalized = normalizeContent(content);
    if (!normalized)
        return [];
    const targetTokens = Math.max(32, options?.targetTokens ?? DEFAULT_SPLIT_TARGET_TOKENS);
    const maxTokens = Math.max(targetTokens, options?.maxTokens ?? DEFAULT_SPLIT_MAX_TOKENS);
    const maxChars = Math.max(256, options?.maxChars ?? DEFAULT_SPLIT_MAX_CHARS);
    const overlapTokens = Math.max(0, options?.overlapTokens ?? DEFAULT_SPLIT_OVERLAP_TOKENS);
    const minChars = Math.max(64, options?.minChars ?? DEFAULT_SPLIT_MIN_CHARS);
    const estimatedTokens = estimateChatChunkTokens(normalized);
    const shouldSplit = options?.forceSplit
        ? normalized.length >= minChars * 2
        : estimatedTokens > maxTokens || normalized.length > maxChars;
    if (!shouldSplit)
        return [normalized];
    const chunked = chunkDocument(normalized, {
        targetTokens,
        maxTokens,
        overlapTokens,
    });
    let parts = chunked
        .map((chunk) => normalizeContent(chunk.content))
        .filter((part) => part.length > 0);
    if (parts.length <= 1 || (parts.length === 1 && parts[0] === normalized)) {
        parts = bisectContent(normalized, minChars);
    }
    if (parts.length <= 1 || (parts.length === 1 && parts[0] === normalized)) {
        return [normalized];
    }
    const out = [];
    for (const part of parts) {
        const estimated = estimateChatChunkTokens(part);
        if (estimated > maxTokens || part.length > maxChars) {
            const nested = splitChatChunkContent(part, {
                targetTokens,
                maxTokens,
                maxChars,
                overlapTokens,
                minChars,
            });
            if (nested.length > 1 || nested[0] !== part) {
                out.push(...nested);
                continue;
            }
        }
        out.push(part);
    }
    return out;
}
export function buildChatChunkEmbeddingSlices(content, metadata, options) {
    const normalized = normalizeContent(content);
    if (!normalized)
        return [];
    const sourceTokenCount = Math.max(0, options?.sourceTokenCount ?? estimateChatChunkTokens(normalized));
    const sourceContentHash = hashChatChunkContent(normalized);
    const parts = splitChatChunkContent(normalized, options);
    const chunkCount = parts.length;
    return parts.map((part, chunkIndex) => ({
        chunkIndex,
        chunkCount,
        content: part,
        searchText: part,
        estimatedTokens: estimateChatChunkTokens(part),
        metadata: {
            ...(metadata || {}),
            autoSplit: chunkCount > 1,
            splitIndex: chunkIndex,
            splitCount: chunkCount,
            sourceCharCount: normalized.length,
            sourceTokenCount,
            sourceContentHash,
        },
    }));
}
function sortValue(value) {
    return value == null ? Number.NEGATIVE_INFINITY : value;
}
export function collapseVectorHitsBySourceId(hits) {
    const merged = new Map();
    for (const hit of hits) {
        const key = String(hit.source_id);
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, { ...hit });
            continue;
        }
        const existingSimilarity = sortValue(existing.similarity);
        const hitSimilarity = sortValue(hit.similarity);
        const existingLexical = sortValue(existing.lexicalScore);
        const hitLexical = sortValue(hit.lexicalScore);
        const shouldReplace = hitSimilarity > existingSimilarity ||
            (hitSimilarity === existingSimilarity && hitLexical > existingLexical);
        if (shouldReplace) {
            merged.set(key, {
                ...hit,
                lexicalScore: hitLexical >= existingLexical ? hit.lexicalScore : existing.lexicalScore,
                vector: hit.vector ?? existing.vector,
                content: hit.content || existing.content,
                metadata_json: hit.metadata_json || existing.metadata_json,
            });
            continue;
        }
        existing.lexicalScore = hitLexical > existingLexical ? hit.lexicalScore : existing.lexicalScore;
        if ((!existing.content || existing.content.length === 0) && hit.content) {
            existing.content = hit.content;
        }
        if ((!existing.metadata_json || existing.metadata_json.length === 0) && hit.metadata_json) {
            existing.metadata_json = hit.metadata_json;
        }
        if (existing.vector == null && hit.vector != null) {
            existing.vector = hit.vector;
        }
    }
    return Array.from(merged.values());
}
