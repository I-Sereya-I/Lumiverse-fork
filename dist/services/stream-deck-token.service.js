import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
export const STREAM_DECK_SCOPES = ["characters:read", "chats:read"];
function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}
function parseScopes(value) {
    let parsed = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return [];
        }
    }
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((scope) => typeof scope === "string" && STREAM_DECK_SCOPES.includes(scope));
}
function toRecord(row) {
    return {
        id: row.id,
        name: row.name,
        token_prefix: row.token_prefix,
        scopes: parseScopes(row.scopes),
        created_at: row.created_at,
        last_used_at: row.last_used_at ?? null,
        expires_at: row.expires_at ?? null,
    };
}
export function listTokens(userId) {
    return getDb().query(`
    SELECT id, name, token_prefix, scopes, created_at, last_used_at, expires_at
    FROM stream_deck_tokens WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId).map(toRecord);
}
export function createToken(userId, input) {
    const name = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 80)
        : "Stream Deck";
    if (input.scopes !== undefined && (!Array.isArray(input.scopes)
        || input.scopes.some((scope) => typeof scope !== "string" || !STREAM_DECK_SCOPES.includes(scope)))) {
        throw new Error("Scopes contain an unsupported value");
    }
    const requestedScopes = input.scopes === undefined
        ? [...STREAM_DECK_SCOPES]
        : Array.from(new Set(parseScopes(input.scopes)));
    if (requestedScopes.length === 0)
        throw new Error("At least one valid scope is required");
    const expiresAt = typeof input.expiresAt === "number" && Number.isInteger(input.expiresAt)
        ? input.expiresAt
        : null;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt !== null && expiresAt <= now)
        throw new Error("Expiration must be in the future");
    const token = `lvsd_${randomBytes(32).toString("base64url")}`;
    const id = crypto.randomUUID();
    getDb().query(`
    INSERT INTO stream_deck_tokens
      (id, user_id, name, token_hash, token_prefix, scopes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, hashToken(token), token.slice(0, 13), JSON.stringify(requestedScopes), now, expiresAt);
    return { ...toRecord({ id, name, token_prefix: token.slice(0, 13), scopes: requestedScopes, created_at: now, expires_at: expiresAt }), token };
}
export function deleteToken(userId, id) {
    return getDb().query("DELETE FROM stream_deck_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
export function authenticateToken(rawToken) {
    if (!rawToken.startsWith("lvsd_") || rawToken.length < 30)
        return null;
    const now = Math.floor(Date.now() / 1000);
    const row = getDb().query(`
    SELECT id, user_id, scopes, expires_at FROM stream_deck_tokens
    WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)
  `).get(hashToken(rawToken), now);
    if (!row)
        return null;
    getDb().query("UPDATE stream_deck_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return { userId: row.user_id, scopes: parseScopes(row.scopes) };
}
