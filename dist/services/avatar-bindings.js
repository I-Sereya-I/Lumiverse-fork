export const AVATAR_BINDING_PRIMARY = "primary";
export const AVATAR_BINDING_FIELDS = ["description", "personality", "scenario"];
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function getAlternateAvatars(character) {
    const raw = character.extensions?.alternate_avatars;
    if (!Array.isArray(raw))
        return [];
    return raw.filter((entry) => isRecord(entry)
        && typeof entry.id === "string"
        && !!entry.id
        && typeof entry.image_id === "string"
        && !!entry.image_id
        && typeof entry.label === "string");
}
export function getAvatarBindings(character) {
    const raw = character.extensions?.avatar_bindings;
    if (!isRecord(raw))
        return {};
    const result = {};
    for (const [avatarId, value] of Object.entries(raw)) {
        if (!isRecord(value))
            continue;
        const binding = {};
        for (const field of AVATAR_BINDING_FIELDS) {
            const selected = value[field];
            if (selected === null || typeof selected === "string")
                binding[field] = selected;
        }
        const greetingIndex = value.greeting_index;
        if (greetingIndex === null || (Number.isInteger(greetingIndex) && greetingIndex >= 0)) {
            binding.greeting_index = greetingIndex;
        }
        if (Object.keys(binding).length > 0)
            result[avatarId] = binding;
    }
    return result;
}
export function resolveAvatarImageId(character, avatarEntryId) {
    if (avatarEntryId === AVATAR_BINDING_PRIMARY)
        return character.image_id || null;
    return getAlternateAvatars(character).find((entry) => entry.id === avatarEntryId)?.image_id;
}
export function findAvatarForFieldBinding(character, field, variantId) {
    const matches = Object.entries(getAvatarBindings(character))
        .filter(([, binding]) => Object.prototype.hasOwnProperty.call(binding, field) && binding[field] === variantId)
        .map(([avatarId]) => avatarId)
        .filter((avatarId) => resolveAvatarImageId(character, avatarId) !== undefined);
    return matches.length === 1 ? matches[0] : null;
}
export function findAvatarForGreetingBinding(character, greetingIndex) {
    const matches = Object.entries(getAvatarBindings(character))
        .filter(([, binding]) => binding.greeting_index === greetingIndex)
        .map(([avatarId]) => avatarId)
        .filter((avatarId) => resolveAvatarImageId(character, avatarId) !== undefined);
    return matches.length === 1 ? matches[0] : null;
}
