/**
 * Vector-store provider configuration (owner-gated, global).
 *
 * Distinct from `embeddingConfig` (the embedding MODEL) — this selects the
 * vector DATABASE backend (lancedb | qdrant | milvus) and its connection. The
 * store is shared server infrastructure, so it is OWNER-ONLY and GLOBAL: there
 * is no per-user fallback (unlike embeddingConfig). Absent config resolves to
 * LanceDB, guaranteeing zero migration for existing installs.
 *
 * Resolution order (see {@link getResolvedVectorStoreConfig}):
 *   env override  >  owner's stored vectorStoreConfig  >  lancedb default
 *
 * Connection credentials (Qdrant api key, Milvus password) live in the
 * encrypted secrets table, never in the settings JSON.
 */
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import { getFirstUserId } from "../auth/seed";
import { getDb } from "../db/connection";
import { env } from "../env";
import { worldBookVectorDesiredStatusSql, worldBookVectorStateDriftSql, } from "./world-book-vector-state";
export const VECTOR_STORE_CONFIG_KEY = "vectorStoreConfig";
const QDRANT_API_KEY_SECRET = "vector_store_secret_qdrant_api_key";
const MILVUS_PASSWORD_SECRET = "vector_store_secret_milvus_password";
const VALID_PROVIDERS = ["lancedb", "qdrant", "milvus"];
const VALID_TUNING_PROFILES = ["balanced", "low_latency", "low_memory", "bulk_reindex"];
const REINDEX_MARK_BATCH_SIZE = 1_000;
export function defaultVectorStoreConfig() {
    return { provider: "lancedb" };
}
function getStoredVectorStoreConfig(ownerId) {
    const raw = settingsSvc.getSetting(ownerId, VECTOR_STORE_CONFIG_KEY)?.value;
    return raw ? normalizeVectorStoreConfig(raw) : defaultVectorStoreConfig();
}
function hasVectorStoreProviderOrConnectionFields(input) {
    return input.provider !== undefined
        || input.qdrant !== undefined
        || input.milvus !== undefined
        || input.qdrant_api_key !== undefined
        || input.milvus_password !== undefined;
}
function isValidProvider(p) {
    return typeof p === "string" && VALID_PROVIDERS.includes(p);
}
function normalizeTuningProfile(input) {
    return typeof input === "string" && VALID_TUNING_PROFILES.includes(input)
        ? input
        : undefined;
}
function normalizeMilvusConnectTimeoutMs(input) {
    if (typeof input !== "number" || !Number.isFinite(input))
        return undefined;
    return Math.min(60_000, Math.max(1_000, Math.floor(input)));
}
function normalizeMilvusRequestTimeoutMs(input) {
    if (typeof input !== "number" || !Number.isFinite(input) || input < 0)
        return undefined;
    return Math.min(300_000, Math.floor(input));
}
function normalizeMilvusHybridCandidateMultiplier(input) {
    if (typeof input !== "number" || !Number.isFinite(input))
        return undefined;
    return Math.min(10, Math.max(1, Math.floor(input)));
}
function normalizeMilvusHybridCandidateCap(input) {
    if (typeof input !== "number" || !Number.isFinite(input))
        return undefined;
    return Math.min(2_000, Math.max(1, Math.floor(input)));
}
function normalizeMilvusHybridSearchConfig(input) {
    if (!input || typeof input !== "object")
        return undefined;
    const candidateMultiplier = normalizeMilvusHybridCandidateMultiplier(input.candidateMultiplier);
    const candidateCap = normalizeMilvusHybridCandidateCap(input.candidateCap);
    if (candidateMultiplier === undefined && candidateCap === undefined)
        return undefined;
    return { candidateMultiplier, candidateCap };
}
export function normalizeVectorStoreConfig(input) {
    const provider = isValidProvider(input?.provider) ? input.provider : "lancedb";
    const out = { provider };
    const tuningProfile = normalizeTuningProfile(input?.tuningProfile);
    if (tuningProfile)
        out.tuningProfile = tuningProfile;
    const q = input?.qdrant;
    if (q && typeof q === "object" && typeof q.url === "string" && q.url.trim()) {
        out.qdrant = {
            url: q.url.trim().replace(/\/+$/, ""),
            https: q.https !== undefined ? !!q.https : undefined,
            collectionPrefix: typeof q.collectionPrefix === "string" && q.collectionPrefix.trim()
                ? q.collectionPrefix.trim()
                : undefined,
            checkCompatibility: q.checkCompatibility !== undefined ? !!q.checkCompatibility : undefined,
        };
    }
    const m = input?.milvus;
    if (m && typeof m === "object" && typeof m.address === "string" && m.address.trim()) {
        out.milvus = {
            address: m.address.trim(),
            ssl: m.ssl !== undefined ? !!m.ssl : undefined,
            database: typeof m.database === "string" && m.database.trim() ? m.database.trim() : undefined,
            username: typeof m.username === "string" && m.username.trim() ? m.username.trim() : undefined,
            transport: m.transport === "http" ? "http" : "grpc",
            connectTimeoutMs: normalizeMilvusConnectTimeoutMs(m.connectTimeoutMs),
            requestTimeoutMs: normalizeMilvusRequestTimeoutMs(m.requestTimeoutMs),
        };
    }
    const milvusHybridSearch = normalizeMilvusHybridSearchConfig(input?.milvusHybridSearch);
    if (milvusHybridSearch)
        out.milvusHybridSearch = milvusHybridSearch;
    return out;
}
/** The env-override config, or null when `LUMIVERSE_VECTOR_STORE_PROVIDER` is unset/invalid. */
function envVectorStoreConfig() {
    const provider = env.vectorStore.provider;
    if (!provider || !isValidProvider(provider))
        return null;
    const cfg = { provider };
    if (provider === "qdrant" && env.vectorStore.qdrantUrl) {
        cfg.qdrant = { url: env.vectorStore.qdrantUrl.replace(/\/+$/, "") };
    }
    if (provider === "milvus" && env.vectorStore.milvusAddress) {
        cfg.milvus = {
            address: env.vectorStore.milvusAddress,
            ssl: env.vectorStore.milvusSsl,
            username: env.vectorStore.milvusUsername || undefined,
            connectTimeoutMs: env.vectorStore.milvusConnectTimeoutMs,
            requestTimeoutMs: env.vectorStore.milvusRequestTimeoutMs,
        };
    }
    return cfg;
}
/** True when the active backend is forced by environment variables. */
export function isVectorStoreEnvManaged() {
    return envVectorStoreConfig() != null;
}
/**
 * Resolve the active vector-store config: env override > owner setting > default.
 * Synchronous (no secrets). Used by the factory to pick the provider.
 */
