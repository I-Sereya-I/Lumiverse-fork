/**
 * Memory Cortex — Configuration and settings resolution.
 *
 * The cortex operates at three progressive tiers:
 *   Tier 0: Existing chat_chunks + LanceDB (no cortex involvement)
 *   Tier 1: Heuristic entity extraction + salience scoring (no sidecar needed)
 *   Tier 2: Sidecar-enhanced extraction, scoring, and consolidation
 *
 * v2: Addresses community feedback:
 *   - Three user-facing presets: Simple, Standard, Advanced
 *   - Core memory protection: high-salience memories exempt from decay
 *   - Configurable entity whitelist for fantasy proper nouns
 *   - Entity pruning configuration
 */
import * as settingsSvc from "../settings.service";
import { getDefaultEntityExtractionFilters, normalizeEntityExtractionFilters, } from "./entity-extraction-filters";
const SETTINGS_KEY = "memoryCortexConfig";
// ─── Defaults ──────────────────────────────────────────────────
export const DEFAULT_CONSOLIDATION_CONFIG = {
    enabled: false,
    chunkThreshold: 40,
    chunksPerConsolidation: 10,
    arcThreshold: 5,
    useSidecar: false,
    maxTokensPerSummary: 300,
};
export const DEFAULT_CORTEX_CONFIG = {
    enabled: false,
    autoWarmup: false,
    presetMode: "simple",
    entityTracking: true,
    entityExtractionMode: "heuristic",
    thoughtMarkers: {
        prefix: "",
        suffix: "",
    },
    salienceScoring: true,
    salienceScoringMode: "heuristic",
    queryGeneration: {
        primary: { connectionProfileId: null, model: null },
        secondary: null,
    },
    memorySummarization: {
        primary: { connectionProfileId: null, model: null },
        secondary: null,
    },
    sidecar: {
        connectionProfileId: null,
        model: null,
        temperature: 0.1,
        topP: 1.0,
        maxTokens: 4096,
        chunkBatchSize: 5,
        rebuildConcurrency: 3,
        requestsPerMinute: 0,
    },
    formatterMode: "shadow",
    useChatMemoryFormatting: true,
    contextTokenBudget: 600,
    retrievalTimeoutMs: 60000,
    sidecarTimeoutMs: 60000,
    sidecarReliability: {
        fallback: "heuristic",
        maxRetries: 0,
        retryDelayMs: 500,
        arbitratesHeuristics: false,
        gradesExistingRecords: false,
    },
    consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG },
    retrieval: {
        useFusedScoring: true,
        emotionalResonance: true,
        diversitySelection: true,
        entityContextInjection: true,
        relationshipInjection: false,
        arcInjection: false,
        maxEntitySnapshots: 8,
        maxRelationships: 12,
    },
    decay: {
        halfLifeTurns: 500,
        reinforcementWeight: 0.1,
        coreMemoryThreshold: 0.7,
        coreMemoryFlags: ["death", "promise", "first_meeting", "transformation", "confession"],
    },
    factManagement: {
        importanceThreshold: 3,
        maxFactsPerEntity: 30,
        autopilot: false,
    },
    entityPruning: {
        enabled: true,
        staleAfterMessages: 200,
        minConfidence: 0.4,
    },
    entityWhitelist: [],
    nonProseScaffoldTags: [],
    entityExtractionFilters: getDefaultEntityExtractionFilters(),
};
// ─── Preset Resolvers ──────────────────────────────────────────
/** Apply "simple" preset — minimal knobs, sane defaults */
function applySimplePreset(config) {
    return {
        ...config,
        presetMode: "simple",
        sidecar: { ...config.sidecar, maxTokens: 2048, chunkBatchSize: 3, rebuildConcurrency: 2 },
        entityTracking: true,
        entityExtractionMode: "heuristic",
        salienceScoring: true,
        salienceScoringMode: "heuristic",
        consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG },
        retrieval: {
            useFusedScoring: true,
            emotionalResonance: true,
            diversitySelection: true,
            entityContextInjection: true,
            relationshipInjection: false,
            arcInjection: false,
            maxEntitySnapshots: 8,
            maxRelationships: 12,
        },
    };
}
/** Apply "standard" preset — entities + salience + relationships */
function applyStandardPreset(config) {
    return {
        ...config,
        presetMode: "standard",
        sidecar: { ...config.sidecar, maxTokens: 4096, chunkBatchSize: 5, rebuildConcurrency: 3 },
        entityTracking: true,
        entityExtractionMode: "heuristic",
        salienceScoring: true,
        salienceScoringMode: "heuristic",
        consolidation: {
            ...DEFAULT_CONSOLIDATION_CONFIG,
            enabled: true,
            useSidecar: !!config.sidecar.connectionProfileId,
        },
        retrieval: {
            useFusedScoring: true,
            emotionalResonance: true,
            diversitySelection: true,
            entityContextInjection: true,
            relationshipInjection: true,
            arcInjection: true,
            maxEntitySnapshots: 10,
            maxRelationships: 16,
        },
    };
}
// ─── Settings Resolution ───────────────────────────────────────
// Per-user cortex config cache. Resolving the config requires a settings-table
// read + normalize on every call; the cortex warmup hot path hits this on
// every chat open. Cache entries are invalidated by every write path
// (putCortexConfig, applyCortexPreset). Values are deep-cloned on read so
// callers can't mutate the cached instance.
const cortexConfigCache = new Map();
function invalidateCortexConfigCache(userId) {
    cortexConfigCache.delete(userId);
}
/**
 * Load the cortex configuration for a user.
 * Returns defaults if no config has been saved.
 */
