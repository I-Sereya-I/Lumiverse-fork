import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";
let _cachedKey = null;
async function getEncryptionKey() {
    if (_cachedKey)
        return _cachedKey;
    const keyBytes = getEncryptionKeyBytes();
    _cachedKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return _cachedKey;
}
/**
 * Drop the cached AES key so the next encrypt/decrypt re-imports from the
 * (potentially rotated) identity material. Call this from the identity-key
 * rotation flow and from any test-suite teardown that reinitializes the
 * encryption key.
 */
export function invalidateLumiHubKeyCache() {
    _cachedKey = null;
}
async function encrypt(plaintext) {
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
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
    const combined = new Uint8Array(encryptedData.length + tag.length);
    combined.set(encryptedData);
    combined.set(tag, encryptedData.length);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
    return new TextDecoder().decode(decrypted);
}
function rowToConfig(row, linkToken) {
    return {
        id: row.id,
        userId: row.user_id,
        lumihubUrl: row.lumihub_url,
        wsUrl: row.ws_url,
        instanceName: row.instance_name,
        linkToken,
        instanceId: row.instance_id,
        linkedAt: row.linked_at,
        lastConnectedAt: row.last_connected_at,
        shareUsageStats: row.share_usage_stats === 1,
    };
}
/** Get a user's LumiHub link configuration, or null if they have not linked. */
export async function getLinkConfig(userId) {
    const row = getDb().query("SELECT * FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId);
    if (!row)
        return null;
    const linkToken = await decrypt(row.link_token_encrypted, row.link_token_iv, row.link_token_tag);
    return rowToConfig(row, linkToken);
}
/** Get every configured link for startup reconnection. */
export async function listLinkConfigs() {
    const rows = getDb().query("SELECT * FROM lumihub_link WHERE user_id IS NOT NULL").all();
    return Promise.all(rows.map(async (row) => {
        const token = await decrypt(row.link_token_encrypted, row.link_token_iv, row.link_token_tag);
        return rowToConfig(row, token);
    }));
}
/** Save a user's LumiHub link configuration (replaces only that user's link). */
export async function saveLinkConfig(userId, lumihubUrl, wsUrl, linkToken, instanceId, instanceName) {
    getDb().query("DELETE FROM lumihub_link WHERE user_id = ?").run(userId);
    const { encrypted, iv, tag } = await encrypt(linkToken);
    getDb()
        .query(`INSERT INTO lumihub_link (user_id, lumihub_url, ws_url, instance_name, link_token_encrypted, link_token_iv, link_token_tag, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, lumihubUrl, wsUrl, instanceName, encrypted, iv, tag, instanceId);
}
/** Delete one user's LumiHub link configuration. */
export function deleteLinkConfig(userId) {
    getDb().query("DELETE FROM lumihub_link WHERE user_id = ?").run(userId);
}
/** Check if a LumiHub link is configured for a user. */
export function isLinked(userId) {
    const row = getDb().query("SELECT id FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId);
    return row !== null;
}
/** Update the last_connected_at timestamp. */
export function updateLastConnected(userId) {
    getDb().query("UPDATE lumihub_link SET last_connected_at = datetime('now') WHERE user_id = ?").run(userId);
}
/** Whether the user has opted in to sharing anonymous usage counters. */
export function isStatsSharingEnabled(userId) {
    const row = getDb().query("SELECT share_usage_stats FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId);
    return row?.share_usage_stats === 1;
}
/** Enable/disable sharing anonymous usage counters with the linked hub. */
export function setStatsSharing(userId, enabled) {
    getDb().query("UPDATE lumihub_link SET share_usage_stats = ? WHERE user_id = ?").run(enabled ? 1 : 0, userId);
}
/** Generate a PKCE code_verifier and code_challenge (S256). */
export async function generatePKCE() {
    // Generate 32 random bytes as base64url code_verifier (43 chars)
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const codeVerifier = Buffer.from(verifierBytes).toString("base64url");
    // S256: SHA-256 hash of code_verifier, base64url-encoded
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const codeChallenge = Buffer.from(hashBuffer).toString("base64url");
    return { codeVerifier, codeChallenge };
}
