import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as personasSvc from "./personas.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
// ---------------------------------------------------------------------------
// Setting key conventions
// ---------------------------------------------------------------------------
const LEGACY_DEFAULTS_KEY = "presetProfileDefaults";
function defaultsKey(presetId) {
    return `presetProfileDefaults:${presetId}`;
}
function characterKey(characterId) {
    return `presetProfile:character:${characterId}`;
}
function personaKey(personaId) {
    return `presetProfile:persona:${personaId}`;
}
function chatKey(chatId) {
    return `presetProfile:chat:${chatId}`;
}
function connectionKey(connectionId) {
    return `presetProfile:connection:${connectionId}`;
}
function defaultsVariablesKey(presetId) {
    return `presetProfileVariables:defaults:${presetId}`;
}
function variablesKey(scope, id) {
    return `presetProfileVariables:${scope}:${id}`;
}
/**
 * Profile bindings happen to be stored in the settings table, but they are
 * not app settings. Broadcasting SETTINGS_UPDATED makes clients reload the
 * globally selected preset, which can race and undo a chat-bound selection.
 */
function putProfileBinding(userId, key, binding) {
    settingsSvc.putSetting(userId, key, binding, { suppressBroadcast: true });
    eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key, binding }, userId);
}
function getProfilePromptVariables(userId, key, legacyBinding) {
    const stored = settingsSvc.getSetting(userId, key)?.value;
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        return stored;
    }
    return legacyBinding.prompt_variables;
}
function withProfilePromptVariables(userId, binding, key) {
    const promptVariables = getProfilePromptVariables(userId, key, binding);
    return promptVariables ? { ...binding, prompt_variables: promptVariables } : binding;
}
function replaceProfilePromptVariables(userId, key, promptVariables) {
    if (promptVariables) {
        settingsSvc.putSetting(userId, key, promptVariables, { suppressBroadcast: true });
        eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key, promptVariables }, userId);
    }
    else {
        settingsSvc.deleteSetting(userId, key);
    }
}
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
export function getDefaults(userId, presetId) {
    const current = getValidBinding(userId, defaultsKey(presetId));
    if (current) {
        if (current.preset_id === presetId) {
            return withProfilePromptVariables(userId, current, defaultsVariablesKey(presetId));
        }
        settingsSvc.deleteSetting(userId, defaultsKey(presetId));
    }
    // Legacy fallback: older builds stored a single shared defaults snapshot.
    const legacy = getValidBinding(userId, LEGACY_DEFAULTS_KEY);
    return legacy?.preset_id === presetId
        ? withProfilePromptVariables(userId, legacy, defaultsVariablesKey(presetId))
        : null;
}
function getDefaultsForBinding(userId, binding) {
    return getDefaults(userId, binding.preset_id);
}
function createBinding(presetId, blockStates, promptVariables, linkedToDefaults) {
    return {
        preset_id: presetId,
        block_states: blockStates,
        ...(promptVariables ? { prompt_variables: promptVariables } : {}),
        captured_at: Math.floor(Date.now() / 1000),
        ...(linkedToDefaults ? { linked_to_defaults: true } : {}),
    };
}
function assertPresetExists(userId, presetId) {
    if (!presetsSvc.getPreset(userId, presetId))
        throw new Error("Preset not found");
}
function getValidBinding(userId, key) {
    const s = settingsSvc.getSetting(userId, key);
    if (!s)
        return null;
    const binding = s.value;
    if (!binding?.preset_id || !presetsSvc.getPreset(userId, binding.preset_id)) {
        settingsSvc.deleteSetting(userId, key);
        return null;
    }
    return binding;
}
function resolveSpecificBinding(userId, source, sourceId, binding) {
    if (binding.linked_to_defaults) {
        return {
            preset_id: binding.preset_id,
            binding: getDefaultsForBinding(userId, binding),
            source,
            source_id: sourceId,
        };
    }
    return {
        preset_id: binding.preset_id,
        binding,
        source,
        source_id: sourceId,
    };
}
export function captureDefaults(userId, presetId, blockStates, promptVariables) {
    assertPresetExists(userId, presetId);
    const binding = createBinding(presetId, blockStates);
    putProfileBinding(userId, defaultsKey(presetId), binding);
    replaceProfilePromptVariables(userId, defaultsVariablesKey(presetId), promptVariables);
    return withProfilePromptVariables(userId, binding, defaultsVariablesKey(presetId));
}
export function deleteDefaults(userId, presetId) {
    const deleted = settingsSvc.deleteSetting(userId, defaultsKey(presetId));
    settingsSvc.deleteSetting(userId, defaultsVariablesKey(presetId));
    const legacy = settingsSvc.getSetting(userId, LEGACY_DEFAULTS_KEY);
    if (legacy && legacy.value?.preset_id === presetId) {
        settingsSvc.deleteSetting(userId, LEGACY_DEFAULTS_KEY);
        return true;
    }
    return deleted;
}
// ---------------------------------------------------------------------------
// Character bindings
// ---------------------------------------------------------------------------
export function getCharacterBinding(userId, characterId) {
    const binding = getValidBinding(userId, characterKey(characterId));
    return binding ? withProfilePromptVariables(userId, binding, variablesKey("character", characterId)) : null;
}
export function setCharacterBinding(userId, characterId, presetId, blockStates, promptVariables) {
    // Validate character exists
    const character = charactersSvc.getCharacter(userId, characterId);
    if (!character)
        throw new Error("Character not found");
    assertPresetExists(userId, presetId);
    const binding = createBinding(presetId, blockStates);
    putProfileBinding(userId, characterKey(characterId), binding);
    replaceProfilePromptVariables(userId, variablesKey("character", characterId), promptVariables);
    return withProfilePromptVariables(userId, binding, variablesKey("character", characterId));
}
export function deleteCharacterBinding(userId, characterId) {
    const deleted = settingsSvc.deleteSetting(userId, characterKey(characterId));
    settingsSvc.deleteSetting(userId, variablesKey("character", characterId));
    return deleted;
}
// ---------------------------------------------------------------------------
// Persona bindings
// ---------------------------------------------------------------------------
export function getPersonaBinding(userId, personaId) {
    const binding = getValidBinding(userId, personaKey(personaId));
    return binding ? withProfilePromptVariables(userId, binding, variablesKey("persona", personaId)) : null;
}
export function setPersonaBinding(userId, personaId, presetId, blockStates, promptVariables) {
    if (!personasSvc.getPersona(userId, personaId))
        throw new Error("Persona not found");
    assertPresetExists(userId, presetId);
    const binding = createBinding(presetId, blockStates);
    putProfileBinding(userId, personaKey(personaId), binding);
    replaceProfilePromptVariables(userId, variablesKey("persona", personaId), promptVariables);
    return withProfilePromptVariables(userId, binding, variablesKey("persona", personaId));
}
export function deletePersonaBinding(userId, personaId) {
    const deleted = settingsSvc.deleteSetting(userId, personaKey(personaId));
    settingsSvc.deleteSetting(userId, variablesKey("persona", personaId));
    return deleted;
}
// ---------------------------------------------------------------------------
// Chat bindings
// ---------------------------------------------------------------------------
export function getChatBinding(userId, chatId) {
    const binding = getValidBinding(userId, chatKey(chatId));
    return binding ? withProfilePromptVariables(userId, binding, variablesKey("chat", chatId)) : null;
}
export function setChatBinding(userId, chatId, presetId, blockStates, promptVariables, linkedToDefaults) {
    // Validate chat exists
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat)
        throw new Error("Chat not found");
    assertPresetExists(userId, presetId);
    const binding = createBinding(presetId, blockStates ?? {}, undefined, linkedToDefaults);
    putProfileBinding(userId, chatKey(chatId), binding);
    replaceProfilePromptVariables(userId, variablesKey("chat", chatId), promptVariables);
    return withProfilePromptVariables(userId, binding, variablesKey("chat", chatId));
}
export function deleteChatBinding(userId, chatId) {
    const deleted = settingsSvc.deleteSetting(userId, chatKey(chatId));
    settingsSvc.deleteSetting(userId, variablesKey("chat", chatId));
    return deleted;
}
/** Update a profile's values without replacing its saved block states. */
function updateBindingPromptVariables(userId, key, promptVariablesKey, promptVariables) {
    const binding = getValidBinding(userId, key);
    if (!binding)
        throw new Error("No profile binding found");
    // A linked chat delegates both block and variable state to the defaults.
    if (binding.linked_to_defaults) {
        const defaults = getDefaults(userId, binding.preset_id);
        if (!defaults)
            throw new Error("No defaults captured");
        replaceProfilePromptVariables(userId, defaultsVariablesKey(defaults.preset_id), promptVariables);
        return getDefaults(userId, defaults.preset_id);
    }
    replaceProfilePromptVariables(userId, promptVariablesKey, promptVariables);
    return withProfilePromptVariables(userId, binding, promptVariablesKey);
}
export function updateDefaultsPromptVariables(userId, presetId, promptVariables) {
    const binding = getDefaults(userId, presetId);
    if (!binding)
        throw new Error("No defaults captured");
    replaceProfilePromptVariables(userId, defaultsVariablesKey(presetId), promptVariables);
    return getDefaults(userId, presetId);
}
export function updateChatPromptVariables(userId, chatId, promptVariables) {
    return updateBindingPromptVariables(userId, chatKey(chatId), variablesKey("chat", chatId), promptVariables);
}
export function updatePersonaPromptVariables(userId, personaId, promptVariables) {
    return updateBindingPromptVariables(userId, personaKey(personaId), variablesKey("persona", personaId), promptVariables);
}
export function updateCharacterPromptVariables(userId, characterId, promptVariables) {
    return updateBindingPromptVariables(userId, characterKey(characterId), variablesKey("character", characterId), promptVariables);
}
export function updateConnectionPromptVariables(userId, connectionId, promptVariables) {
    return updateBindingPromptVariables(userId, connectionKey(connectionId), variablesKey("connection", connectionId), promptVariables);
}
// ---------------------------------------------------------------------------
// Connection profile bindings
// ---------------------------------------------------------------------------
export function getConnectionBinding(userId, connectionId) {
    const binding = getValidBinding(userId, connectionKey(connectionId));
    return binding ? withProfilePromptVariables(userId, binding, variablesKey("connection", connectionId)) : null;
}
export function setConnectionBinding(userId, connectionId, presetId, blockStates, promptVariables) {
    const connection = connectionsSvc.getConnection(userId, connectionId);
    if (!connection)
        throw new Error("Connection not found");
    assertPresetExists(userId, presetId);
    const binding = createBinding(presetId, blockStates);
    putProfileBinding(userId, connectionKey(connectionId), binding);
    replaceProfilePromptVariables(userId, variablesKey("connection", connectionId), promptVariables);
    return withProfilePromptVariables(userId, binding, variablesKey("connection", connectionId));
}
export function deleteConnectionBinding(userId, connectionId) {
    const deleted = settingsSvc.deleteSetting(userId, connectionKey(connectionId));
    settingsSvc.deleteSetting(userId, variablesKey("connection", connectionId));
    return deleted;
}
// ---------------------------------------------------------------------------
// Resolution — determines which binding to apply for a given context
// ---------------------------------------------------------------------------
export function resolveProfile(userId, fallbackPresetId, chatId, characterId, options = {}) {
    // 1. Chat-level binding (most specific)
    const chatBinding = getChatBinding(userId, chatId);
    if (chatBinding) {
        return resolveSpecificBinding(userId, "chat", chatId, chatBinding);
    }
    // 2. Persona-level binding. It deliberately outranks a character profile:
    // switching personas is expected to restore that persona's preset state in
    // one action. Chat bindings remain the explicit per-conversation override.
    if (options.personaId) {
        const personaBinding = getPersonaBinding(userId, options.personaId);
        if (personaBinding) {
            return resolveSpecificBinding(userId, "persona", options.personaId, personaBinding);
        }
    }
    // 3. Character-level binding — skipped in group chats. Per-member bindings
    //    would be ambiguous (which member wins?), so group chats are chat-only.
    if (!options.isGroup && characterId) {
        const charBinding = getCharacterBinding(userId, characterId);
        if (charBinding) {
            return resolveSpecificBinding(userId, "character", characterId, charBinding);
        }
    }
    // 4. Connection-level binding — applies across chats for the active model
    //    environment when there isn't a more specific chat/character binding.
    if (options.connectionId) {
        const connectionBinding = getConnectionBinding(userId, options.connectionId);
        if (connectionBinding) {
            return resolveSpecificBinding(userId, "connection", options.connectionId, connectionBinding);
        }
    }
    // 5. Default snapshot — defaults are stored per preset, so they only apply
    //    when there isn't a more specific chat/character/connection binding.
    if (fallbackPresetId) {
        const defaults = getDefaults(userId, fallbackPresetId);
        if (defaults) {
            return { preset_id: defaults.preset_id, binding: defaults, source: "defaults", source_id: fallbackPresetId };
        }
    }
    // 6. No matching binding — use raw preset block states
    return { preset_id: fallbackPresetId, binding: null, source: "none", source_id: null };
}
// ---------------------------------------------------------------------------
// Block state application — mutates block enabled states in place
// ---------------------------------------------------------------------------
export function applyProfileToBlocks(blocks, binding) {
    for (const block of blocks) {
        if (block.id in binding.block_states) {
            block.enabled = binding.block_states[block.id];
        }
    }
}
export function normalizeCategoryBlockStates(blocks) {
    let currentCategoryMode = null;
    let currentChildren = [];
    const normalizeCurrentGroup = () => {
        if (currentCategoryMode !== "radio")
            return;
        const enabledChildren = currentChildren.filter((block) => block.enabled);
        if (enabledChildren.length <= 1)
            return;
        const keepId = enabledChildren[0].id;
        for (const block of currentChildren) {
            block.enabled = block.id === keepId;
        }
    };
    for (const block of blocks) {
        if (block.marker === "category") {
            normalizeCurrentGroup();
            currentCategoryMode = block.categoryMode ?? null;
            currentChildren = [];
            continue;
        }
        currentChildren.push(block);
    }
    normalizeCurrentGroup();
}
