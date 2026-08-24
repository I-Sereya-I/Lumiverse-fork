import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
// ---------------------------------------------------------------------------
// Setting key conventions
// ---------------------------------------------------------------------------
const LOADOUTS_KEY = "loadouts";
function characterKey(characterId) {
    return `loadout:character:${characterId}`;
}
function chatKey(chatId) {
    return `loadout:chat:${chatId}`;
}
// ---------------------------------------------------------------------------
// Settings keys captured in a loadout snapshot
// ---------------------------------------------------------------------------
const SNAPSHOT_SETTINGS_KEYS = [
    "selectedDefinition", "selectedChimeraDefinitions", "selectedBehaviors", "selectedPersonalities",
    "chimeraMode", "lumiaQuirks", "lumiaQuirksEnabled",
    "selectedLoomStyles", "selectedLoomUtils", "selectedLoomRetrofits",
    "oocEnabled", "lumiaOOCStyle", "lumiaOOCInterval",
    "sovereignHand", "contextFilters",
];
// ---------------------------------------------------------------------------
// Loadout CRUD
// ---------------------------------------------------------------------------
export function getAllLoadouts(userId) {
    const s = settingsSvc.getSetting(userId, LOADOUTS_KEY);
    return s ? s.value : [];
}
export function getLoadout(userId, loadoutId) {
    const all = getAllLoadouts(userId);
    return all.find((l) => l.id === loadoutId) ?? null;
}
export function createLoadout(userId, name, snapshot) {
    const all = getAllLoadouts(userId);
    const finalSnapshot = snapshot ?? captureSnapshot(userId);
    const now = Math.floor(Date.now() / 1000);
    const loadout = {
        id: crypto.randomUUID(),
        name,
        snapshot: finalSnapshot,
        created_at: now,
        updated_at: now,
    };
    all.push(loadout);
    settingsSvc.putSetting(userId, LOADOUTS_KEY, all);
    return loadout;
}
export function updateLoadout(userId, loadoutId, updates) {
    const all = getAllLoadouts(userId);
    const idx = all.findIndex((l) => l.id === loadoutId);
    if (idx < 0)
        return null;
    const loadout = all[idx];
    if (updates.name !== undefined)
        loadout.name = updates.name;
    if (updates.recapture)
        loadout.snapshot = captureSnapshot(userId);
    loadout.updated_at = Math.floor(Date.now() / 1000);
    all[idx] = loadout;
    settingsSvc.putSetting(userId, LOADOUTS_KEY, all);
    return loadout;
}
export function deleteLoadout(userId, loadoutId) {
    const all = getAllLoadouts(userId);
    const filtered = all.filter((l) => l.id !== loadoutId);
    if (filtered.length === all.length)
        return false;
    settingsSvc.putSetting(userId, LOADOUTS_KEY, filtered);
    // Cleanup bindings referencing this loadout
    cleanupBindings(userId, loadoutId);
    return true;
}
// ---------------------------------------------------------------------------
// Snapshot capture & apply
// ---------------------------------------------------------------------------
export function captureSnapshot(userId) {
    const settingsMap = settingsSvc.getSettingsByKeys(userId, SNAPSHOT_SETTINGS_KEYS);
    return {
        selectedDefinition: settingsMap.get("selectedDefinition") ?? null,
        selectedChimeraDefinitions: settingsMap.get("selectedChimeraDefinitions") ?? [],
        selectedBehaviors: settingsMap.get("selectedBehaviors") ?? [],
        selectedPersonalities: settingsMap.get("selectedPersonalities") ?? [],
        chimeraMode: settingsMap.get("chimeraMode") ?? false,
        lumiaQuirks: settingsMap.get("lumiaQuirks") ?? "",
        lumiaQuirksEnabled: settingsMap.get("lumiaQuirksEnabled") ?? true,
        selectedLoomStyles: settingsMap.get("selectedLoomStyles") ?? [],
        selectedLoomUtils: settingsMap.get("selectedLoomUtils") ?? [],
        selectedLoomRetrofits: settingsMap.get("selectedLoomRetrofits") ?? [],
        oocEnabled: settingsMap.get("oocEnabled") ?? true,
        lumiaOOCStyle: settingsMap.get("lumiaOOCStyle") ?? "social",
        lumiaOOCInterval: settingsMap.get("lumiaOOCInterval") ?? null,
        sovereignHand: settingsMap.get("sovereignHand") ?? {
            enabled: false,
            excludeLastMessage: true,
            includeMessageInPrompt: true,
        },
        contextFilters: settingsMap.get("contextFilters") ?? {},
    };
}
export function applySnapshot(userId, snapshot) {
    const batch = {
        selectedDefinition: snapshot.selectedDefinition,
        selectedChimeraDefinitions: snapshot.selectedChimeraDefinitions ?? [],
        selectedBehaviors: snapshot.selectedBehaviors,
        selectedPersonalities: snapshot.selectedPersonalities,
        chimeraMode: snapshot.chimeraMode,
        lumiaQuirks: snapshot.lumiaQuirks,
        lumiaQuirksEnabled: snapshot.lumiaQuirksEnabled,
        selectedLoomStyles: snapshot.selectedLoomStyles,
        selectedLoomUtils: snapshot.selectedLoomUtils,
        selectedLoomRetrofits: snapshot.selectedLoomRetrofits,
        oocEnabled: snapshot.oocEnabled,
        lumiaOOCStyle: snapshot.lumiaOOCStyle,
        lumiaOOCInterval: snapshot.lumiaOOCInterval,
        sovereignHand: snapshot.sovereignHand,
        contextFilters: snapshot.contextFilters,
    };
    settingsSvc.putMany(userId, batch);
    // Council is intentionally NOT applied here. Council members, tool toggles and
    // sidecar are owned solely by the council-profile system (Character/Chat/
    // Defaults binds) so the two can no longer override each other. Older loadout
    // snapshots may still carry a `councilSettings` blob; it is ignored.
}
// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------
export function getCharacterBinding(userId, characterId) {
    const s = settingsSvc.getSetting(userId, characterKey(characterId));
    return s ? s.value : null;
}
export function setCharacterBinding(userId, characterId, loadoutId) {
    const loadout = getLoadout(userId, loadoutId);
    if (!loadout)
        throw new Error("Loadout not found");
    const binding = {
        loadout_id: loadoutId,
        bound_at: Math.floor(Date.now() / 1000),
    };
    settingsSvc.putSetting(userId, characterKey(characterId), binding);
    return binding;
}
export function deleteCharacterBinding(userId, characterId) {
    return settingsSvc.deleteSetting(userId, characterKey(characterId));
}
export function getChatBinding(userId, chatId) {
    const s = settingsSvc.getSetting(userId, chatKey(chatId));
    return s ? s.value : null;
}
export function setChatBinding(userId, chatId, loadoutId) {
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat)
        throw new Error("Chat not found");
    const loadout = getLoadout(userId, loadoutId);
    if (!loadout)
        throw new Error("Loadout not found");
    const binding = {
        loadout_id: loadoutId,
        bound_at: Math.floor(Date.now() / 1000),
    };
    settingsSvc.putSetting(userId, chatKey(chatId), binding);
    return binding;
}
export function deleteChatBinding(userId, chatId) {
    return settingsSvc.deleteSetting(userId, chatKey(chatId));
}
// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export function resolveLoadout(userId, chatId) {
    // 1. Chat-level binding (most specific)
    const chatBinding = getChatBinding(userId, chatId);
    if (chatBinding) {
        const loadout = getLoadout(userId, chatBinding.loadout_id);
        if (loadout)
            return { loadout, source: "chat" };
    }
    // 2. Character-level binding
    const chat = chatsSvc.getChat(userId, chatId);
    if (chat?.character_id) {
        const charBinding = getCharacterBinding(userId, chat.character_id);
        if (charBinding) {
            const loadout = getLoadout(userId, charBinding.loadout_id);
            if (loadout)
                return { loadout, source: "character" };
        }
    }
    // 3. No binding
    return { loadout: null, source: "none" };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cleanupBindings(userId, loadoutId) {
    // Get all settings and scan for loadout binding keys referencing this loadout
    const allSettings = settingsSvc.getAllSettings(userId);
    for (const setting of allSettings) {
        if ((setting.key.startsWith("loadout:character:") || setting.key.startsWith("loadout:chat:")) &&
            setting.value?.loadout_id === loadoutId) {
            settingsSvc.deleteSetting(userId, setting.key);
        }
    }
}
