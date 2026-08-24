import { join } from "node:path";
import { mkdirSync, writeFileSync, createWriteStream, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../env";
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const CHUNKED_MAX_UPLOAD_BYTES = 100 * DEFAULT_MAX_UPLOAD_BYTES;
export const UPLOAD_READ_CHUNK_BYTES = 16 * 1024 * 1024;
const uploads = new Map();
export function getMaxUploadBytes(chunkedRead = false) {
    return chunkedRead ? CHUNKED_MAX_UPLOAD_BYTES : DEFAULT_MAX_UPLOAD_BYTES;
}
function dirFor(userId, uploadId) {
    return join(env.dataDir, "spindle-uploads", userId, uploadId);
}
export function createUpload(input) {
    const uploadId = crypto.randomUUID();
    const dir = dirFor(input.ownerUserId, uploadId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "blob");
    writeFileSync(path, "");
    const rec = {
        uploadId,
        path,
        fileName: input.fileName,
        declaredSize: input.declaredSize,
        ownerUserId: input.ownerUserId,
        extensionIdentifier: input.extensionIdentifier,
        offset: 0,
        expiresAt: Date.now() + UPLOAD_TTL_MS,
    };
    uploads.set(uploadId, rec);
    return rec;
}
export function getUpload(uploadId) {
    const rec = uploads.get(uploadId);
    if (!rec)
        return undefined;
    if (Date.now() > rec.expiresAt) {
        deleteUpload(uploadId);
        return undefined;
    }
    return rec;
}
export async function appendUpload(uploadId, body, expectedOffset) {
    const rec = uploads.get(uploadId);
    if (!rec)
        throw new Error("upload not found");
    if (expectedOffset !== rec.offset)
        throw new Error("offset mismatch");
    rec.expiresAt = Date.now() + UPLOAD_TTL_MS;
    // Enforce the cap mid-stream so a client can't exceed it by lying about length.
    const cap = new Transform({
        transform(chunk, _enc, cb) {
            if (rec.offset + chunk.length > rec.declaredSize) {
                cb(new Error("upload exceeds declared size"));
                return;
            }
            if (rec.offset + chunk.length > CHUNKED_MAX_UPLOAD_BYTES) {
                cb(new Error("upload exceeds size cap"));
                return;
            }
            rec.offset += chunk.length;
            cb(null, chunk);
        },
    });
    try {
        // pipeline propagates source/transform/sink errors as a rejection and
        // destroys every stream, so a write fault never becomes an unhandled
        // 'error' event (process crash) or a hung promise.
        const bodyStream = body;
        await pipeline(Readable.fromWeb(bodyStream), cap, createWriteStream(rec.path, { flags: "a" }));
    }
    finally {
        // Reconcile against what actually landed on disk: a partial PATCH must
        // leave rec.offset == file size so the client's resume offset is correct.
        try {
            rec.offset = statSync(rec.path).size;
        }
        catch (err) {
            console.warn(`[spindle-uploads] stat after append failed for ${uploadId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return rec.offset;
}
export async function readUploadBytes(uploadId) {
    const rec = uploads.get(uploadId);
    if (!rec)
        throw new Error("upload not found");
    return new Uint8Array(await Bun.file(rec.path).arrayBuffer());
}
export async function readUploadChunk(uploadId, offset) {
    const rec = getUpload(uploadId);
    if (!rec)
        throw new Error("upload not found");
    if (rec.offset !== rec.declaredSize)
        throw new Error("upload is incomplete");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > rec.declaredSize) {
        throw new Error("invalid upload offset");
    }
    rec.expiresAt = Date.now() + UPLOAD_TTL_MS;
    const end = Math.min(offset + UPLOAD_READ_CHUNK_BYTES, rec.declaredSize);
    const data = new Uint8Array(await Bun.file(rec.path).slice(offset, end).arrayBuffer());
    if (data.byteLength !== end - offset)
        throw new Error("upload changed while reading");
    return data;
}
export function deleteUpload(uploadId) {
    const rec = uploads.get(uploadId);
    if (!rec)
        return;
    uploads.delete(uploadId);
    try {
        rmSync(dirFor(rec.ownerUserId, uploadId), { recursive: true, force: true });
    }
    catch (err) {
        console.warn(`[spindle-uploads] failed to remove upload dir for ${uploadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
const sweepTimer = setInterval(() => {
    try {
        const now = Date.now();
        for (const [id, rec] of uploads) {
            if (now > rec.expiresAt)
                deleteUpload(id);
        }
    }
    catch (err) {
        // A throw here would be an unhandled timer exception (process crash).
        console.error(`[spindle-uploads] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === "function") {
    sweepTimer.unref();
}
