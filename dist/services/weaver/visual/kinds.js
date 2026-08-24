import { EXPRESSION_VARIANTS } from "./expressions";
export const VISUAL_KINDS = [
    { id: "portrait", width: 832, height: 1216, aspect_ratio: "2:3", base_negative: "" },
    {
        id: "expressions",
        width: 832,
        height: 1216,
        aspect_ratio: "2:3",
        base_negative: "",
        variants: EXPRESSION_VARIANTS,
    },
    { id: "scenes", width: 1216, height: 832, aspect_ratio: "3:2", base_negative: "" },
    { id: "alternates", width: 832, height: 1216, aspect_ratio: "2:3", base_negative: "" },
];
const VISUAL_KIND_MAP = new Map(VISUAL_KINDS.map((kind) => [kind.id, kind]));
export function getVisualKind(id) {
    return VISUAL_KIND_MAP.get(id);
}
export function isVisualKind(id) {
    return VISUAL_KIND_MAP.has(id);
}
export function listVisualKinds() {
    return VISUAL_KINDS;
}
export function visualCandidateOwner(kind, variant) {
    const base = `weaver:visual:${kind}`;
    const v = variant?.trim().toLowerCase();
    return v ? `${base}:${v}` : base;
}
