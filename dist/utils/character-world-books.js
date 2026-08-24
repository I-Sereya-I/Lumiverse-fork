/**
 * Shared helpers for reading/writing the character world book IDs array.
 * Handles backward compat with the legacy single `world_book_id` field.
 */
export function getCharacterWorldBookIds(extensions) {
    if (!extensions)
        return [];
    const ids = extensions.world_book_ids;
    if (Array.isArray(ids))
        return ids.filter((id) => typeof id === "string" && id);
    const single = extensions.world_book_id;
    if (typeof single === "string" && single)
        return [single];
    return [];
}
export function setCharacterWorldBookIds(extensions, ids) {
    const next = { ...extensions, world_book_ids: ids };
    delete next.world_book_id;
    return next;
}
