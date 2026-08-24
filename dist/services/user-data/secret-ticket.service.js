// Decryption-ticket protocol for the optional "include API keys" path of
// user-data export/import.
//
// At export prepare time the server generates a random 32-byte Secret Master
// Key (SMK), keeps it briefly in memory until the matching archive download
// streams, and hands the user a small JSON ticket file containing the SMK
// in base64 plus a binding to the archive's id and the list of secret keys
// it covers. The archive ships the secrets table encrypted with the SMK; the
// ticket ships the key out-of-band.
//
// At import time the user uploads the ticket alongside the archive. The
// importing instance decrypts each secret with the SMK and re-encrypts it
// under its own identity key via the normal `secretsSvc.putSecret` path —
// the plaintext never lands on disk and never leaves the import request.
//
// Tickets never expire (the archive doubles as long-term backup) and reuse
// is advisory: every consumption is recorded in `import_consumed_tickets`
// and surfaced to the importer as a warning, but it never blocks.
import { getDb } from "../../db/connection";
export const TICKET_KIND = "lumiverse-decryption-ticket";
export const TICKET_VERSION = 1;
export const TICKET_ALGORITHM = "AES-256-GCM";
/** Length of the SMK in bytes. 256 bits → AES-256. */
export const SMK_BYTES = 32;
// ---------------------------------------------------------------------------
// SMK & ticket creation (export side)
// ---------------------------------------------------------------------------
function b64encode(bytes) {
    return Buffer.from(bytes).toString("base64");
}
function b64decode(s) {
    return new Uint8Array(Buffer.from(s, "base64"));
}
async function sha256Hex(input) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Buffer.from(new Uint8Array(digest)).toString("hex");
}
/** Compute the canonical binding hash for a ticket. */
export async function computeSecretsHash(archiveId, secretKeys) {
    const sorted = [...secretKeys].sort();
    const payload = `${archiveId}|${TICKET_ALGORITHM}|${sorted.join("\n")}`;
    return sha256Hex(payload);
}
export async function createTicket(archiveId, secretKeys, opts = {}) {
    const smk = crypto.getRandomValues(new Uint8Array(SMK_BYTES));
    const ticket = {
        kind: TICKET_KIND,
        version: TICKET_VERSION,
        archiveId,
        issuer: "lumiverse",
        issuerInstance: opts.issuerInstance ?? null,
        issuedAt: Math.floor(Date.now() / 1000),
        algorithm: TICKET_ALGORITHM,
        keyB64: b64encode(smk),
        secretsHash: await computeSecretsHash(archiveId, secretKeys),
    };
    return { ticket, smk };
}
// ---------------------------------------------------------------------------
// AES-GCM helpers (used by both sides)
// ---------------------------------------------------------------------------
async function importAesKey(smk) {
    // Copy into a freshly-allocated ArrayBuffer so TS sees a concrete
    // ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer).
    const buf = new ArrayBuffer(smk.byteLength);
    new Uint8Array(buf).set(smk);
    return crypto.subtle.importKey("raw", buf, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
    ]);
}
/** Allocate a Uint8Array backed by a concrete ArrayBuffer (not SharedArrayBuffer). */
function freshBytes(input) {
    const buf = new ArrayBuffer(input.byteLength);
    const out = new Uint8Array(buf);
    out.set(input);
    return out;
}
export async function encryptSecret(smk, key, plaintext) {
    const cryptoKey = await importAesKey(smk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: freshBytes(iv) }, cryptoKey, freshBytes(new TextEncoder().encode(plaintext)));
    const bytes = new Uint8Array(ct);
    // AES-GCM appends the 16-byte tag to the ciphertext.
    const data = bytes.slice(0, -16);
    const tag = bytes.slice(-16);
    return {
        key,
        iv: b64encode(iv),
        tag: b64encode(tag),
        ciphertext: b64encode(data),
    };
}
export async function decryptSecret(smk, entry) {
    const cryptoKey = await importAesKey(smk);
    const iv = b64decode(entry.iv);
    const data = b64decode(entry.ciphertext);
    const tag = b64decode(entry.tag);
    const combined = freshBytes(new Uint8Array(data.length + tag.length));
    combined.set(data, 0);
    combined.set(tag, data.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: freshBytes(iv) }, cryptoKey, combined);
    return new TextDecoder().decode(plain);
}
// ---------------------------------------------------------------------------
// Ticket parsing & validation (import side)
// ---------------------------------------------------------------------------
export class TicketError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TicketError";
    }
}
/**
 * Validate a ticket against an archive's manifest and the actual list of
 * secret keys we found inside the archive. Does NOT consult the consumed
 * tickets table — that's the caller's job (so the caller can decide to
 * advise vs. block).
 */
