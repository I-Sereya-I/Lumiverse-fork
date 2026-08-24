// Manifest for a Lumiverse user-data archive (.lvbak).
//
// The manifest is the first entry written into the archive and the first
// entry read on import. It pins the schema version so the importer can
// reject obviously-incompatible archives, and carries the embedding config
// snapshot used to decide whether to restore LanceDB vectors verbatim or
// queue re-vectorization.
/**
 * Schema 2 makes the per-record NDJSON limit an explicit archive capability.
 * Schema 1 archives remain readable through the bounded compatibility path.
 */
export const ARCHIVE_SCHEMA_VERSION = 2;
export const ARCHIVE_PRODUCER = "lumiverse";
/**
 * Format 1 claimed a 4 MiB record limit, but its exporter never enforced it.
 * Format 2 advertises a limit in the manifest and enforces the same value on
 * both export and import.
 */
export const NDJSON_FORMAT_VERSION = 2;
/** Largest JSON record emitted by the current ZIP64 exporter. */
export const NDJSON_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export function createManifest(input) {
    return {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        producer: ARCHIVE_PRODUCER,
        exportedAt: Math.floor(Date.now() / 1000),
        archiveId: input.archiveId,
        producerVersion: input.producerVersion,
        ndjsonFormatVersion: NDJSON_FORMAT_VERSION,
        ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
        includeVectors: input.includeVectors,
        embeddingConfig: input.embeddingConfig,
        counts: input.counts,
        missingFiles: input.missingFiles,
        hasEncryptedSecrets: !!input.hasEncryptedSecrets,
        secretsCount: input.secretsCount ?? 0,
    };
}
/** Parse and shape-check a manifest blob read from an archive. */
export function parseManifest(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("manifest.json is malformed (not an object)");
    }
    const m = raw;
    if (m.producer !== ARCHIVE_PRODUCER) {
        throw new Error(`archive producer is ${JSON.stringify(m.producer)}, expected "${ARCHIVE_PRODUCER}"`);
    }
    const schemaVersion = Number(m.schemaVersion);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
        throw new Error(`unsupported schemaVersion: ${m.schemaVersion}`);
    }
    if (schemaVersion > ARCHIVE_SCHEMA_VERSION) {
        throw new Error(`archive schemaVersion ${schemaVersion} is newer than this server supports (${ARCHIVE_SCHEMA_VERSION})`);
    }
    const includeVectors = !!m.includeVectors;
    const embeddingConfig = (m.embeddingConfig ?? {
        provider: null,
        model: null,
        dimension: null,
    });
    const counts = (m.counts ?? {});
    const missingFiles = Array.isArray(m.missingFiles) ? m.missingFiles : [];
    const ndjsonFormatVersion = typeof m.ndjsonFormatVersion === "number" &&
        Number.isInteger(m.ndjsonFormatVersion) &&
        m.ndjsonFormatVersion >= 1
        ? m.ndjsonFormatVersion
        : undefined;
    const ndjsonMaxRecordBytes = typeof m.ndjsonMaxRecordBytes === "number" &&
        Number.isSafeInteger(m.ndjsonMaxRecordBytes) &&
        m.ndjsonMaxRecordBytes > 0
        ? m.ndjsonMaxRecordBytes
        : undefined;
    if (schemaVersion >= 2) {
        if (ndjsonFormatVersion !== NDJSON_FORMAT_VERSION) {
            throw new Error(`archive schemaVersion ${schemaVersion} requires ndjsonFormatVersion ${NDJSON_FORMAT_VERSION}`);
        }
        if (ndjsonMaxRecordBytes === undefined) {
            throw new Error("archive is missing a valid ndjsonMaxRecordBytes capability");
        }
        if (ndjsonMaxRecordBytes > NDJSON_MAX_RECORD_BYTES) {
            throw new Error(`archive requires ${ndjsonMaxRecordBytes}-byte NDJSON records; this server supports ${NDJSON_MAX_RECORD_BYTES}`);
        }
    }
    return {
        schemaVersion,
        producer: ARCHIVE_PRODUCER,
        exportedAt: Number(m.exportedAt) || 0,
        archiveId: String(m.archiveId || ""),
        producerVersion: m.producerVersion ?? null,
        ndjsonFormatVersion,
        ndjsonMaxRecordBytes,
        includeVectors,
        embeddingConfig,
        counts,
        missingFiles,
        hasEncryptedSecrets: !!m.hasEncryptedSecrets,
        secretsCount: Number(m.secretsCount) || 0,
    };
}
export function embeddingConfigsMatch(a, b) {
    if (!a || !b)
        return false;
    return (a.provider === b.provider &&
        a.model === b.model &&
        a.dimension === b.dimension &&
        a.dimension !== null);
}
