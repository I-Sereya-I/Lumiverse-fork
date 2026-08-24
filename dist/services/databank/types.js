/**
 * Databank — Type definitions for the document knowledge bank system.
 *
 * SQLite row shapes use snake_case; service-layer DTOs use camelCase.
 */
// ─── Row ↔ DTO Conversion ────────────────────────────────────
export function rowToDatabank(row) {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        description: row.description,
        scope: row.scope,
        scopeId: row.scope_id,
        enabled: row.enabled === 1,
        metadata: JSON.parse(row.metadata || "{}"),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export function rowToDocument(row) {
    return {
        id: row.id,
        databankId: row.databank_id,
        userId: row.user_id,
        name: row.name,
        slug: row.slug,
        filePath: row.file_path,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        contentHash: row.content_hash,
        totalChunks: row.total_chunks,
        status: row.status,
        errorMessage: row.error_message,
        metadata: JSON.parse(row.metadata || "{}"),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export function rowToChunk(row) {
    return {
        id: row.id,
        documentId: row.document_id,
        databankId: row.databank_id,
        userId: row.user_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        tokenCount: row.token_count,
        vectorizedAt: row.vectorized_at,
        vectorModel: row.vector_model,
        metadata: JSON.parse(row.metadata || "{}"),
        createdAt: row.created_at,
    };
}
/** Convert a document name to a URL-safe slug for #mention matching */
export function nameToSlug(name) {
    return name
        .replace(/\.[^.]+$/, "") // strip extension
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // non-alphanum → hyphen
        .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
        .replace(/-{2,}/g, "-"); // collapse double hyphens
}
