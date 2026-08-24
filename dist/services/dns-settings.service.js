import { getFirstUserId } from "../auth/seed";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";
export const DNS_SETTINGS_KEY = "dnsSettings";
const DEFAULT_DNS_SETTINGS = {
    dohFallbackEnabled: false,
    // IP literal so the DoH lookup itself doesn't require DNS. Cloudflare's
    // cert covers both `1.1.1.1` and `cloudflare-dns.com`, so TLS verifies.
    dohEndpoint: "https://1.1.1.1/dns-query",
};
let currentConfiguredSettings = {};
let currentEffectiveSettings = { ...DEFAULT_DNS_SETTINGS };
let initialized = false;
function normalizeEndpoint(value) {
    if (value == null || value === "")
        return null;
    if (typeof value !== "string") {
        throw new InvalidSettingError("DoH endpoint must be a string");
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new InvalidSettingError("DoH endpoint is not a valid URL");
    }
    if (parsed.protocol !== "https:") {
        throw new InvalidSettingError("DoH endpoint must use https://");
    }
    return parsed.toString();
}
export function normalizeDnsSettings(input) {
    if (input == null)
        return {};
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new InvalidSettingError("DNS settings must be an object");
    }
    const raw = input;
    const out = {};
    if (raw.dohFallbackEnabled != null) {
        if (typeof raw.dohFallbackEnabled !== "boolean") {
            throw new InvalidSettingError("dohFallbackEnabled must be a boolean");
        }
        out.dohFallbackEnabled = raw.dohFallbackEnabled;
    }
    const endpoint = normalizeEndpoint(raw.dohEndpoint);
    if (endpoint)
        out.dohEndpoint = endpoint;
    return out;
}
function resolveDnsSettings(configured) {
    return {
        dohFallbackEnabled: configured?.dohFallbackEnabled ?? DEFAULT_DNS_SETTINGS.dohFallbackEnabled,
        dohEndpoint: configured?.dohEndpoint ?? DEFAULT_DNS_SETTINGS.dohEndpoint,
    };
}
function loadStoredDnsSettings(userId) {
    if (!userId)
        return {};
    const stored = getSetting(userId, DNS_SETTINGS_KEY)?.value;
    return normalizeDnsSettings(stored);
}
export function applyDnsSettings(configured) {
    const normalized = normalizeDnsSettings(configured ?? {});
    currentConfiguredSettings = { ...normalized };
    currentEffectiveSettings = resolveDnsSettings(normalized);
    return getDnsSettingsStatus();
}
export function loadAndApplyDnsSettings(userId = getFirstUserId()) {
    return applyDnsSettings(loadStoredDnsSettings(userId));
}
export function getDnsSettingsStatus() {
    return {
        settingsKey: DNS_SETTINGS_KEY,
        configuredSettings: { ...currentConfiguredSettings },
        effectiveSettings: { ...currentEffectiveSettings },
        defaults: { ...DEFAULT_DNS_SETTINGS },
    };
}
/**
 * Read-only accessor for the current effective settings. safe-fetch.ts calls
 * this on every validation to pick up live changes without having to subscribe
 * to events itself.
 */
export function getEffectiveDnsSettings() {
    return currentEffectiveSettings;
}
export function putDnsSettings(userId, input) {
    const normalized = normalizeDnsSettings(input);
    putSetting(userId, DNS_SETTINGS_KEY, normalized);
    return applyDnsSettings(normalized);
}
export function initDnsSettings() {
    if (initialized)
        return;
    initialized = true;
    loadAndApplyDnsSettings();
    eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
        const ownerUserId = getFirstUserId();
        if (!ownerUserId || event.userId !== ownerUserId)
            return;
        const payload = event.payload;
        if (!payload)
            return;
        const changed = payload.key === DNS_SETTINGS_KEY
            || (Array.isArray(payload.keys) && payload.keys.includes(DNS_SETTINGS_KEY));
        if (!changed)
            return;
        try {
            loadAndApplyDnsSettings(ownerUserId);
        }
        catch (err) {
            console.error("[dns-settings] Failed to apply updated settings:", err);
            applyDnsSettings({});
        }
    });
}
