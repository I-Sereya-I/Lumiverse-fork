import sharp from "sharp";
import { currentWorkerBudget, deriveThumbnailSharpConcurrency } from "../utils/cpu-budget";
import { getFirstUserId } from "../auth/seed";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";
export const SHARP_SETTINGS_KEY = "sharpSettings";
const cpuDerivedSharpConcurrency = currentWorkerBudget().sharpConcurrency;
const AUTOMATIC_CONCURRENCY = {
    webp: deriveThumbnailSharpConcurrency("webp", cpuDerivedSharpConcurrency),
    avif: deriveThumbnailSharpConcurrency("avif", cpuDerivedSharpConcurrency),
};
const DEFAULT_SHARP_SETTINGS = {
    concurrency: AUTOMATIC_CONCURRENCY.webp,
    cacheMemoryMb: 64,
    cacheFiles: 128,
    cacheItems: 256,
    thumbnailCodec: "webp",
    webpQuality: 80,
    avifQuality: 54,
};
let currentConfiguredSettings = {};
let currentEffectiveSettings = { ...DEFAULT_SHARP_SETTINGS };
let initialized = false;
function clampInteger(value, min, max, label) {
    if (value == null || value === "")
        return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InvalidSettingError(`${label} must be a number or null`);
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function normalizeThumbnailCodec(value) {
    if (value == null || value === "")
        return null;
    if (value !== "webp" && value !== "avif") {
        throw new InvalidSettingError("Thumbnail codec must be webp, avif, or null");
    }
    return value;
}
export function normalizeSharpSettings(input) {
    if (input == null)
        return {};
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new InvalidSettingError("Sharp settings must be an object");
    }
    const raw = input;
    return {
        concurrency: clampInteger(raw.concurrency, 1, 16, "Sharp concurrency"),
        cacheMemoryMb: clampInteger(raw.cacheMemoryMb, 8, 512, "Sharp cache memory"),
        cacheFiles: clampInteger(raw.cacheFiles, 0, 2048, "Sharp cache files"),
        cacheItems: clampInteger(raw.cacheItems, 1, 4096, "Sharp cache items"),
        thumbnailCodec: normalizeThumbnailCodec(raw.thumbnailCodec),
        webpQuality: clampInteger(raw.webpQuality, 1, 100, "WebP thumbnail quality"),
        avifQuality: clampInteger(raw.avifQuality, 1, 100, "AVIF thumbnail quality"),
    };
}
function resolveSharpSettings(configured) {
    const thumbnailCodec = configured?.thumbnailCodec ?? DEFAULT_SHARP_SETTINGS.thumbnailCodec;
    return {
        concurrency: configured?.concurrency ?? AUTOMATIC_CONCURRENCY[thumbnailCodec],
        cacheMemoryMb: configured?.cacheMemoryMb ?? DEFAULT_SHARP_SETTINGS.cacheMemoryMb,
        cacheFiles: configured?.cacheFiles ?? DEFAULT_SHARP_SETTINGS.cacheFiles,
        cacheItems: configured?.cacheItems ?? DEFAULT_SHARP_SETTINGS.cacheItems,
        thumbnailCodec,
        webpQuality: configured?.webpQuality ?? DEFAULT_SHARP_SETTINGS.webpQuality,
        avifQuality: configured?.avifQuality ?? DEFAULT_SHARP_SETTINGS.avifQuality,
    };
}
function applyResolvedSharpSettings(effective) {
    sharp.concurrency(effective.concurrency);
    sharp.cache({
        memory: effective.cacheMemoryMb,
        files: effective.cacheFiles,
        items: effective.cacheItems,
    });
    currentEffectiveSettings = { ...effective };
}
function loadStoredSharpSettings(userId) {
    if (!userId)
        return {};
    const stored = getSetting(userId, SHARP_SETTINGS_KEY)?.value;
    return normalizeSharpSettings(stored);
}
export function applySharpSettings(configured) {
    const normalized = normalizeSharpSettings(configured ?? {});
    currentConfiguredSettings = { ...normalized };
    const effective = resolveSharpSettings(normalized);
    applyResolvedSharpSettings(effective);
    return getSharpSettingsStatus();
}
export function loadAndApplySharpSettings(userId = getFirstUserId()) {
    return applySharpSettings(loadStoredSharpSettings(userId));
}
export function getSharpSettingsStatus() {
    return {
        settingsKey: SHARP_SETTINGS_KEY,
        configuredSettings: { ...currentConfiguredSettings },
        effectiveSettings: { ...currentEffectiveSettings },
        defaults: { ...DEFAULT_SHARP_SETTINGS },
        automaticConcurrency: { ...AUTOMATIC_CONCURRENCY },
    };
}
/** Drop Sharp/libvips caches while keeping the configured limits active for later work. */
export function releaseSharpCacheMemory() {
    const effective = { ...currentEffectiveSettings };
    sharp.cache(false);
    sharp.cache({
        memory: effective.cacheMemoryMb,
        files: effective.cacheFiles,
        items: effective.cacheItems,
    });
}
export function putSharpSettings(userId, input) {
    const normalized = normalizeSharpSettings(input);
    putSetting(userId, SHARP_SETTINGS_KEY, normalized);
    return applySharpSettings(normalized);
}
export function initSharpSettings() {
    if (initialized)
        return;
    initialized = true;
    loadAndApplySharpSettings();
    eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
        const ownerUserId = getFirstUserId();
        if (!ownerUserId || event.userId !== ownerUserId)
            return;
        const payload = event.payload;
        if (!payload)
            return;
        const changed = payload.key === SHARP_SETTINGS_KEY
            || (Array.isArray(payload.keys) && payload.keys.includes(SHARP_SETTINGS_KEY));
        if (!changed)
            return;
        try {
            loadAndApplySharpSettings(ownerUserId);
        }
        catch (err) {
            console.error("[sharp-settings] Failed to apply updated settings:", err);
            applySharpSettings({});
        }
    });
}
applyResolvedSharpSettings(DEFAULT_SHARP_SETTINGS);
export default sharp;