export function getCortexConfig(userId) {
    const cached = cortexConfigCache.get(userId);
    if (cached)
        return structuredClone(cached);
    const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
    const resolved = !row?.value
        ? { ...DEFAULT_CORTEX_CONFIG }
        : normalizeCortexConfig(row.value);
    cortexConfigCache.set(userId, structuredClone(resolved));
    return resolved;
}
/**
 * Whether Memory Cortex is available for an individual chat. A chat may opt
 * out without changing the user's global Cortex configuration. Temporary
 * chats are disposable connection tests, so they never retain or process
 * Cortex data regardless of the user's global setting.
 *
 * Keep regular-chat overrides deliberately narrow: only an explicit `false`
 * disables Cortex, so old chats and malformed/imported metadata continue to
 * inherit the global setting.
 */
export function isCortexEnabledForChat(config, metadata) {
    if (!config.enabled)
        return false;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        return true;
    const chatMetadata = metadata;
    if (chatMetadata.temporary === true)
        return false;
    const settings = chatMetadata.cortex_settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
        return true;
    return settings.enabled !== false;
}
/**
 * Save cortex configuration. Merges with defaults for missing fields.
 */
export function putCortexConfig(userId, update) {
    const current = getCortexConfig(userId);
    const next = { ...current, ...update };
    // Legacy sidecar-only writes: rematerialize both primaries from sidecar
    // and keep any already-configured secondaries.
    if (update.sidecar && !update.queryGeneration && !update.memorySummarization) {
        const migrated = migrateSidecarIntoEndpointPairs(update.sidecar, { secondary: current.queryGeneration.secondary, fallbacks: current.queryGeneration.fallbacks }, { secondary: current.memorySummarization.secondary, fallbacks: current.memorySummarization.fallbacks });
        next.queryGeneration = migrated.queryGeneration;
        next.memorySummarization = migrated.memorySummarization;
    }
    const merged = normalizeCortexConfig(next);
    settingsSvc.putSetting(userId, SETTINGS_KEY, merged);
    invalidateCortexConfigCache(userId);
    return merged;
}
/**
 * Apply a preset mode, returning the resulting full config.
 */
