import { getFirstUserId } from "../auth/seed";
import { DEFAULT_DISK_WARNING_MIN_FREE_BYTES, DEFAULT_DISK_WARNING_USAGE_THRESHOLD, env, } from "../env";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";
export const DISK_WARNING_SETTINGS_KEY = "diskWarningSettings";
const DEFAULT_DISK_WARNING_SETTINGS = {
    usagePercentThreshold: env.diskWarningUsageThreshold ?? DEFAULT_DISK_WARNING_USAGE_THRESHOLD,
    minFreeBytesThreshold: env.diskWarningMinFreeBytes ?? DEFAULT_DISK_WARNING_MIN_FREE_BYTES,
};
let currentConfiguredSettings = {};
let currentEffectiveSettings = { ...DEFAULT_DISK_WARNING_SETTINGS };
let initialized = false;
function normalizeUsageThreshold(value) {
    if (value == null || value === "")
        return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InvalidSettingError("Disk warning usage threshold must be a number or null");
    }
    if (value <= 0) {
        throw new InvalidSettingError("Disk warning usage threshold must be greater than 0");
    }
    const ratio = value <= 1 ? value : value / 100;
    return Math.max(0.01, Math.min(1, ratio));
}
function normalizeMinFreeBytes(value) {
    if (value == null || value === "")
        return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InvalidSettingError("Disk warning minimum free space must be a number or null");
    }
    return Math.max(0, Math.floor(value));
}
export function normalizeDiskWarningSettings(input) {
    if (input == null)
        return {};
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new InvalidSettingError("Disk warning settings must be an object");
    }
    const raw = input;
    return {
        usagePercentThreshold: normalizeUsageThreshold(raw.usagePercentThreshold),
        minFreeBytesThreshold: normalizeMinFreeBytes(raw.minFreeBytesThreshold),
    };
}
function resolveDiskWarningSettings(configured) {
    return {
        usagePercentThreshold: configured?.usagePercentThreshold ?? DEFAULT_DISK_WARNING_SETTINGS.usagePercentThreshold,
        minFreeBytesThreshold: configured?.minFreeBytesThreshold ?? DEFAULT_DISK_WARNING_SETTINGS.minFreeBytesThreshold,
    };
}
function loadStoredDiskWarningSettings(userId) {
    if (!userId)
        return {};
    const stored = getSetting(userId, DISK_WARNING_SETTINGS_KEY)?.value;
    return normalizeDiskWarningSettings(stored);
}
export function applyDiskWarningSettings(configured) {
    const normalized = normalizeDiskWarningSettings(configured ?? {});
    currentConfiguredSettings = { ...normalized };
    currentEffectiveSettings = resolveDiskWarningSettings(normalized);
    return getDiskWarningSettingsStatus();
}
export function loadAndApplyDiskWarningSettings(userId = getFirstUserId()) {
    return applyDiskWarningSettings(loadStoredDiskWarningSettings(userId));
}
export function getDiskWarningSettingsStatus() {
    return {
        settingsKey: DISK_WARNING_SETTINGS_KEY,
        configuredSettings: { ...currentConfiguredSettings },
        effectiveSettings: { ...currentEffectiveSettings },
        defaults: { ...DEFAULT_DISK_WARNING_SETTINGS },
    };
}
export function getEffectiveDiskWarningSettings() {
    return currentEffectiveSettings;
}
export function putDiskWarningSettings(userId, input) {
    const normalized = normalizeDiskWarningSettings(input);
    putSetting(userId, DISK_WARNING_SETTINGS_KEY, normalized);
    return applyDiskWarningSettings(normalized);
}
export function initDiskWarningSettings() {
    if (initialized)
        return;
    initialized = true;
    loadAndApplyDiskWarningSettings();
    eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
        const ownerUserId = getFirstUserId();
        if (!ownerUserId || event.userId !== ownerUserId)
            return;
        const payload = event.payload;
        if (!payload)
            return;
        const changed = payload.key === DISK_WARNING_SETTINGS_KEY
            || (Array.isArray(payload.keys) && payload.keys.includes(DISK_WARNING_SETTINGS_KEY));
        if (!changed)
            return;
        try {
            loadAndApplyDiskWarningSettings(ownerUserId);
        }
        catch (err) {
            console.error("[disk-warning-settings] Failed to apply updated settings:", err);
            applyDiskWarningSettings({});
        }
    });
}