export function getResolvedVectorStoreConfig() {
    const fromEnv = envVectorStoreConfig();
    const ownerId = getFirstUserId();
    if (fromEnv) {
        if (!ownerId)
            return fromEnv;
        const stored = getStoredVectorStoreConfig(ownerId);
        return normalizeVectorStoreConfig({
            ...fromEnv,
            tuningProfile: stored.tuningProfile ?? fromEnv.tuningProfile,
            milvusHybridSearch: stored.milvusHybridSearch ?? fromEnv.milvusHybridSearch,
        });
    }
    if (!ownerId)
        return defaultVectorStoreConfig();
    return getStoredVectorStoreConfig(ownerId);
}
/** Connection secrets for the active provider (env override > owner secrets). */
export async function getVectorStoreConnectionSecrets() {
    if (isVectorStoreEnvManaged()) {
        return {
            qdrantApiKey: env.vectorStore.qdrantApiKey || null,
            milvusPassword: env.vectorStore.milvusPassword || null,
        };
    }
    const ownerId = getFirstUserId();
    if (!ownerId)
        return { qdrantApiKey: null, milvusPassword: null };
    const [qdrantApiKey, milvusPassword] = await Promise.all([
        secretsSvc.getSecret(ownerId, QDRANT_API_KEY_SECRET),
        secretsSvc.getSecret(ownerId, MILVUS_PASSWORD_SECRET),
    ]);
    return { qdrantApiKey, milvusPassword };
}
/** API view of the active config + key-presence flags (never the secrets). */
export async function getVectorStoreConfigForApi() {
    const cfg = getResolvedVectorStoreConfig();
    const managedByEnv = isVectorStoreEnvManaged();
    let qdrantHasApiKey = false;
    let milvusHasPassword = false;
    if (managedByEnv) {
        qdrantHasApiKey = !!env.vectorStore.qdrantApiKey;
        milvusHasPassword = !!env.vectorStore.milvusPassword;
    }
    else {
        const ownerId = getFirstUserId();
        if (ownerId) {
            qdrantHasApiKey = !!(await secretsSvc.getSecretForStatus(ownerId, QDRANT_API_KEY_SECRET));
            milvusHasPassword = !!(await secretsSvc.getSecretForStatus(ownerId, MILVUS_PASSWORD_SECRET));
        }
    }
    return { ...cfg, managedByEnv, qdrantHasApiKey, milvusHasPassword };
}
/** Throw if the caller is not the server owner. */
export function assertVectorStoreOwner(userId) {
    const ownerId = getFirstUserId();
    if (ownerId && ownerId !== userId) {
        throw new Error("Vector store configuration is managed by the server owner.");
    }
}
function validateVectorStoreRuntimeTuningInput(input) {
    if (input.tuningProfile !== undefined && !normalizeTuningProfile(input.tuningProfile)) {
        throw new Error("Invalid vector store tuning profile.");
    }
    if (input.milvusHybridSearch !== undefined && !normalizeMilvusHybridSearchConfig(input.milvusHybridSearch)) {
        throw new Error("Invalid Milvus hybrid candidate tuning.");
    }
}
function mergeStoredVectorStoreRuntimeTuning(stored, input) {
    return normalizeVectorStoreConfig({
        ...stored,
        ...(input.tuningProfile !== undefined ? { tuningProfile: input.tuningProfile } : {}),
        ...(input.milvusHybridSearch !== undefined ? { milvusHybridSearch: input.milvusHybridSearch } : {}),
    });
}
/**
 * Persist a new vector-store config (owner-only). Writes secrets to the
 * encrypted store, persists the JSON config, and drops the cached active store
 * so the next operation reconstructs against the new provider. Does NOT
 * re-embed — call {@link markVectorStoreStaleForReindex} (or the /switch route)
 * for that.
 */
