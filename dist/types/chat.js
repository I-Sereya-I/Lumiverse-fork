/**
 * Temporary chats are disposable, character-less, persona-less chats used to
 * try out a connection profile. They are excluded from recent-chat lists and
 * swept (deleted) when the user returns to the landing page.
 */
export function isTemporaryChatMetadata(metadata) {
    return metadata?.temporary === true;
}
/**
 * Temporary chats may explicitly opt out of presets (metadata.no_preset) to
 * test a model raw: no preset blocks, no preset sampler parameters, and no
 * fallback to the active or connection-bound preset.
 */
export function isNoPresetChatMetadata(metadata) {
    return isTemporaryChatMetadata(metadata) && metadata?.no_preset === true;
}
