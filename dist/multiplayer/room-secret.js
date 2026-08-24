/**
 * Per-room secret, derived deterministically from this instance's identity key:
 *   roomSecret = HMAC-SHA256(identityKey, "lumiverse-mp-room-v1:" + roomId)
 *
 * The host registers only this secret with the Identity Server (over TLS) and
 * never persists it separately — it can always re-derive it. The same secret
 * lets the host verify Identity-Server-minted direct-connect tokens OFFLINE.
 */
import { getEncryptionKeyBytes } from "../crypto/init";
import { bytesToHex } from "../crypto/identity";
const cache = new Map();
export async function deriveRoomSecret(roomId) {
    const cached = cache.get(roomId);
    if (cached)
        return cached;
    const baseKey = await crypto.subtle.importKey("raw", getEncryptionKeyBytes(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const tag = new TextEncoder().encode(`lumiverse-mp-room-v1:${roomId}`);
    const secret = new Uint8Array(await crypto.subtle.sign("HMAC", baseKey, tag));
    cache.set(roomId, secret);
    return secret;
}
export function roomSecretHex(secret) {
    return bytesToHex(secret);
}