export async function updateVectorStoreConfig(userId, input) {
    assertVectorStoreOwner(userId);
    const ownerId = getFirstUserId() ?? userId;
    if (isVectorStoreEnvManaged()) {
        if (hasVectorStoreProviderOrConnectionFields(input)) {
            throw new Error("Vector store provider and connection are managed by environment variables and cannot be changed at runtime.");
        }
        validateVectorStoreRuntimeTuningInput(input);
        settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, mergeStoredVectorStoreRuntimeTuning(getStoredVectorStoreConfig(ownerId), input));
        // Break the static import cycle (index.ts imports this service).
        const { resetActiveVectorStore } = await import("./vector-store");
        resetActiveVectorStore();
        return getVectorStoreConfigForApi();
    }
    if (!hasVectorStoreProviderOrConnectionFields(input)) {
        validateVectorStoreRuntimeTuningInput(input);
        settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, mergeStoredVectorStoreRuntimeTuning(getStoredVectorStoreConfig(ownerId), input));
        // Break the static import cycle (index.ts imports this service).
        const { resetActiveVectorStore } = await import("./vector-store");
        resetActiveVectorStore();
        return getVectorStoreConfigForApi();
    }
    const previous = getResolvedVectorStoreConfig();
    const normalized = normalizeVectorStoreConfig(input);
    if (input.qdrant_api_key !== undefined) {
        if (!input.qdrant_api_key)
            secretsSvc.deleteSecret(ownerId, QDRANT_API_KEY_SECRET);
        else
            await secretsSvc.putSecret(ownerId, QDRANT_API_KEY_SECRET, input.qdrant_api_key);
    }
    else if (normalized.provider === "qdrant"
        && !hasSameVectorStoreCredentialTarget(normalized, previous, "qdrant")) {
        // Never carry a key across endpoints. The replacement target must either
        // be reachable without a key or receive a new key explicitly.
        secretsSvc.deleteSecret(ownerId, QDRANT_API_KEY_SECRET);
    }
    if (input.milvus_password !== undefined) {
        if (!input.milvus_password)
            secretsSvc.deleteSecret(ownerId, MILVUS_PASSWORD_SECRET);
        else
            await secretsSvc.putSecret(ownerId, MILVUS_PASSWORD_SECRET, input.milvus_password);
    }
    else if (normalized.provider === "milvus"
        && !hasSameVectorStoreCredentialTarget(normalized, previous, "milvus")) {
        // A Milvus password is scoped to its transport, server, database, and
        // username. Do not silently attach it to a different authentication scope.
        secretsSvc.deleteSecret(ownerId, MILVUS_PASSWORD_SECRET);
    }
    settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, normalized);
    // Break the static import cycle (index.ts imports this service).
    const { resetActiveVectorStore } = await import("./vector-store");
    resetActiveVectorStore();
    return getVectorStoreConfigForApi();
}
/** True when a candidate uses the exact authentication target of the active config. */
export function hasSameVectorStoreCredentialTarget(candidate, active, provider) {
    if (candidate.provider !== provider || active.provider !== provider)
        return false;
    if (provider === "qdrant") {
        return !!candidate.qdrant?.url
            && candidate.qdrant.url === active.qdrant?.url;
    }
    const candidateMilvus = candidate.milvus;
    const activeMilvus = active.milvus;
    return !!candidateMilvus?.address
        && candidateMilvus.address === activeMilvus?.address
        && (candidateMilvus.ssl ?? false) === (activeMilvus?.ssl ?? false)
        && (candidateMilvus.transport ?? "grpc") === (activeMilvus?.transport ?? "grpc")
        && (candidateMilvus.database ?? "") === (activeMilvus?.database ?? "")
        && (candidateMilvus.username ?? "") === (activeMilvus?.username ?? "");
}
/** Resolve secrets for a candidate test/switch. A supplied secret always wins;
 * stored secrets are reused only for the exact active authentication target. */
