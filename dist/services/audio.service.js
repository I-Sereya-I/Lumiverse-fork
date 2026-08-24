import { getDb } from "../db/connection";
import { env } from "../env";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
const AUDIO_DIR = "audio";
function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
function getAudioDir() {
    const dir = join(env.dataDir, AUDIO_DIR);
    ensureDir(dir);
    return dir;
}
function extForMime(mime) {
    switch ((mime || "").toLowerCase()) {
        case "audio/mpeg":
        case "audio/mp3":
            return ".mp3";
        case "audio/ogg":
        case "audio/ogg; codecs=opus":
        case "audio/opus":
            return ".ogg";
        case "audio/wav":
        case "audio/x-wav":
            return ".wav";
        case "audio/webm":
            return ".webm";
        case "audio/aac":
            return ".aac";
        case "audio/flac":
            return ".flac";
        default:
            return ".bin";
    }
}
/**
 * Persist an audio buffer to disk and create a DB row. Returns the new record.
 * Mirrors images.service.uploadImage but skips all image-specific processing
 * (sharp metadata, thumbnail tiers).
 */
export async function saveAudio(userId, input) {
    const id = crypto.randomUUID();
    const ext = extForMime(input.mime_type) || extname(input.original_filename || "") || ".bin";
    const filename = `${id}${ext}`;
    const filepath = join(getAudioDir(), filename);
    const buffer = input.data instanceof Buffer ? input.data : Buffer.from(input.data);
    await Bun.write(filepath, buffer);
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO audio_files (
         id, user_id, filename, original_filename, mime_type,
         size_bytes, duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, filename, input.original_filename || filename, input.mime_type || "", buffer.byteLength, input.duration_ms ?? null, now);
    return getAudio(userId, id);
}
export function getAudio(userId, id) {
    const row = getDb()
        .query("SELECT * FROM audio_files WHERE id = ? AND user_id = ?")
        .get(id, userId);
    return row || null;
}
export function getAudioFilePath(userId, id) {
    const row = getAudio(userId, id);
    if (!row)
        return null;
    const filepath = join(getAudioDir(), row.filename);
    return existsSync(filepath) ? filepath : null;
}
export function deleteAudio(userId, id) {
    const row = getAudio(userId, id);
    if (!row)
        return false;
    const filepath = join(getAudioDir(), row.filename);
    if (existsSync(filepath)) {
        try {
            unlinkSync(filepath);
        }
        catch { /* tolerate races / missing files */ }
    }
    const result = getDb().query("DELETE FROM audio_files WHERE id = ? AND user_id = ?").run(id, userId);
    return result.changes > 0;
}
