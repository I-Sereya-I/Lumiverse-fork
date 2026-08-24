/**
 * Two-tier embedding vector cache: in-memory LRU + SQLite disk backing.
 *
 * Cache keys incorporate a model fingerprint so entries are automatically
 * invalidated when the embedding model/provider/dimensions change.
 *
 * When entries are evicted from the in-memory LRU they are persisted to a
 * SQLite table so they can be recovered on a future cache miss without
 * hitting the embedding API again.
 */
import { getDb } from "../db/connection";
export function computeCacheKey(content, fingerprint) {
    const fp = `${fingerprint.provider}|${fingerprint.model}|${fingerprint.dimensions ?? ""}|${fingerprint.api_url}`;
    return `${Bun.hash(fp).toString(36)}:${Bun.hash(content).toString(36)}`;
}
export class EmbeddingCache {
    map = new Map();
    maxSize;
    ttlMs;
    diskReady = false;
    constructor(maxSize = 2048, ttlMs = 600_000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }
    // ---- SQLite disk layer ----
    ensureDiskTable() {
        if (this.diskReady)
            return;
        try {
            const db = getDb();
            db.run(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          cache_key TEXT PRIMARY KEY,
          vector    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
            this.diskReady = true;
        }
        catch {
            // DB not initialised yet — disk layer unavailable, memory-only is fine
        }
    }
    writeToDisk(key, entry) {
        try {
            this.ensureDiskTable();
            if (!this.diskReady)
                return;
            const db = getDb();
            db.run(`INSERT OR REPLACE INTO embedding_cache (cache_key, vector, created_at) VALUES (?, ?, ?)`, [key, JSON.stringify(entry.vector), entry.createdAt]);
        }
        catch {
            // Non-critical — worst case we re-embed on next miss
        }
    }
    readFromDisk(key) {
        try {
            this.ensureDiskTable();
            if (!this.diskReady)
                return null;
            const db = getDb();
            const row = db.query(`SELECT vector, created_at FROM embedding_cache WHERE cache_key = ?`).get(key);
            if (!row)
                return null;
            return { vector: JSON.parse(row.vector), createdAt: row.created_at };
        }
        catch {
            return null;
        }
    }
    deleteFromDisk(key) {
        try {
            this.ensureDiskTable();
            if (!this.diskReady)
                return;
            const db = getDb();
            db.run(`DELETE FROM embedding_cache WHERE cache_key = ?`, [key]);
        }
        catch {
            // Non-critical
        }
    }
    clearDisk() {
        try {
            this.ensureDiskTable();
            if (!this.diskReady)
                return;
            const db = getDb();
            db.run(`DELETE FROM embedding_cache`);
        }
        catch {
            // Non-critical
        }
    }
    // ---- Public API ----
    get(key) {
        // 1. Check in-memory
        const entry = this.map.get(key);
        if (entry) {
            if (Date.now() - entry.createdAt > this.ttlMs) {
                this.map.delete(key);
                this.deleteFromDisk(key);
                return null;
            }
            // Promote to most-recently-used
            this.map.delete(key);
            this.map.set(key, entry);
            return entry.vector;
        }
        // 2. Check disk
        const diskEntry = this.readFromDisk(key);
        if (!diskEntry)
            return null;
        if (Date.now() - diskEntry.createdAt > this.ttlMs) {
            this.deleteFromDisk(key);
            return null;
        }
        // Promote into in-memory LRU
        this.evictIfNeeded();
        this.map.set(key, diskEntry);
        return diskEntry.vector;
    }
    set(key, vector) {
        const entry = { vector, createdAt: Date.now() };
        // If key already exists, delete first so insertion order is updated
        this.map.delete(key);
        this.evictIfNeeded();
        this.map.set(key, entry);
        // Always persist to disk
        this.writeToDisk(key, entry);
    }
    clear() {
        this.map.clear();
        this.clearDisk();
    }
    /** Drop only the in-memory tier while preserving the reusable SQLite cache. */
    clearMemory() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
    // ---- Internal ----
    evictIfNeeded() {
        if (this.map.size < this.maxSize)
            return;
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) {
            // Evicted entry is already on disk (written at set() time), so just remove from memory
            this.map.delete(oldest);
        }
    }
}
export const embeddingCache = new EmbeddingCache();