export async function verifyTicket(raw, expectedArchiveId, archiveSecretKeys) {
    if (!raw || typeof raw !== "object") {
        throw new TicketError("malformed", "ticket is not a JSON object");
    }
    const t = raw;
    if (t.kind !== TICKET_KIND) {
        throw new TicketError("wrong_kind", `ticket kind is ${JSON.stringify(t.kind)}, expected ${JSON.stringify(TICKET_KIND)}`);
    }
    if (Number(t.version) !== TICKET_VERSION) {
        throw new TicketError("unsupported_version", `ticket version ${t.version} is unsupported (expected ${TICKET_VERSION})`);
    }
    if (t.algorithm !== TICKET_ALGORITHM) {
        throw new TicketError("malformed", `unsupported algorithm: ${t.algorithm}`);
    }
    if (typeof t.archiveId !== "string" || !t.archiveId) {
        throw new TicketError("malformed", "ticket archiveId is missing");
    }
    if (typeof t.keyB64 !== "string") {
        throw new TicketError("malformed", "ticket keyB64 is missing");
    }
    if (t.archiveId !== expectedArchiveId) {
        throw new TicketError("archive_mismatch", `ticket archiveId ${t.archiveId} does not match archive manifest ${expectedArchiveId}`);
    }
    const smk = b64decode(t.keyB64);
    if (smk.byteLength !== SMK_BYTES) {
        throw new TicketError("malformed", `ticket key is ${smk.byteLength} bytes, expected ${SMK_BYTES}`);
    }
    // Binding hash: recompute over the archive's own secret-key list and
    // compare. A mismatch means the archive's secrets list was tampered with
    // (or the ticket was issued for a different revision of this archive).
    const recomputed = await computeSecretsHash(expectedArchiveId, archiveSecretKeys);
    if (typeof t.secretsHash === "string" && t.secretsHash !== recomputed) {
        throw new TicketError("binding_mismatch", "ticket secretsHash does not match the archive's encrypted-secrets manifest");
    }
    return {
        ticket: {
            kind: TICKET_KIND,
            version: TICKET_VERSION,
            archiveId: t.archiveId,
            issuer: "lumiverse",
            issuerInstance: typeof t.issuerInstance === "string" ? t.issuerInstance : null,
            issuedAt: Number(t.issuedAt) || 0,
            algorithm: TICKET_ALGORITHM,
            keyB64: t.keyB64,
            secretsHash: typeof t.secretsHash === "string" ? t.secretsHash : recomputed,
        },
        smk,
    };
}
export function lookupConsumedTicket(archiveId) {
    const row = getDb()
        .query("SELECT archive_id, consumed_at, user_id, uses FROM import_consumed_tickets WHERE archive_id = ?")
        .get(archiveId);
    if (!row)
        return null;
    return {
        archiveId: row.archive_id,
        consumedAt: row.consumed_at,
        userId: row.user_id,
        uses: row.uses,
    };
}
/**
 * Record a ticket consumption. Atomic insert-or-bump: first use creates the
 * row, subsequent uses increment the `uses` counter and refresh `consumed_at`.
 */
export function recordConsumedTicket(archiveId, userId) {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.run(`INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses)
       VALUES (?, ?, ?, 1)
     ON CONFLICT(archive_id) DO UPDATE
        SET consumed_at = excluded.consumed_at,
            user_id    = excluded.user_id,
            uses       = import_consumed_tickets.uses + 1`, [archiveId, now, userId]);
    return lookupConsumedTicket(archiveId);
}
const PREPARE_CACHE = new Map();
const PREPARE_ORPHAN_SWEEP_MS = 30 * 60 * 1000; // 30 min — purely housekeeping
let _sweepTimer = null;
function ensureSweepTimer() {
    if (_sweepTimer)
        return;
    _sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of PREPARE_CACHE) {
            if (now - entry.createdAt * 1000 > PREPARE_ORPHAN_SWEEP_MS) {
                PREPARE_CACHE.delete(id);
            }
        }
    }, PREPARE_ORPHAN_SWEEP_MS);
    if (typeof _sweepTimer.unref === "function") {
        _sweepTimer.unref();
    }
}
export function stashPrepareEntry(archiveId, entry) {
    PREPARE_CACHE.set(archiveId, entry);
    ensureSweepTimer();
}
export function consumePrepareEntry(archiveId) {
    const entry = PREPARE_CACHE.get(archiveId);
    if (!entry)
        return null;
    PREPARE_CACHE.delete(archiveId);
    return entry;
}
/** For tests / debugging only. */
export function prepareCacheSize() {
    return PREPARE_CACHE.size;
}
