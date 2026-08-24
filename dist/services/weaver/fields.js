export function getField(defs, id) {
    return defs.find((f) => f.id === id);
}
export function isFieldId(defs, id) {
    return typeof id === "string" && defs.some((f) => f.id === id);
}
export function rankByOrder(defs) {
    return [...defs].sort((a, b) => a.order - b.order);
}
