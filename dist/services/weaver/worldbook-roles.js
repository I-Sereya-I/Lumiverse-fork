export const DEPTH_ROLE_ID = "depth";
export const LORE_ROLE_ID = "lore";
export const NPC_ROLE_ID = "npc";
export const GOVERNANCE_ROLE_ID = "governance";
const DEPTH_ROLE = {
    id: DEPTH_ROLE_ID,
    label: "Depth book",
    triggering: "meaning",
    defaultEnabled: false,
    bookName: (subjectName) => `${subjectName} depth book`,
    bookDescription: (subjectName) => `Deepening answers from the Weaver interview for ${subjectName}. Entries surface on relevance instead of sitting on the card.`,
};
const LORE_ROLE = {
    id: LORE_ROLE_ID,
    label: "Lore book",
    triggering: "meaning",
    defaultEnabled: true,
    bookName: (subjectName) => `${subjectName} lore book`,
    bookDescription: (subjectName) => `The deep lore of ${subjectName}. Entries surface on relevance so the narrator consults canon instead of inventing it.`,
};
const NPC_ROLE = {
    id: NPC_ROLE_ID,
    label: "NPC book",
    triggering: "name",
    defaultEnabled: true,
    bookName: (subjectName) => `${subjectName} NPC book`,
    bookDescription: (subjectName) => `The people of ${subjectName}. Entries trigger by name so the narrator can voice them on cue.`,
};
const GOVERNANCE_ROLE = {
    id: GOVERNANCE_ROLE_ID,
    label: "Rules book",
    triggering: "always",
    defaultEnabled: true,
    bookName: (subjectName) => `${subjectName} rules book`,
    bookDescription: (subjectName) => `How ${subjectName} stays itself in any chat: its anchor line and the always-on rules it plays by. Managed by the Weaver; travels with the card on export.`,
};
export const WORLDBOOK_ROLES = [
    DEPTH_ROLE,
    LORE_ROLE,
    NPC_ROLE,
    GOVERNANCE_ROLE,
];
export function getWorldbookRole(id) {
    return WORLDBOOK_ROLES.find((r) => r.id === id);
}
