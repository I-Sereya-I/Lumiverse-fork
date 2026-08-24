import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
export const WEB_SEARCH_SETTINGS_KEY = "webSearchSettings";
/** Legacy SearXNG key name; retained so existing installations keep working. */
export const WEB_SEARCH_API_KEY_SECRET = "web_search_api_key";
export const EXA_WEB_SEARCH_API_KEY_SECRET = "web_search_exa_api_key";
export const TAVILY_WEB_SEARCH_API_KEY_SECRET = "web_search_tavily_api_key";
export const EXA_SEARCH_API_URL = "https://api.exa.ai/search";
export const TAVILY_SEARCH_API_URL = "https://api.tavily.com/search";
/**
 * API keys are deliberately kept out of the user-settings JSON. Each
 * provider gets its own encrypted, user-scoped secret so switching providers
 * does not overwrite a credential that the user may switch back to later.
 */
export function webSearchApiKeySecretForProvider(provider) {
    if (provider === "exa")
        return EXA_WEB_SEARCH_API_KEY_SECRET;
    if (provider === "tavily")
        return TAVILY_WEB_SEARCH_API_KEY_SECRET;
    return WEB_SEARCH_API_KEY_SECRET;
}
const DEFAULT_SETTINGS = {
    enabled: false,
    provider: "searxng",
    apiUrl: "",
    requestTimeoutMs: 15_000,
    defaultResultCount: 3,
    maxResultCount: 5,
    maxPagesToScrape: 3,
    maxCharsPerPage: 3_000,
    language: "all",
    safeSearch: 1,
    engines: [],
    inlineToolEnabled: false,
};
function clampInt(value, min, max, fallback) {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}
function normalizeApiUrl(value) {
    if (typeof value !== "string")
        return DEFAULT_SETTINGS.apiUrl;
    return value.trim().replace(/\/$/, "");
}
function normalizeProvider(value) {
    return value === "exa" || value === "tavily" ? value : "searxng";
}
function normalizeLanguage(value) {
    if (typeof value !== "string")
        return DEFAULT_SETTINGS.language;
    const trimmed = value.trim();
    return trimmed || DEFAULT_SETTINGS.language;
}
function normalizeEngines(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const engines = [];
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        engines.push(trimmed);
        if (engines.length >= 20)
            break;
    }
    return engines;
}
function normalizeBaseSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const provider = normalizeProvider(merged.provider);
    const defaultResultCount = clampInt(merged.defaultResultCount, 1, 10, DEFAULT_SETTINGS.defaultResultCount);
    const maxResultCount = clampInt(merged.maxResultCount, defaultResultCount, 20, DEFAULT_SETTINGS.maxResultCount);
    return {
        enabled: !!merged.enabled,
        provider,
        // Hosted provider endpoints are fixed. Do not let a stale SearXNG URL get
        // used when a client switches providers without resetting apiUrl.
        apiUrl: provider === "exa"
            ? EXA_SEARCH_API_URL
            : provider === "tavily"
                ? TAVILY_SEARCH_API_URL
                : normalizeApiUrl(merged.apiUrl),
        requestTimeoutMs: clampInt(merged.requestTimeoutMs, 5_000, 120_000, DEFAULT_SETTINGS.requestTimeoutMs),
        defaultResultCount,
        maxResultCount,
        maxPagesToScrape: clampInt(merged.maxPagesToScrape, 1, 10, DEFAULT_SETTINGS.maxPagesToScrape),
        maxCharsPerPage: clampInt(merged.maxCharsPerPage, 500, 20_000, DEFAULT_SETTINGS.maxCharsPerPage),
        language: normalizeLanguage(merged.language),
        safeSearch: clampInt(merged.safeSearch, 0, 2, DEFAULT_SETTINGS.safeSearch),
        engines: normalizeEngines(merged.engines),
        inlineToolEnabled: merged.inlineToolEnabled === true,
    };
}
function toProviderProfile(settings) {
    const { enabled: _enabled, provider: _provider, ...profile } = settings;
    return profile;
}
function normalizeProviderProfiles(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return {};
    const profiles = {};
    for (const provider of ["searxng", "exa", "tavily"]) {
        const profile = raw[provider];
        if (!profile || typeof profile !== "object" || Array.isArray(profile))
            continue;
        profiles[provider] = toProviderProfile(normalizeBaseSettings({
            ...profile,
            provider,
        }));
    }
    return profiles;
}
function normalizeStoredWebSearchSettings(raw) {
    const normalized = normalizeBaseSettings(raw);
    const providerProfiles = normalizeProviderProfiles(raw?.providerProfiles);
    // Existing installations have a single flat config. Seed its provider's
    // first profile lazily so upgrades do not need a data migration.
    if (!providerProfiles[normalized.provider]) {
        providerProfiles[normalized.provider] = toProviderProfile(normalized);
    }
    return { ...normalized, providerProfiles };
}
export function normalizeWebSearchSettings(raw, hasApiKey) {
    return {
        ...normalizeStoredWebSearchSettings(raw),
        hasApiKey,
    };
}
export async function getWebSearchSettings(userId) {
    const row = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY);
    const normalized = normalizeStoredWebSearchSettings(row?.value ?? undefined);
    const hasApiKey = await secretsSvc.validateSecret(userId, webSearchApiKeySecretForProvider(normalized.provider));
    const providerProfiles = Object.fromEntries(await Promise.all(Object.entries(normalized.providerProfiles).map(async ([provider, profile]) => [
        provider,
        {
            ...profile,
            hasApiKey: await secretsSvc.validateSecret(userId, webSearchApiKeySecretForProvider(provider)),
        },
    ])));
    return { ...normalized, hasApiKey, providerProfiles };
}
export async function getWebSearchApiKey(userId, provider = "searxng") {
    return secretsSvc.getSecret(userId, webSearchApiKeySecretForProvider(provider));
}
export async function putWebSearchSettings(userId, input) {
    const currentRaw = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY)?.value;
    const current = normalizeStoredWebSearchSettings(currentRaw);
    const requestedProvider = normalizeProvider(input.provider ?? current.provider);
    const suppliedProfiles = normalizeProviderProfiles(input.providerProfiles);
    const providerProfiles = { ...current.providerProfiles, ...suppliedProfiles };
    const selectedProfile = providerProfiles[requestedProvider];
    const merged = normalizeBaseSettings({
        ...current,
        ...selectedProfile,
        ...input,
        provider: requestedProvider,
    });
    providerProfiles[requestedProvider] = toProviderProfile(merged);
    const persisted = { ...merged, providerProfiles };
    // Match connection creation semantics: persist the encrypted credential
    // first. If encryption/storage fails, do not report a configuration change
    // whose required provider key was never saved.
    if (typeof input.apiKey === "string") {
        const trimmed = input.apiKey.trim();
        if (trimmed) {
            await secretsSvc.putSecret(userId, webSearchApiKeySecretForProvider(persisted.provider), trimmed);
        }
        else {
            secretsSvc.deleteSecret(userId, webSearchApiKeySecretForProvider(persisted.provider));
        }
    }
    else if (input.apiKey === null) {
        secretsSvc.deleteSecret(userId, webSearchApiKeySecretForProvider(persisted.provider));
    }
    settingsSvc.putSetting(userId, WEB_SEARCH_SETTINGS_KEY, persisted);
    return getWebSearchSettings(userId);
}
