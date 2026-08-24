/**
 * Shared helpers for reading/writing the character databank IDs array.
 * Mirrors the character-world-books.ts pattern.
 */
export function getCharacterDatabankIds(extensions) {
    if (!extensions)
        return [];
    const ids = extensions.databank_ids;
    if (Array.isArray(ids))
        return ids.filter((id) => typeof id === "string" && id);
    return [];
}
export function setCharacterDatabankIds(extensions, ids) {
    return { ...extensions, databank_ids: ids };
}