export function applyCortexPreset(userId, mode) {
    let config = getCortexConfig(userId);
    config.enabled = true;
    switch (mode) {
        case "simple":
            config = applySimplePreset(config);
            break;
        case "standard":
            config = applyStandardPreset(config);
            break;
        case "advanced":
            config.presetMode = "advanced";
            // Advanced: keep all current settings, just mark mode
            break;
        default:
            config.presetMode = null;
            break;
    }
    settingsSvc.putSetting(userId, SETTINGS_KEY, config);
    invalidateCortexConfigCache(userId);
    return config;
}
export function emptyCortexModelEndpoint() {
    return { connectionProfileId: null, model: null };
}
export function normalizeCortexModelEndpoint(input, fallback = emptyCortexModelEndpoint()) {
    const connectionProfileId = typeof input?.connectionProfileId === "string" && input.connectionProfileId.trim()
        ? input.connectionProfileId.trim()
        : (input?.connectionProfileId === null
            ? null
            : fallback.connectionProfileId);
    const model = typeof input?.model === "string" && input.model.trim()
        ? input.model.trim()
        : (input?.model === null ? null : fallback.model);
    return { connectionProfileId, model };
}
/** Secondary first, then extra `fallbacks`, de-duplicated by connection id. */
export function listCortexFallbackEndpoints(pair) {
    const extras = [];
    const seen = new Set();
    const push = (input) => {
        const endpoint = normalizeCortexModelEndpoint(input, emptyCortexModelEndpoint());
        if (!endpoint.connectionProfileId || seen.has(endpoint.connectionProfileId))
            return;
        seen.add(endpoint.connectionProfileId);
        extras.push(endpoint);
    };
    push(pair?.secondary);
    for (const extra of pair?.fallbacks ?? [])
        push(extra);
    return extras;
}
export function normalizeCortexModelFallbackPair(input, migratedPrimary) {
    const primary = normalizeCortexModelEndpoint(input?.primary, migratedPrimary);
    const extras = listCortexFallbackEndpoints(input);
    const fallbacks = extras.slice(1);
    return fallbacks.length > 0
        ? { primary, secondary: extras[0] ?? null, fallbacks }
        : { primary, secondary: extras[0] ?? null };
}
/** Sidecar profile/model is the legacy primary; migrate into both pairs. */
export function migrateSidecarIntoEndpointPairs(sidecar, queryGeneration, memorySummarization) {
    const migratedPrimary = normalizeCortexModelEndpoint({
        connectionProfileId: sidecar.connectionProfileId ?? null,
        model: sidecar.model ?? null,
    });
    return {
        queryGeneration: normalizeCortexModelFallbackPair(queryGeneration, migratedPrimary),
        memorySummarization: normalizeCortexModelFallbackPair(memorySummarization, migratedPrimary),
    };
}
function cloneCortexModelFallbackPair(pair) {
    const fallbacks = (pair.fallbacks ?? []).map((endpoint) => ({ ...endpoint }));
    return {
        primary: { ...pair.primary },
        secondary: pair.secondary ? { ...pair.secondary } : null,
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
    };
}
export function listCortexSidecarEndpoints(config) {
    return {
        queryGeneration: cloneCortexModelFallbackPair(config.queryGeneration),
        memorySummarization: cloneCortexModelFallbackPair(config.memorySummarization),
    };
}
/** Lane 5 hook: patch primary/secondary pairs without touching the rest of the config. */
export function updateCortexSidecarEndpoints(userId, patch) {
    const current = getCortexConfig(userId);
    return putCortexConfig(userId, {
        queryGeneration: patch.queryGeneration
            ? normalizeCortexModelFallbackPair(patch.queryGeneration, current.queryGeneration.primary)
            : current.queryGeneration,
        memorySummarization: patch.memorySummarization
            ? normalizeCortexModelFallbackPair(patch.memorySummarization, current.memorySummarization.primary)
            : current.memorySummarization,
    });
}
function firstConfiguredConnectionId(...endpoints) {
    for (const endpoint of endpoints) {
        if (endpoint?.connectionProfileId)
            return endpoint.connectionProfileId;
    }
    return null;
}
export function getCortexSidecarConnectionId(config) {
    return firstConfiguredConnectionId(config.queryGeneration?.primary, ...listCortexFallbackEndpoints(config.queryGeneration), config.memorySummarization?.primary, ...listCortexFallbackEndpoints(config.memorySummarization), {
        connectionProfileId: config.sidecar?.connectionProfileId ?? null,
        model: config.sidecar?.model ?? null,
    });
}
/**
 * True when any Cortex feature is configured to call the sidecar LLM.
 * A saved connection profile alone is not enough: users can keep the profile
 * selected while switching individual Cortex features back to heuristics.
 */
