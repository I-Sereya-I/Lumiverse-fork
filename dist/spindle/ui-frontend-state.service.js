/**
 * Per-user snapshots of extension-registered UI tabs.
 *
 * Extension drawer and settings tabs are registered in the frontend via
 * `ctx.ui.registerDrawerTab(...)` / `ctx.ui.registerSettingsTab(...)`; they
 * have no backend representation by default. To let the `spindle.ui` API
 * enumerate them, the frontend pushes the current lists over the WebSocket whenever they change
 * (`SPINDLE_UI_REGISTRY_SYNC`). This service caches the latest snapshot
 * per user.
 *
 * State is in-memory only — fine because the frontend re-syncs on every
 * reconnect.
 */
const userExtensionTabs = new Map();
const userExtensionSettingsTabs = new Map();
const MAX_TABS_PER_USER = 64;
const MAX_SETTINGS_TABS_PER_EXTENSION = 4;
const MAX_SETTINGS_TABS_PER_USER = 32;
const MAX_KEYWORDS_PER_TAB = 16;
const MAX_STRING_LEN = 200;
function clampString(value, max = MAX_STRING_LEN) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.slice(0, max);
}
function sanitizeTab(input) {
    if (!input || typeof input !== "object")
        return null;
    const raw = input;
    const id = clampString(raw.id, 100);
    const extensionId = clampString(raw.extensionId, 100);
    const tabName = clampString(raw.tabName, 100);
    if (!id || !extensionId || !tabName)
        return null;
    const keywords = Array.isArray(raw.keywords)
        ? raw.keywords
            .map((k) => clampString(k, 50))
            .filter((k) => !!k)
            .slice(0, MAX_KEYWORDS_PER_TAB)
        : undefined;
    return {
        id,
        extensionId,
        tabName,
        shortName: clampString(raw.shortName, 32),
        tabDescription: clampString(raw.tabDescription, 200),
        keywords,
    };
}
function sanitizeSettingsTab(input) {
    if (!input || typeof input !== "object")
        return null;
    const raw = input;
    const registrationId = clampString(raw.registrationId, 140);
    const tabId = clampString(raw.tabId ?? raw.id, 100);
    const extensionId = clampString(raw.extensionId, 100);
    if (!registrationId || !tabId || !extensionId)
        return null;
    const tabName = clampString(raw.tabName, 100);
    const keywords = Array.isArray(raw.keywords)
        ? raw.keywords
            .map((keyword) => clampString(keyword, 50))
            .filter((keyword) => !!keyword)
            .slice(0, MAX_KEYWORDS_PER_TAB)
        : undefined;
    const order = typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : 100;
    const sequence = typeof raw.sequence === "number" && Number.isFinite(raw.sequence) ? raw.sequence : 0;
    return {
        registrationId,
        tabId,
        extensionId,
        tabName,
        shortName: clampString(raw.shortName, 32),
        tabDescription: clampString(raw.tabDescription, 200),
        iconSvg: clampString(raw.iconSvg, 8_192),
        keywords,
        order,
        sequence,
    };
}
export function setUserExtensionDrawerTabs(userId, tabs) {
    if (!userId || typeof userId !== "string")
        return;
    const list = Array.isArray(tabs) ? tabs : [];
    const seen = new Set();
    const sanitized = [];
    for (const raw of list) {
        const tab = sanitizeTab(raw);
        if (!tab)
            continue;
        if (seen.has(tab.id))
            continue;
        seen.add(tab.id);
        sanitized.push(tab);
        if (sanitized.length >= MAX_TABS_PER_USER)
            break;
    }
    if (sanitized.length === 0) {
        userExtensionTabs.delete(userId);
        return;
    }
    userExtensionTabs.set(userId, sanitized);
}
export function getUserExtensionDrawerTabs(userId) {
    if (!userId)
        return [];
    return userExtensionTabs.get(userId) ?? [];
}
export function clearUserExtensionDrawerTabs(userId) {
    userExtensionTabs.delete(userId);
}
export function setUserExtensionSettingsTabs(userId, tabs) {
    if (!userId || typeof userId !== "string")
        return;
    const list = Array.isArray(tabs) ? tabs : [];
    const seenRegistrationIds = new Set();
    const countsByExtension = new Map();
    const sanitized = [];
    for (const raw of list) {
        const tab = sanitizeSettingsTab(raw);
        if (!tab || seenRegistrationIds.has(tab.registrationId))
            continue;
        const extensionCount = countsByExtension.get(tab.extensionId) ?? 0;
        if (extensionCount >= MAX_SETTINGS_TABS_PER_EXTENSION)
            continue;
        seenRegistrationIds.add(tab.registrationId);
        countsByExtension.set(tab.extensionId, extensionCount + 1);
        sanitized.push(tab);
        if (sanitized.length >= MAX_SETTINGS_TABS_PER_USER)
            break;
    }
    if (sanitized.length === 0) {
        userExtensionSettingsTabs.delete(userId);
        return;
    }
    userExtensionSettingsTabs.set(userId, sanitized);
}
export function getUserExtensionSettingsTabs(userId) {
    if (!userId)
        return [];
    return userExtensionSettingsTabs.get(userId) ?? [];
}
export function clearUserExtensionSettingsTabs(userId) {
    userExtensionSettingsTabs.delete(userId);
}
