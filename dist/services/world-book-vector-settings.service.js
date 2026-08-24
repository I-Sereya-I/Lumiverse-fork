import * as settingsSvc from "./settings.service";
import { WORLD_BOOK_VECTOR_SETTINGS_KEY } from "./world-book-vector-constants";
export const WORLD_BOOK_VECTOR_PRESETS = {
    lean: {
        chunkTargetTokens: 220,
        chunkMaxTokens: 360,
        chunkOverlapTokens: 40,
        retrievalTopK: 4,
        maxChunksPerEntry: 4,
    },
    balanced: {
        chunkTargetTokens: 420,
        chunkMaxTokens: 700,
        chunkOverlapTokens: 80,
        retrievalTopK: 6,
        maxChunksPerEntry: 8,
    },
    deep: {
        chunkTargetTokens: 720,
        chunkMaxTokens: 1200,
        chunkOverlapTokens: 120,
        retrievalTopK: 8,
        maxChunksPerEntry: 12,
    },
};
export const DEFAULT_WORLD_BOOK_VECTOR_SETTINGS = {
    presetMode: "balanced",
    ...WORLD_BOOK_VECTOR_PRESETS.balanced,
};
function clampInt(v, min, max, fallback) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(v)));
}
export function normalizeWorldBookVectorSettings(input, defaultsOverride) {
    const base = { ...DEFAULT_WORLD_BOOK_VECTOR_SETTINGS, ...defaultsOverride };
    const presetMode = input?.presetMode === "lean" || input?.presetMode === "balanced" || input?.presetMode === "deep" || input?.presetMode === "custom"
        ? input.presetMode
        : base.presetMode;
    const presetValues = presetMode === "custom"
        ? {
            chunkTargetTokens: clampInt(input?.chunkTargetTokens, 120, 2000, base.chunkTargetTokens),
            chunkMaxTokens: clampInt(input?.chunkMaxTokens, 160, 4000, Math.max(base.chunkMaxTokens, base.chunkTargetTokens)),
            chunkOverlapTokens: clampInt(input?.chunkOverlapTokens, 0, 500, base.chunkOverlapTokens),
            retrievalTopK: clampInt(input?.retrievalTopK, 1, Infinity, base.retrievalTopK),
            maxChunksPerEntry: clampInt(input?.maxChunksPerEntry, 1, 24, base.maxChunksPerEntry),
        }
        : WORLD_BOOK_VECTOR_PRESETS[presetMode];
    const chunkTargetTokens = clampInt(input?.chunkTargetTokens, 120, 2000, presetValues.chunkTargetTokens);
    const chunkMaxTokens = Math.max(chunkTargetTokens, clampInt(input?.chunkMaxTokens, chunkTargetTokens, 4000, Math.max(presetValues.chunkMaxTokens, chunkTargetTokens)));
    return {
        presetMode,
        chunkTargetTokens,
        chunkMaxTokens,
        chunkOverlapTokens: clampInt(input?.chunkOverlapTokens, 0, 500, presetValues.chunkOverlapTokens),
        retrievalTopK: clampInt(input?.retrievalTopK, 1, Infinity, presetValues.retrievalTopK),
        maxChunksPerEntry: clampInt(input?.maxChunksPerEntry, 1, 24, presetValues.maxChunksPerEntry),
    };
}
export function loadWorldBookVectorSettings(userId, defaultsOverride) {
    const raw = settingsSvc.getSetting(userId, WORLD_BOOK_VECTOR_SETTINGS_KEY)?.value;
    return normalizeWorldBookVectorSettings(raw, defaultsOverride);
}
export function saveWorldBookVectorSettings(userId, input, defaultsOverride) {
    const normalized = normalizeWorldBookVectorSettings(input, defaultsOverride);
    settingsSvc.putSetting(userId, WORLD_BOOK_VECTOR_SETTINGS_KEY, normalized);
    return normalized;
}