export function shouldUseCortexSidecar(config) {
    return !!getCortexSidecarConnectionId(config) && (config.entityExtractionMode === "sidecar" ||
        config.salienceScoringMode === "sidecar" ||
        (config.consolidation.enabled && config.consolidation.useSidecar));
}
/** True when per-chunk analysis should call the sidecar extractor. */
export function shouldUseCortexSidecarForChunkAnalysis(config) {
    return !!getCortexSidecarConnectionId(config) && (config.entityExtractionMode === "sidecar" ||
        config.salienceScoringMode === "sidecar");
}
/**
 * Normalize a partial config into a full config by merging with defaults.
 */
export function normalizeCortexConfig(input) {
    const defaults = DEFAULT_CORTEX_CONFIG;
    const sidecar = {
        connectionProfileId: input.sidecar?.connectionProfileId ?? defaults.sidecar.connectionProfileId,
        model: input.sidecar?.model ?? defaults.sidecar.model,
        temperature: input.sidecar?.temperature ?? defaults.sidecar.temperature,
        topP: input.sidecar?.topP ?? defaults.sidecar.topP,
        maxTokens: input.sidecar?.maxTokens ?? defaults.sidecar.maxTokens,
        chunkBatchSize: input.sidecar?.chunkBatchSize ?? defaults.sidecar.chunkBatchSize,
        rebuildConcurrency: input.sidecar?.rebuildConcurrency ?? defaults.sidecar.rebuildConcurrency,
        requestsPerMinute: normalizeRequestsPerMinute(input.sidecar?.requestsPerMinute, defaults.sidecar.requestsPerMinute),
    };
    const pairs = migrateSidecarIntoEndpointPairs(sidecar, input.queryGeneration, input.memorySummarization);
    // Keep the legacy sidecar primary in sync with query-generation primary so
    // older readers still see the selected connection after a pair-only write.
    if (pairs.queryGeneration.primary.connectionProfileId || pairs.queryGeneration.primary.model) {
        sidecar.connectionProfileId = pairs.queryGeneration.primary.connectionProfileId;
        sidecar.model = pairs.queryGeneration.primary.model;
    }
    return {
        enabled: input.enabled ?? defaults.enabled,
        autoWarmup: input.autoWarmup ?? defaults.autoWarmup,
        presetMode: input.presetMode ?? defaults.presetMode,
        entityTracking: input.entityTracking ?? defaults.entityTracking,
        entityExtractionMode: input.entityExtractionMode ?? defaults.entityExtractionMode,
        thoughtMarkers: {
            prefix: input.thoughtMarkers?.prefix ?? defaults.thoughtMarkers.prefix,
            suffix: input.thoughtMarkers?.suffix ?? defaults.thoughtMarkers.suffix,
        },
        salienceScoring: input.salienceScoring ?? defaults.salienceScoring,
        salienceScoringMode: input.salienceScoringMode ?? defaults.salienceScoringMode,
        queryGeneration: pairs.queryGeneration,
        memorySummarization: pairs.memorySummarization,
        sidecar,
        formatterMode: input.formatterMode ?? defaults.formatterMode,
        useChatMemoryFormatting: typeof input.useChatMemoryFormatting === "boolean"
            ? input.useChatMemoryFormatting
            : defaults.useChatMemoryFormatting,
        contextTokenBudget: input.contextTokenBudget ?? defaults.contextTokenBudget,
        retrievalTimeoutMs: input.retrievalTimeoutMs ?? defaults.retrievalTimeoutMs,
        sidecarTimeoutMs: input.sidecarTimeoutMs ?? defaults.sidecarTimeoutMs,
        sidecarReliability: {
            fallback: input.sidecarReliability?.fallback === "skip" ? "skip" : defaults.sidecarReliability.fallback,
            maxRetries: normalizeNonNegativeInt(input.sidecarReliability?.maxRetries, defaults.sidecarReliability.maxRetries),
            retryDelayMs: normalizeNonNegativeInt(input.sidecarReliability?.retryDelayMs, defaults.sidecarReliability.retryDelayMs),
            arbitratesHeuristics: input.sidecarReliability?.arbitratesHeuristics
                ?? defaults.sidecarReliability.arbitratesHeuristics,
            gradesExistingRecords: input.sidecarReliability?.gradesExistingRecords
                ?? defaults.sidecarReliability.gradesExistingRecords,
        },
        consolidation: {
            enabled: input.consolidation?.enabled ?? defaults.consolidation.enabled,
            chunkThreshold: input.consolidation?.chunkThreshold ?? defaults.consolidation.chunkThreshold,
            chunksPerConsolidation: input.consolidation?.chunksPerConsolidation ?? defaults.consolidation.chunksPerConsolidation,
            arcThreshold: input.consolidation?.arcThreshold ?? defaults.consolidation.arcThreshold,
            useSidecar: input.consolidation?.useSidecar ?? defaults.consolidation.useSidecar,
            maxTokensPerSummary: input.consolidation?.maxTokensPerSummary ?? defaults.consolidation.maxTokensPerSummary,
        },
        retrieval: {
            useFusedScoring: input.retrieval?.useFusedScoring ?? defaults.retrieval.useFusedScoring,
            emotionalResonance: input.retrieval?.emotionalResonance ?? defaults.retrieval.emotionalResonance,
            diversitySelection: input.retrieval?.diversitySelection ?? defaults.retrieval.diversitySelection,
            entityContextInjection: input.retrieval?.entityContextInjection ?? defaults.retrieval.entityContextInjection,
            relationshipInjection: input.retrieval?.relationshipInjection ?? defaults.retrieval.relationshipInjection,
            arcInjection: input.retrieval?.arcInjection ?? defaults.retrieval.arcInjection,
            maxEntitySnapshots: input.retrieval?.maxEntitySnapshots ?? defaults.retrieval.maxEntitySnapshots,
            maxRelationships: input.retrieval?.maxRelationships ?? defaults.retrieval.maxRelationships,
        },
        decay: {
            halfLifeTurns: input.decay?.halfLifeTurns ?? defaults.decay.halfLifeTurns,
            reinforcementWeight: input.decay?.reinforcementWeight ?? defaults.decay.reinforcementWeight,
            coreMemoryThreshold: input.decay?.coreMemoryThreshold ?? defaults.decay.coreMemoryThreshold,
            coreMemoryFlags: input.decay?.coreMemoryFlags ?? defaults.decay.coreMemoryFlags,
        },
        factManagement: {
            importanceThreshold: Math.max(0, Math.min(10, typeof input.factManagement?.importanceThreshold === "number"
                ? Math.floor(input.factManagement.importanceThreshold)
                : defaults.factManagement.importanceThreshold)),
            maxFactsPerEntity: Math.max(5, Math.min(100, typeof input.factManagement?.maxFactsPerEntity === "number"
                ? Math.floor(input.factManagement.maxFactsPerEntity)
                : defaults.factManagement.maxFactsPerEntity)),
            autopilot: input.factManagement?.autopilot ?? defaults.factManagement.autopilot,
        },
        entityPruning: {
            enabled: input.entityPruning?.enabled ?? defaults.entityPruning.enabled,
            staleAfterMessages: input.entityPruning?.staleAfterMessages ?? defaults.entityPruning.staleAfterMessages,
            minConfidence: input.entityPruning?.minConfidence ?? defaults.entityPruning.minConfidence,
        },
        entityWhitelist: input.entityWhitelist ?? defaults.entityWhitelist,
        nonProseScaffoldTags: Array.isArray(input.nonProseScaffoldTags)
            ? input.nonProseScaffoldTags
                .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
                .filter((s) => s.length > 0 && /^[a-z0-9_]+$/.test(s))
            : defaults.nonProseScaffoldTags,
        entityExtractionFilters: normalizeEntityExtractionFilters(input.entityExtractionFilters),
    };
}
function normalizeRequestsPerMinute(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
function normalizeNonNegativeInt(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
