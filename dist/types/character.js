/** Sentinel id for the synthetic character backing character-less chats. */
export const ASSISTANT_CHARACTER_ID = "__assistant__";
/**
 * Synthetic stand-in for temporary character-less chats so prompt assembly,
 * macros, and attribution run unchanged. Never persisted; the sentinel id
 * matches no DB row, so character-bound lookups (world books, databanks,
 * preset bindings) naturally resolve to nothing.
 */
export function makeAssistantCharacter() {
    return {
        id: ASSISTANT_CHARACTER_ID,
        name: "Assistant",
        avatar_path: null,
        image_id: null,
        description: "",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        folder: "",
        tags: [],
        alternate_greetings: [],
        extensions: {},
        library_scope: "mine",
        created_at: 0,
        updated_at: 0,
    };
}
/**
 * Returns the effective name used for prompt/macro resolution.
 * Uses `extensions.alternate_character_name` if set, otherwise falls back to the true name.
 */
export function getEffectiveCharacterName(character) {
    return character.extensions?.alternate_character_name?.trim() || character.name;
}
