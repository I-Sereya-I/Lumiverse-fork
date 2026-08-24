/**
 * Room authentication registry.
 *
 * A remote multiplayer peer authenticates to a room WS connection via a
 * credential that is NOT a host-local account. This registry decouples the WS
 * handler from *how* that credential is validated: the handler only ever calls
 * `validateRoomCredential()`, and validators are registered in priority order.
 *
 * Phase 1 ships exactly one validator — `hmacRoomTokenValidator` — which
 * verifies a host-minted HMAC room token. In Phase 2 an
 * `IdentityServerAttestationValidator` registers alongside it (returning
 * `attested: true`), so policy can later require attestation for sensitive
 * actions without touching the handler.
 */
import { verifyRoomToken } from "../../crypto/room-token";
const validators = [];
export function registerRoomAuthValidator(validator) {
    // De-dupe by name so a hot-reload / double-import can't stack validators.
    const existing = validators.findIndex((v) => v.name === validator.name);
    if (existing >= 0)
        validators[existing] = validator;
    else
        validators.push(validator);
}
/** Try each registered validator in order; first non-null credential wins. */
export async function validateRoomCredential(req, expectedRoomId) {
    for (const validator of validators) {
        try {
            const credential = await validator.tryValidate(req, expectedRoomId);
            if (credential)
                return credential;
        }
        catch (err) {
            console.error(`[room-auth] validator "${validator.name}" threw:`, err);
        }
    }
    return null;
}
// ─── Phase 1 validator: host-minted HMAC room token ──────────────────────────
export const hmacRoomTokenValidator = {
    name: "hmac-room-token",
    async tryValidate(req, expectedRoomId) {
        if (!req.roomToken)
            return null;
        const claims = await verifyRoomToken(req.roomToken, expectedRoomId);
        if (!claims)
            return null;
        return {
            roomId: claims.rid,
            subject: claims.sub,
            displayName: claims.name,
            attested: false,
            source: "hmac-room-token",
        };
    },
};
registerRoomAuthValidator(hmacRoomTokenValidator);
