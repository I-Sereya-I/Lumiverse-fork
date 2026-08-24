export const ENTITY_FILTER_TYPES = [
    "character",
    "location",
    "item",
    "faction",
    "concept",
    "event",
];
function createEmptyFilterConfig() {
    return {
        protectedTerms: [],
        rejectedTerms: [],
        cleanupPatterns: [],
    };
}
export function getDefaultEntityExtractionFilters() {
    return {
        character: createEmptyFilterConfig(),
        location: createEmptyFilterConfig(),
        item: createEmptyFilterConfig(),
        faction: createEmptyFilterConfig(),
        concept: createEmptyFilterConfig(),
        event: createEmptyFilterConfig(),
    };
}
function normalizeStringArray(value) {
    if (!Array.isArray(value))
        return [];
    const normalized = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const trimmed = item.trim();
        if (!trimmed)
            continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        normalized.push(trimmed);
    }
    return normalized;
}
export function normalizeEntityExtractionFilters(input) {
    const defaults = getDefaultEntityExtractionFilters();
    if (!input || typeof input !== "object" || Array.isArray(input))
        return defaults;
    const record = input;
    const normalized = {};
    for (const type of ENTITY_FILTER_TYPES) {
        const value = record[type];
        normalized[type] = {
            protectedTerms: normalizeStringArray(value?.protectedTerms),
            rejectedTerms: normalizeStringArray(value?.rejectedTerms),
            cleanupPatterns: normalizeStringArray(value?.cleanupPatterns),
        };
    }
    return normalized;
}
const regexCache = new Map();
function parseRegexString(value) {
    if (regexCache.has(value))
        return regexCache.get(value) ?? null;
    let parsed = null;
    const match = value.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    if (match) {
        try {
            parsed = new RegExp(match[1], match[2]);
        }
        catch {
            parsed = null;
        }
    }
    regexCache.set(value, parsed);
    return parsed;
}
export function matchesFilterTerm(text, term) {
    if (!text || !term)
        return false;
    const parsed = parseRegexString(term);
    if (parsed)
        return parsed.test(text);
    return text.toLowerCase().includes(term.toLowerCase());
}
function matchesAnyTerm(text, terms) {
    if (!text || terms.length === 0)
        return false;
    return terms.some((term) => matchesFilterTerm(text, term));
}
export function applyCleanupPatterns(text, patterns) {
    let cleaned = text;
    for (const pattern of patterns) {
        const parsed = parseRegexString(pattern);
        if (parsed) {
            cleaned = cleaned.replace(parsed, "");
        }
        else {
            cleaned = cleaned.split(pattern).join("");
        }
    }
    return cleaned;
}
function normalizeProtectedCandidate(text) {
    return text
        .replace(/[\r\n]+/g, " ")
        .replace(/^[\s\[\]{}()|,:;.-]+/, "")
        .replace(/[\s\[\]{}()|,:;.-]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
}
function isPlausibleProtectedCandidate(text) {
    if (text.length < 2 || text.length > 120)
        return false;
    if (!/[A-Za-z0-9]/.test(text))
        return false;
    if (text.split(/\s+/).length > 16)
        return false;
    return true;
}
export function buildProtectedLineEntities(content, filters) {
    const found = new Map();
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line)
            continue;
        for (const type of ENTITY_FILTER_TYPES) {
            const rule = filters[type];
            if (rule.protectedTerms.length === 0)
                continue;
            if (!matchesAnyTerm(line, rule.protectedTerms))
                continue;
            if (matchesAnyTerm(line, rule.rejectedTerms))
                continue;
            const cleaned = normalizeProtectedCandidate(applyCleanupPatterns(line, rule.cleanupPatterns));
            if (!isPlausibleProtectedCandidate(cleaned))
                continue;
            const key = `${type}:${cleaned.toLowerCase()}`;
            if (found.has(key))
                continue;
            found.set(key, {
                name: cleaned,
                type,
                aliases: [],
                confidence: 0.95,
                mentionRole: "present",
                sourceLine: line,
            });
        }
    }
    return [...found.values()];
}
function findSourceLine(content, entityName) {
    const lowered = entityName.toLowerCase();
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (line.toLowerCase().includes(lowered))
            return line;
    }
    return null;
}
export function filterEntitiesByExtractionFilters(entities, content, filters, protectedLineEntities = buildProtectedLineEntities(content, filters)) {
    const protectedNamesByLine = new Map();
    for (const entity of protectedLineEntities) {
        const key = entity.sourceLine;
        if (!protectedNamesByLine.has(key))
            protectedNamesByLine.set(key, new Set());
        protectedNamesByLine.get(key).add(entity.name.toLowerCase());
    }
    const filtered = [];
    const seen = new Set();
    for (const entity of entities) {
        const sourceLine = findSourceLine(content, entity.name);
        if (sourceLine) {
            const protectedNames = protectedNamesByLine.get(sourceLine);
            if (protectedNames && !protectedNames.has(entity.name.toLowerCase()))
                continue;
        }
        const rule = filters[entity.type];
        if (matchesAnyTerm(entity.name, rule.rejectedTerms))
            continue;
        if (sourceLine && matchesAnyTerm(sourceLine, rule.rejectedTerms))
            continue;
        const key = `${entity.type}:${entity.name.toLowerCase()}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        filtered.push(entity);
    }
    return filtered;
}