async function resolveCandidateSecrets(input, candidate) {
    const active = getResolvedVectorStoreConfig();
    const reuseQdrant = input.qdrant_api_key === undefined
        && hasSameVectorStoreCredentialTarget(candidate, active, "qdrant");
    const reuseMilvus = input.milvus_password === undefined
        && hasSameVectorStoreCredentialTarget(candidate, active, "milvus");
    const stored = reuseQdrant || reuseMilvus
        ? await getVectorStoreConnectionSecrets()
        : { qdrantApiKey: null, milvusPassword: null };
    return {
        qdrantApiKey: input.qdrant_api_key !== undefined
            ? (input.qdrant_api_key || null)
            : (reuseQdrant ? stored.qdrantApiKey : null),
        milvusPassword: input.milvus_password !== undefined
            ? (input.milvus_password || null)
            : (reuseMilvus ? stored.milvusPassword : null),
    };
}
/**
 * Build a candidate store from the supplied config (without persisting) and run
 * its `init()` reachability/version probe. Used by the operator UI before
 * committing a provider switch.
 */
export async function testVectorStoreConnection(userId, input) {
    assertVectorStoreOwner(userId);
    const config = normalizeVectorStoreConfig(input);
    try {
        const secrets = await resolveCandidateSecrets(input, config);
        const { buildVectorStore } = await import("./vector-store");
        const store = await buildVectorStore(config, secrets);
        await store.init();
        await store.close();
        return { ok: true, provider: config.provider };
    }
    catch (err) {
        return { ok: false, provider: config.provider, error: err?.message || "Connection test failed" };
    }
}
let staleMarkingPromise = null;
function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
async function updateRowsInChunks(table, idColumn, selectWhere, updateSql) {
    let total = 0;
    while (true) {
        const ids = getDb().query(`SELECT ${idColumn} AS id FROM ${table} WHERE ${selectWhere} LIMIT ?`).all(REINDEX_MARK_BATCH_SIZE);
        if (ids.length === 0)
            break;
        const placeholders = ids.map(() => "?").join(", ");
        getDb().query(`${updateSql} WHERE ${idColumn} IN (${placeholders})`).run(...ids.map((row) => row.id));
        total += ids.length;
        await yieldToEventLoop();
        if (ids.length < REINDEX_MARK_BATCH_SIZE)
            break;
    }
    return total;
}
async function deleteRowsInChunks(table, idColumn) {
    let total = 0;
    while (true) {
        const ids = getDb().query(`SELECT ${idColumn} AS id FROM ${table} LIMIT ?`).all(REINDEX_MARK_BATCH_SIZE);
        if (ids.length === 0)
            break;
        const placeholders = ids.map(() => "?").join(", ");
        const result = getDb().query(`DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})`).run(...ids.map((row) => row.id));
        total += result.changes ?? ids.length;
        await yieldToEventLoop();
        if (ids.length < REINDEX_MARK_BATCH_SIZE)
            break;
    }
    return total;
}
function scheduleVectorStoreStaleMarking() {
    if (staleMarkingPromise)
        return true;
    staleMarkingPromise = (async () => {
        try {
            const worldBooks = await updateRowsInChunks("world_book_entries", "id", worldBookVectorStateDriftSql(), `UPDATE world_book_entries
         SET vector_index_status = ${worldBookVectorDesiredStatusSql()},
             vector_indexed_at = NULL,
             vector_index_error = NULL`);
            const chatChunks = await updateRowsInChunks("chat_chunks", "id", `vectorized_at IS NOT NULL OR vector_model IS NOT NULL`, `UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL`);
            const queryCache = await deleteRowsInChunks("query_vector_cache", "id");
            const chatMemoryCache = await deleteRowsInChunks("chat_memory_cache", "id");
            const { queueStaleChatChunkVectorization } = await import("./vectorization-queue.service");
            const queuedChatChunks = await queueStaleChatChunkVectorization();
            const { embeddingCache } = await import("./embedding-cache");
            embeddingCache.clear();
            console.info(`[vector-store] Marked vectors stale after provider switch: world_books=${worldBooks}, chat_chunks=${chatChunks}, query_cache=${queryCache}, chat_memory_cache=${chatMemoryCache}, queued_chat_chunks=${queuedChatChunks}`);
        }
        catch (err) {
            console.warn("[vector-store] Failed to mark content stale after provider switch:", err);
        }
        finally {
            staleMarkingPromise = null;
        }
    })();
    staleMarkingPromise.catch(() => { });
    return true;
}
/**
 * Switch the active vector-store provider (owner-only) with validate-before-commit:
 * construct + init the candidate FIRST (reject without persisting if unreachable
 * or the optional dep is missing), then persist, drop the cached store, and mark
 * all derived content stale so the existing reindexers + vectorization queue
 * lazily re-embed from SQLite into the new backend. Vectors are never migrated.
 */
export async function switchVectorStoreProvider(userId, input) {
    assertVectorStoreOwner(userId);
    if (isVectorStoreEnvManaged()) {
        throw new Error("Vector store configuration is managed by environment variables and cannot be changed at runtime.");
    }
    // 1. Validate-before-commit: build + probe the candidate before touching settings.
    const candidateConfig = normalizeVectorStoreConfig(input);
    const candidateSecrets = await resolveCandidateSecrets(input, candidateConfig);
    const { buildVectorStore } = await import("./vector-store");
    const candidate = await buildVectorStore(candidateConfig, candidateSecrets);
    await candidate.init();
    await candidate.close();
    // 2. Commit (persists secrets + config, drops the cached active store).
    const status = await updateVectorStoreConfig(userId, input);
    // 3. Mark all derived content stale in the background. This can touch many
    // rows on large installs; doing it synchronously stalls Bun's event loop and
    // can make the frontend websocket heartbeat think the server disconnected.
    const reindexScheduled = scheduleVectorStoreStaleMarking();
    return { ...status, reindexScheduled };
}
