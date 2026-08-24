/**
 * Runtime defaults for Loom's generation-mode prompts.  The frontend applies
 * the same defaults when editing a preset, but generation must not depend on
 * the editor having opened and re-saved an older or partial preset first.
 */
export const DEFAULT_PROMPT_BEHAVIOR = {
    continueNudge: "[Continue your last message without repeating its original content.]",
    emptySendNudge: "[Write the next reply only as {{char}}.]",
    impersonationPrompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    groupNudge: "[Write the next reply only as {{char}}.]",
    newChatPrompt: "[Start a new Chat]",
    newGroupChatPrompt: "[Start a new group chat. Group members: {{group}}]",
    sendIfEmpty: "",
};
const PROMPT_BEHAVIOR_KEYS = Object.keys(DEFAULT_PROMPT_BEHAVIOR);
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
/**
 * Fill absent and malformed behavior-prompt values with defaults while
 * retaining an explicit empty string as the user's opt-out for that prompt.
 */
export function resolvePromptBehavior(value) {
    const resolved = { ...DEFAULT_PROMPT_BEHAVIOR };
    if (!isRecord(value))
        return resolved;
    for (const key of PROMPT_BEHAVIOR_KEYS) {
        if (typeof value[key] === "string") {
            resolved[key] = value[key];
        }
    }
    // Older presets that predate the dedicated group separator used the solo
    // separator as their group fallback. Keep that behavior when a partial
    // preset supplies only `newChatPrompt`.
    if (typeof value.newGroupChatPrompt !== "string" &&
        typeof value.newChatPrompt === "string") {
        resolved.newGroupChatPrompt = value.newChatPrompt;
    }
    return resolved;
}
export function isGenuinelyNewChat(messages) {
    for (const msg of messages) {
        if (msg.extra?.hidden === true)
            continue;
        if (!msg.is_user && msg.extra?.greeting !== true)
            return false;
    }
    return true;
}
export function resolveNewChatPromptConfig(promptBehavior, isGroupChat) {
    if (isGroupChat) {
        return {
            prompt: promptBehavior.newGroupChatPrompt,
            label: "New Group Chat Prompt",
        };
    }
    return {
        prompt: promptBehavior.newChatPrompt,
        label: "New Chat Prompt",
    };
}
/** Return the last visible persisted chat message, ignoring hidden drafts. */
export function getLastVisibleChatMessage(messages) {
    return [...messages]
        .reverse()
        .find((message) => message.extra?.hidden !== true);
}
/**
 * Empty Send is a normal-generation behavior.  Its presence must depend on
 * the actual chat turn being nudged, not on unrelated user-role preset blocks
 * that happen to have been assembled after history.
 */
export function shouldInjectEmptySendNudge(input) {
    const lastVisible = getLastVisibleChatMessage(input.messages);
    return (input.generationType === "normal" &&
        !input.targetCharacterId &&
        !!lastVisible &&
        !lastVisible.is_user);
}
export function shouldInjectGroupNudge(input) {
    return (input.isGroupChat &&
        typeof input.targetCharacterId === "string" &&
        input.groupCharacterIds.includes(input.targetCharacterId));
}
