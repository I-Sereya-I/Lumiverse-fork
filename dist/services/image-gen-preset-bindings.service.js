import * as settingsSvc from "./settings.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
function characterKey(characterId) {
    return `imageGenPromptPreset:character:${characterId}`;
}
function personaKey(personaId) {
    return `imageGenPromptPreset:persona:${personaId}`;
}
function readBinding(userId, key) {
    const s = settingsSvc.getSetting(userId, key);
    if (!s)
        return null;
    const value = s.value;
    if (!value?.preset_id) {
        settingsSvc.deleteSetting(userId, key);
        return null;
    }
    return value;
}
export function getCharacterBinding(userId, characterId) {
    return readBinding(userId, characterKey(characterId));
}
export function setCharacterBinding(userId, characterId, presetId) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (!character)
        throw new Error("Character not found");
    const binding = {
        preset_id: presetId,
        bound_at: Math.floor(Date.now() / 1000),
    };
    settingsSvc.putSetting(userId, characterKey(characterId), binding);
    return binding;
}
export function deleteCharacterBinding(userId, characterId) {
    return settingsSvc.deleteSetting(userId, characterKey(characterId));
}
export function getPersonaBinding(userId, personaId) {
    return readBinding(userId, personaKey(personaId));
}
export function setPersonaBinding(userId, personaId, presetId) {
    const persona = personasSvc.getPersona(userId, personaId);
    if (!persona)
        throw new Error("Persona not found");
    const binding = {
        preset_id: presetId,
        bound_at: Math.floor(Date.now() / 1000),
    };
    settingsSvc.putSetting(userId, personaKey(personaId), binding);
    return binding;
}
export function deletePersonaBinding(userId, personaId) {
    return settingsSvc.deleteSetting(userId, personaKey(personaId));
}
