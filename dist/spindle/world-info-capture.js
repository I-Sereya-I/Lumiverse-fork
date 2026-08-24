export const INTERNAL_WORLD_INFO_CAPTURES_KEY = "__spindleWorldInfoCaptures";
export function buildWorldInfoCaptureMap(requests, activated) {
    const result = {};
    for (const [extensionId, ids] of requests) {
        result[extensionId] = activated.filter((entry) => ids.has(entry.id));
    }
    return result;
}
function toCaptureDTO(entry) {
    const dto = {
        id: entry.id,
        comment: entry.comment,
        keys: entry.keys,
        source: entry.source,
    };
    if (entry.score !== undefined)
        dto.score = entry.score;
    if (entry.bookId !== undefined)
        dto.bookId = entry.bookId;
    if (entry.bookSource === "peer")
        dto.bookSource = "persona";
    else if (entry.bookSource !== undefined)
        dto.bookSource = entry.bookSource;
    return dto;
}
export function projectWorldInfoCaptureContext(context, extensionId) {
    const projected = context && typeof context === "object"
        ? { ...context }
        : {};
    const rawCaptures = projected[INTERNAL_WORLD_INFO_CAPTURES_KEY];
    delete projected[INTERNAL_WORLD_INFO_CAPTURES_KEY];
    delete projected.capturedWorldInfo;
    if (Array.isArray(projected.activatedWorldInfo)) {
        projected.activatedWorldInfo = projected.activatedWorldInfo
            .filter((entry) => !!entry &&
            typeof entry === "object" &&
            typeof entry.id === "string")
            .map(toCaptureDTO);
    }
    if (!rawCaptures ||
        typeof rawCaptures !== "object" ||
        !Object.prototype.hasOwnProperty.call(rawCaptures, extensionId)) {
        return projected;
    }
    const entries = rawCaptures[extensionId];
    projected.capturedWorldInfo = Array.isArray(entries)
        ? entries
            .filter((entry) => !!entry &&
            typeof entry === "object" &&
            typeof entry.id === "string")
            .map(toCaptureDTO)
        : [];
    return projected;
}
