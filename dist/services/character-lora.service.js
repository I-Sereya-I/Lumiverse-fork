import * as settingsSvc from "./settings.service";
import * as charactersSvc from "./characters.service";
/**
 * Key on `character.extensions` used to carry a portable LoRA hint with the
 * character card. Read on character import to surface "this character expects
 * <filename> @ <weight>" to the receiving user. NEVER fetch the source_url —
 * it's display-only because auto-downloading safetensors from URLs embedded
 * in shared PNGs is a phishing vector.
 */
export const PORTABLE_LORA_EXTENSION_KEY = "lumiverse_image_gen_lora";
function bindingKey(characterId) {
    return `characterLora:${characterId}`;
}
function coerceWeight(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
function readRaw(userId, characterId) {
    const s = settingsSvc.getSetting(userId, bindingKey(characterId));
    if (!s)
        return null;
    const value = s.value;
    if (!value || typeof value !== "object" || typeof value.lora_name !== "string" || !value.lora_name) {
        settingsSvc.deleteSetting(userId, bindingKey(characterId));
        return null;
    }
    return {
        lora_name: value.lora_name,
        weight_model: coerceWeight(value.weight_model, 1),
        weight_clip: coerceWeight(value.weight_clip, coerceWeight(value.weight_model, 1)),
        base_tags: typeof value.base_tags === "string" ? value.base_tags : undefined,
        source_url: typeof value.source_url === "string" ? value.source_url : undefined,
        bound_at: typeof value.bound_at === "number" ? value.bound_at : Math.floor(Date.now() / 1000),
    };
}
export function getCharacterLora(userId, characterId) {
    return readRaw(userId, characterId);
}
export function setCharacterLora(userId, characterId, input) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (!character)
        throw new Error("Character not found");
    const lora_name = String(input.lora_name || "").trim();
    if (!lora_name)
        throw new Error("lora_name is required");
    const weight_model = coerceWeight(input.weight_model, 1);
    const weight_clip = coerceWeight(input.weight_clip, weight_model);
    const binding = {
        lora_name,
        weight_model,
        weight_clip,
        base_tags: input.base_tags?.trim() || undefined,
        source_url: input.source_url?.trim() || undefined,
        bound_at: Math.floor(Date.now() / 1000),
    };
    settingsSvc.putSetting(userId, bindingKey(characterId), binding);
    mirrorPortableReference(userId, character, binding);
    return binding;
}
export function deleteCharacterLora(userId, characterId) {
    const deleted = settingsSvc.deleteSetting(userId, bindingKey(characterId));
    // Best-effort mirror removal — keeps the exportable card clean when the
    // user has explicitly unbound the LoRA. If the character was already gone
    // we silently swallow the error.
    try {
        const character = charactersSvc.getCharacter(userId, characterId);
        if (character?.extensions && PORTABLE_LORA_EXTENSION_KEY in character.extensions) {
            const nextExtensions = { ...character.extensions };
            delete nextExtensions[PORTABLE_LORA_EXTENSION_KEY];
            charactersSvc.updateCharacter(userId, characterId, { extensions: nextExtensions });
        }
    }
    catch (err) {
        console.warn("[character-lora] Failed to clear portable LoRA reference:", err);
    }
    return deleted;
}
/**
 * Read the portable LoRA hint embedded on a character. Used by importers to
 * surface "this character expects X" — never as a source of truth for
 * runtime generation (that's the per-user binding above).
 */
export function readPortableLoraReference(character) {
    const raw = character.extensions?.[PORTABLE_LORA_EXTENSION_KEY];
    if (!raw || typeof raw !== "object")
        return null;
    if (typeof raw.lora_filename !== "string" || !raw.lora_filename)
        return null;
    if (typeof raw.weight !== "number" || !Number.isFinite(raw.weight))
        return null;
    return {
        version: 1,
        lora_filename: raw.lora_filename,
        weight: raw.weight,
        base_tags: typeof raw.base_tags === "string" ? raw.base_tags : undefined,
        source_url: typeof raw.source_url === "string" ? raw.source_url : undefined,
    };
}
function mirrorPortableReference(userId, character, binding) {
    try {
        const reference = {
            version: 1,
            lora_filename: binding.lora_name,
            weight: binding.weight_model,
            base_tags: binding.base_tags,
            source_url: binding.source_url,
        };
        const nextExtensions = { ...(character.extensions ?? {}), [PORTABLE_LORA_EXTENSION_KEY]: reference };
        charactersSvc.updateCharacter(userId, character.id, { extensions: nextExtensions });
    }
    catch (err) {
        // Mirroring is a portability nicety — never let it block the user from
        // saving their own binding. Log so we can spot persistent failures.
        console.warn("[character-lora] Failed to mirror portable LoRA reference:", err);
    }
}
