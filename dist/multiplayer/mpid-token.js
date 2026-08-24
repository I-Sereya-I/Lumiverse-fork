/**
 * Host-side mint/verify for Identity-Server-format tokens (HS256, the same
 * wire format as the MPIdentity server's crypto/tokens.ts). Used to:
 *  - mint HOST tokens (signed with the room secret) to authenticate to the
 *    Identity Server's control plane + relay upstream.
 *  - verify DIRECT-connect tokens (server-minted, signed with the room secret)
 *    OFFLINE when a remote peer dials the host directly.
 *
 * Key selection is by token TYPE; the `alg` header is ignored on verify.
 */
import { Buffer } from "node:buffer";
import { constantTimeEqual } from "../crypto/identity";
const MAX_TOKEN_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 60;
async function hmac(key, msg) {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
export async function mintHostToken(roomId, secret, aud, ttlSeconds = 300) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "mpid" };
    const payload = { typ: "host", aud, rid: roomId, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID() };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await hmac(secret, signingInput);
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}
/** Read claims WITHOUT verifying — only to select the verification key. */
export function peekMpidClaims(token) {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH)
        return null;
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    try {
        const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return { typ: typeof c.typ === "string" ? c.typ : undefined, rid: typeof c.rid === "string" ? c.rid : undefined };
    }
    catch {
        return null;
    }
}
export async function verifyMpidToken(token, secret, opts) {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH)
        return null;
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = await hmac(secret, signingInput);
    let provided;
    try {
        provided = new Uint8Array(Buffer.from(parts[2], "base64url"));
    }
    catch {
        return null;
    }
    if (!constantTimeEqual(provided, expected))
        return null;
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
    if (claims.typ !== opts.typ || claims.aud !== opts.aud)
        return null;
    if (typeof claims.rid !== "string" || (opts.rid && claims.rid !== opts.rid))
        return null;
    if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || typeof claims.jti !== "string")
        return null;
    const now = Math.floor(Date.now() / 1000);
    if (now >= claims.exp)
        return null;
    if (claims.iat > now + CLOCK_SKEW_SECONDS)
        return null;
    return claims;
}
