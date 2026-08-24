import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";
/**
 * Reserved principal for system-scope Spindle extension brokers. Real user
 * ids are UUIDs, so this principal is unreachable through normal login.
 * Operators provision system broker secrets under it explicitly via the
 * operator secrets route; system-scoped brokers resolve their credentials
 * from these rows host-side at request time.
 */
export const SYSTEM_SECRET_PRINCIPAL = "__system__";
/**
 * Reserved email of the system principal row. First-user resolution queries
 * (owner seeding, migrations, default presets) exclude this address so the
 * synthetic row can never be mistaken for a real account.
 */
export const SYSTEM_SECRET_PRINCIPAL_EMAIL = "system@lumiverse.local";
let _cachedKey = null;
const warnedUnreadableSecrets = new Set();
export class SecretDecryptionError extends Error {
    code = "SECRET_DECRYPTION_FAILED";
    constructor(secretKey, cause) {
        super(`Stored credential "${secretKey}" cannot be decrypted. Restore the matching identity file or replace the credential in Settings.`, { cause });
        this.name = "SecretDecryptionError";
    }
}
export function isSecretDecryptionFailure(err) {
    return err instanceof DOMException && (err.name === "OperationError" || err.name === "DataError");
}
export function isSecretDecryptionError(err) {
    return err instanceof SecretDecryptionError
        || (err instanceof Error && err.code === "SECRET_DECRYPTION_FAILED");
}
function normalizeSecretReadError(err, secretKey) {
    return isSecretDecryptionFailure(err) ? new SecretDecryptionError(secretKey, err) : err;
}
async function getEncryptionKey() {
    if (_cachedKey)
        return _cachedKey;
    const keyBytes = getEncryptionKeyBytes();
    _cachedKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return _cachedKey;
}
async function encrypt(plaintext) {
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    // AES-GCM appends the 16-byte auth tag to the ciphertext
    const ciphertextBytes = new Uint8Array(ciphertext);
    const encryptedData = ciphertextBytes.slice(0, -16);
    const tag = ciphertextBytes.slice(-16);
    return {
        encrypted: Buffer.from(encryptedData).toString("base64"),
        iv: Buffer.from(iv).toString("base64"),
        tag: Buffer.from(tag).toString("base64"),
    };
}
async function decrypt(encrypted, ivB64, tagB64) {
    const key = await getEncryptionKey();
    const iv = new Uint8Array(Buffer.from(ivB64, "base64"));
    const encryptedData = new Uint8Array(Buffer.from(encrypted, "base64"));
    const tag = new Uint8Array(Buffer.from(tagB64, "base64"));
    // Reconstruct ciphertext + tag for AES-GCM
    const combined = new Uint8Array(encryptedData.length + tag.length);
    combined.set(encryptedData);
    combined.set(tag, encryptedData.length);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
    return new TextDecoder().decode(decrypted);
}
export function listSecretKeys(userId) {
    const rows = getDb().query("SELECT key FROM secrets WHERE user_id = ? ORDER BY key").all(userId);
    return rows.map((r) => r.key);
}
/**
 * The reserved system principal is not a login account, so it must be
 * materialized once before secrets can reference it via the
 * secrets.user_id -> user(id) foreign key.
 */
function ensureSystemPrincipalRow() {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    // Resolve on the reserved id/email explicitly instead of INSERT OR IGNORE:
    // a silent skip (e.g. an unrelated account already holding the reserved
    // email) would leave secrets writes failing on the foreign key with no
    // explanation. Fail loudly instead.
    const existing = db
        .query('SELECT id FROM "user" WHERE id = ? OR email = ?')
        .get(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL);
    if (!existing) {
        // Real timestamps: createdAt = 0 would sort the synthetic row before every
        // real user in ORDER BY createdAt ASC consumers (owner seeding, ST
        // migration, default presets).
        db.query(`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
       VALUES (?, 'System', ?, 1, 'system', ?, ?)`).run(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL, now, now);
        return;
    }
    if (existing.id !== SYSTEM_SECRET_PRINCIPAL) {
        throw new Error(`Reserved system principal email "${SYSTEM_SECRET_PRINCIPAL_EMAIL}" is held by account "${existing.id}". ` +
            "Rename or delete that account before provisioning system broker secrets.");
    }
    // Repair legacy rows created with createdAt = 0 so first-user ordering
    // consumers never see the synthetic row as the oldest account.
    db.query(`UPDATE "user"
     SET createdAt = CASE WHEN createdAt IS NULL OR createdAt = 0 THEN ? ELSE createdAt END,
         updatedAt = ?
     WHERE id = ?`).run(now, now, SYSTEM_SECRET_PRINCIPAL);
}
export async function putSecret(userId, key, value) {
    if (userId === SYSTEM_SECRET_PRINCIPAL)
        ensureSystemPrincipalRow();
    const { encrypted, iv, tag } = await encrypt(value);
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO secrets (key, encrypted_value, iv, tag, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET encrypted_value = excluded.encrypted_value, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`)
        .run(key, encrypted, iv, tag, userId, now);
}
export async function getSecret(userId, key) {
    const row = getDb().query("SELECT * FROM secrets WHERE key = ? AND user_id = ?").get(key, userId);
    if (!row)
        return null;
    try {
        return await decrypt(row.encrypted_value, row.iv, row.tag);
    }
    catch (err) {
        throw normalizeSecretReadError(err, key);
    }
}
async function recoverUnreadableSecretForStatus(userId, key, read) {
    const warningKey = `${userId}:${key}`;
    try {
        const value = await read();
        warnedUnreadableSecrets.delete(warningKey);
        return value;
    }
    catch (err) {
        const normalized = normalizeSecretReadError(err, key);
        if (!isSecretDecryptionError(normalized))
            throw normalized;
        if (!warnedUnreadableSecrets.has(warningKey)) {
            warnedUnreadableSecrets.add(warningKey);
            console.warn(`[secrets] ${normalized.message} Treating it as missing until it is replaced.`);
        }
        return null;
    }
}
/**
 * Read a credential for a presence/status response. An unreadable encrypted row
 * is reported as missing so its settings UI remains available for recovery.
 * Database and other non-crypto failures still propagate.
 */
export function getSecretForStatus(userId, key) {
    return recoverUnreadableSecretForStatus(userId, key, () => getSecret(userId, key));
}
export function deleteSecret(userId, key) {
    return getDb().query("DELETE FROM secrets WHERE key = ? AND user_id = ?").run(key, userId).changes > 0;
}
export async function validateSecret(userId, key) {
    const value = await getSecretForStatus(userId, key);
    return value !== null && value.length > 0;
}
export const __test__ = {
    normalizeSecretReadError,
    recoverUnreadableSecretForStatus,
};
