export const IMPACT_WEIGHT = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
};
export function getSlot(slots, id) {
    return slots.find((s) => s.id === id);
}
export function isSlotId(slots, id) {
    return typeof id === "string" && slots.some((s) => s.id === id);
}
export function slotSynthesisGroup(slots, groups, id) {
    return getSlot(slots, id)?.synthesisGroup ?? groups[0].id;
}
export function rankByImpact(slots, ids) {
    return [...ids].sort((a, b) => {
        const wa = IMPACT_WEIGHT[getSlot(slots, a)?.impact ?? "low"];
        const wb = IMPACT_WEIGHT[getSlot(slots, b)?.impact ?? "low"];
        return wb - wa;
    });
}
export function slotParts(slots, id) {
    const slot = getSlot(slots, id);
    if (!slot)
        return [];
    if (slot.parts && slot.parts.length > 0)
        return [...slot.parts];
    return [{ id: slot.id, label: slot.label, fill: slot.fill }];
}
export function slotHasElicit(slots, id) {
    return slotParts(slots, id).some((p) => p.fill === "elicit");
}
export function partFill(slots, slotId, partId) {
    const part = slotParts(slots, slotId).find((p) => p.id === partId);
    return part?.fill ?? slotFill(slots, slotId);
}
export function slotFill(slots, id) {
    if (!getSlot(slots, id))
        return "elicit";
    return slotHasElicit(slots, id) ? "elicit" : "generate";
}
