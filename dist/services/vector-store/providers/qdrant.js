import { createHash } from "node:crypto";
import { QDRANT_CAPABILITIES } from "../capabilities";
const DEFAULT_PREFIX = "lumiverse_";
const UUID_NAMESPACE = "6f216f13-4f8f-4b45-9d2b-8e826a57e8e2";
const PAYLOAD_FIELDS = ["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "metadata_json", "updated_at"];
const PAYLOAD_INDEXES = [
    { field: "id", schema: "keyword" },
    { field: "user_id", schema: "keyword" },
    { field: "source_type", schema: "keyword" },
    { field: "source_id", schema: "keyword" },
    { field: "owner_id", schema: "keyword" },
    { field: "chunk_index", schema: "integer" },
];
export class QdrantStore {
    id = "qdrant";
    capabilities = QDRANT_CAPABILITIES;
    baseUrl;
    apiKey;
    prefix;
    tuningProfile;
    initialized = false;
    constructor(config, apiKey, tuningProfile) {
        if (!config?.url) {
            throw new Error("Qdrant vector store requires qdrant.url (or LUMIVERSE_QDRANT_URL).");
        }
        this.baseUrl = config.url.replace(/\/+$/, "");
        this.apiKey = apiKey;
        this.prefix = sanitizeCollectionPrefix(config.collectionPrefix || DEFAULT_PREFIX);
        this.tuningProfile = tuningProfile || "balanced";
    }
    async init() {
        if (this.initialized)
            return;
        await this.request("/collections", { method: "GET" });
        this.initialized = true;
    }
    async ensureCollection(collection, dimension) {
        const existing = await this.getStoredDimension(collection);
        if (existing != null) {
            if (existing !== dimension) {
                throw new Error(`Qdrant collection ${this.collectionName(collection)} has dimension ${existing}, expected ${dimension}. Reindex with a matching embedding model or reset the vector store.`);
            }
            await this.ensurePayloadIndexes(collection);
            await this.applyCollectionTuning(collection).catch(() => { });
            return;
        }
        const tuning = qdrantTuning(this.tuningProfile);
        await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, {
            method: "PUT",
            body: {
                vectors: { size: dimension, distance: "Cosine" },
                on_disk_payload: true,
                hnsw_config: tuning.hnswConfig,
                optimizers_config: tuning.optimizersConfig,
                quantization_config: tuning.quantizationConfig,
            },
        });
        await this.ensurePayloadIndexes(collection);
    }
    async getStoredDimension(collection) {
        const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, { method: "GET", allow404: true });
        if (!res)
            return null;
        const vectors = res?.result?.config?.params?.vectors;
        if (typeof vectors?.size === "number")
            return vectors.size;
        if (vectors && typeof vectors === "object") {
            for (const value of Object.values(vectors)) {
                if (typeof value?.size === "number")
                    return value.size;
            }
        }
        return null;
    }
    async upsert(collection, rows) {
        if (rows.length === 0)
            return;
        await this.ensureCollection(collection, rows[0].vector.length);
        for (let i = 0; i < rows.length; i += 128) {
            const batch = rows.slice(i, i + 128);
            const response = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points?wait=true`, {
                method: "PUT",
                body: {
                    points: batch.map((row) => ({
                        id: qdrantPointId(row.id),
                        vector: row.vector,
                        payload: rowToPayload(row),
                    })),
                },
            });
            const updateStatus = response?.result?.status;
            if (updateStatus !== "completed") {
                throw new Error(`Qdrant upsert did not complete for ${this.collectionName(collection)} (status=${String(updateStatus ?? "missing")})`);
            }
        }
    }
    async getRowsByFilter(collection, filter, limit = 10_000) {
        const out = [];
        let offset = undefined;
        while (out.length < limit) {
            const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/scroll`, {
                method: "POST",
                allow404: true,
                body: {
                    filter: translateFilter(filter),
                    limit: Math.min(256, limit - out.length),
                    offset,
                    with_payload: true,
                    with_vector: true,
                },
            });
            if (!res)
                return out;
            const points = Array.isArray(res?.result?.points) ? res.result.points : [];
            for (const point of points) {
                const row = pointToVectorRow(point);
                if (row)
                    out.push(row);
            }
            offset = res?.result?.next_page_offset;
            if (!offset || points.length === 0)
                break;
        }
        return out;
    }
    async deleteByFilter(collection, filter) {
        await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/delete?wait=true`, {
            method: "POST",
            allow404: true,
            body: { filter: translateFilter(filter) },
        });
    }
    async deleteByIds(collection, ids) {
        if (ids.length === 0)
            return;
        await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/delete?wait=true`, {
            method: "POST",
            allow404: true,
            body: { points: ids.map(qdrantPointId) },
        });
    }
    async vectorSearch(opts) {
        if (opts.signal?.aborted)
            return [];
        const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(opts.collection))}/points/search`, {
            method: "POST",
            allow404: true,
            signal: opts.signal,
            body: {
                vector: opts.vector,
                filter: translateFilter(opts.filter),
                limit: opts.limit,
                params: qdrantTuning(this.tuningProfile).searchParams,
                with_payload: true,
                with_vector: opts.withVector,
            },
        });
        if (!res || opts.signal?.aborted)
            return [];
        const hits = Array.isArray(res?.result) ? res.result : [];
        return hits.map((hit) => pointToHit(hit, opts.withVector)).filter((hit) => hit != null);
    }
    async lexicalSearch(_opts) {
        return [];
    }
    async countRows(collection, filter) {
        const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/count`, {
            method: "POST",
            allow404: true,
            body: { exact: true, filter: filter ? translateFilter(filter) : undefined },
        });
        return Number(res?.result?.count ?? 0);
    }
    async optimize(_collections) {
        // Qdrant handles segment optimization server-side.
    }
    async health(collection) {
        const name = this.collectionName(collection);
        const res = await this.request(`/collections/${encodeURIComponent(name)}`, { method: "GET", allow404: true });
        if (!res)
            return emptyHealth();
        const rowCount = await this.countRows(collection).catch(() => 0);
        return {
            exists: true,
            rowCount,
            vectorIndexReady: res?.result?.status === "green" || res?.result?.optimizer_status === "ok",
            scalarIndexReady: true,
            ftsIndexReady: false,
            unindexedRowEstimate: 0,
            lastIndexRebuildAt: 0,
            indexes: [],
            dimension: await this.getStoredDimension(collection),
        };
    }
    async reset() {
        let deleted = false;
        for (const collection of ["embeddings", "embeddings_world_books"]) {
            const name = this.collectionName(collection);
            const res = await this.request(`/collections/${encodeURIComponent(name)}`, { method: "DELETE", allow404: true });
            if (res)
                deleted = true;
        }
        return { deleted, location: this.baseUrl };
    }
    async close() {
        this.initialized = false;
    }
    collectionName(collection) {
        return `${this.prefix}${collection}`;
    }
    async ensurePayloadIndexes(collection) {
        const name = this.collectionName(collection);
        for (const { field, schema } of PAYLOAD_INDEXES) {
            await this.request(`/collections/${encodeURIComponent(name)}/index`, {
                method: "PUT",
                body: { field_name: field, field_schema: schema },
            }).catch(() => { });
        }
    }
    async applyCollectionTuning(collection) {
        const tuning = qdrantTuning(this.tuningProfile);
        await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, {
            method: "PATCH",
            body: {
                optimizers_config: tuning.optimizersConfig,
                hnsw_config: tuning.hnswConfig,
                quantization_config: tuning.quantizationConfig,
            },
        });
    }
    async request(path, opts) {
        const headers = { "content-type": "application/json" };
        if (this.apiKey)
            headers["api-key"] = this.apiKey;
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: opts.method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: opts.signal,
        });
        if (res.status === 404 && opts.allow404)
            return null;
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Qdrant request failed (${res.status} ${res.statusText}) ${path}: ${text.slice(0, 500)}`);
        }
        if (res.status === 204)
            return {};
        return res.json().catch(() => ({}));
    }
}
function translateFilter(filter) {
    switch (filter.op) {
        case "eq":
            return { must: [{ key: filter.field, match: { value: filter.value } }] };
        case "in":
            return filter.values.length === 0
                ? { must: [{ is_empty: { key: "id" } }] }
                : { must: [{ key: filter.field, match: { any: filter.values } }] };
        case "nin":
            return filter.values.length === 0
                ? {}
                : { must_not: [{ key: filter.field, match: { any: filter.values } }] };
        case "and": {
            const must = [];
            const mustNot = [];
            for (const clause of filter.clauses) {
                const translated = translateFilter(clause);
                if (Array.isArray(translated.must))
                    must.push(...translated.must);
                if (Array.isArray(translated.must_not))
                    mustNot.push(...translated.must_not);
            }
            return { ...(must.length ? { must } : {}), ...(mustNot.length ? { must_not: mustNot } : {}) };
        }
    }
}
function qdrantPointId(id) {
    const namespace = Buffer.from(UUID_NAMESPACE.replace(/-/g, ""), "hex");
    const hash = createHash("sha1").update(namespace).update(id).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function rowToPayload(row) {
    return {
        id: row.id,
        user_id: row.user_id,
        source_type: row.source_type,
        source_id: row.source_id,
        owner_id: row.owner_id,
        chunk_index: row.chunk_index,
        content: row.content,
        metadata_json: row.metadata_json,
        updated_at: row.updated_at,
    };
}
function pointToVectorRow(point) {
    const payload = point?.payload || {};
    const vector = Array.isArray(point?.vector) ? point.vector.map(Number).filter(Number.isFinite) : [];
    if (!payload.id || vector.length === 0)
        return null;
    return {
        id: String(payload.id),
        user_id: String(payload.user_id || ""),
        source_type: String(payload.source_type || ""),
        source_id: String(payload.source_id || ""),
        owner_id: String(payload.owner_id || ""),
        chunk_index: Number(payload.chunk_index ?? 0),
        content: String(payload.content || ""),
        vector,
        metadata_json: typeof payload.metadata_json === "string" ? payload.metadata_json : JSON.stringify(payload.metadata_json ?? {}),
        updated_at: Number(payload.updated_at ?? 0),
    };
}
function pointToHit(point, withVector) {
    const payload = point?.payload || {};
    if (!payload.source_id)
        return null;
    return {
        id: String(payload.id || ""),
        source_id: String(payload.source_id),
        content: String(payload.content || ""),
        metadata_json: typeof payload.metadata_json === "string" ? payload.metadata_json : JSON.stringify(payload.metadata_json ?? {}),
        similarity: typeof point.score === "number" ? point.score : null,
        lexicalScore: null,
        vector: withVector && Array.isArray(point.vector) ? point.vector.map(Number).filter(Number.isFinite) : null,
    };
}
function sanitizeCollectionPrefix(prefix) {
    const sanitized = prefix.replace(/[^A-Za-z0-9_-]/g, "_");
    return sanitized || DEFAULT_PREFIX;
}
function qdrantTuning(profile) {
    switch (profile) {
        case "low_latency":
            return {
                hnswConfig: { m: 32, ef_construct: 200, full_scan_threshold: 10_000, on_disk: false },
                optimizersConfig: { default_segment_number: 4, indexing_threshold: 10_000 },
                searchParams: { hnsw_ef: 128 },
            };
        case "low_memory":
            return {
                hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 20_000, on_disk: true },
                optimizersConfig: { default_segment_number: 2, memmap_threshold: 20_000, indexing_threshold: 20_000 },
                quantizationConfig: { scalar: { type: "int8", quantile: 0.99, always_ram: false } },
                searchParams: { hnsw_ef: 64 },
            };
        case "bulk_reindex":
            return {
                hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 20_000, on_disk: false },
                optimizersConfig: { default_segment_number: 2, indexing_threshold: 50_000 },
                searchParams: { hnsw_ef: 64 },
            };
        case "balanced":
        default:
            return {
                hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 10_000, on_disk: false },
                optimizersConfig: { default_segment_number: 2, indexing_threshold: 20_000 },
                searchParams: { hnsw_ef: 64 },
            };
    }
}
function emptyHealth() {
    return {
        exists: false,
        rowCount: 0,
        vectorIndexReady: false,
        scalarIndexReady: false,
        ftsIndexReady: false,
        unindexedRowEstimate: 0,
        lastIndexRebuildAt: 0,
        indexes: [],
        dimension: null,
    };
}
