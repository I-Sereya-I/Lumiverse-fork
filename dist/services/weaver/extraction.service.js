import { getDb } from "../../db/connection";
import { getSession } from "./session.service";
import { getSeedAdapter } from "./seed-adapter";
import { isSlotId, slotParts } from "./slots";
import { getBuildRegistry } from "./build-registry";
import { WEAVER_FACT_SOURCES } from "../../types/weaver";
function coerceFactSource(value, fallback) {
    return WEAVER_FACT_SOURCES.includes(value)
        ? value
        : fallback;
}
function rowToExtraction(slots, row) {
    return {
        session_id: row.session_id,
        committed_facts: parseFacts(slots, row.committed_facts),
        gaps: parseGaps(slots, row.gaps),
        edited_at: row.edited_at,
    };
}
function coercePart(slots, slot, value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const v = value.trim();
    return slotParts(slots, slot).some((p) => p.id === v) ? v : undefined;
}
function parseFacts(slots, value) {
    const arr = safeParseArray(value);
    const out = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object")
            continue;
        const slot = raw.slot;
        const fact = raw.fact;
        if (!isSlotId(slots, slot) || typeof fact !== "string" || !fact.trim())
            continue;
        const source = coerceFactSource(raw.source, "extracted");
        const part = coercePart(slots, slot, raw.part);
        out.push({ slot, ...(part ? { part } : {}), fact: fact.trim(), source });
    }
    return out;
}
function parseGaps(slots, value) {
    const arr = safeParseArray(value);
    const out = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object")
            continue;
        const slot = raw.slot;
        if (!isSlotId(slots, slot))
            continue;
        const note = typeof raw.note === "string" ? raw.note.trim() : "";
        const source = raw.source === "user" ? "user" : "extracted";
        out.push({ slot, note, source });
    }
    return out;
}
function safeParseArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function slotsFor(userId, sessionId) {
    const session = getSession(userId, sessionId);
    return getBuildRegistry(session?.build_type ?? "").slots;
}
export function getExtraction(userId, sessionId) {
    const row = getDb()
        .prepare(`SELECT * FROM weaver_extraction WHERE session_id = ? AND user_id = ?`)
        .get(sessionId, userId);
    return row ? rowToExtraction(slotsFor(userId, sessionId), row) : null;
}
function upsert(userId, sessionId, facts, gaps) {
    getDb()
        .prepare(`INSERT INTO weaver_extraction (session_id, user_id, committed_facts, gaps, edited_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(session_id) DO UPDATE SET
         committed_facts = excluded.committed_facts,
         gaps = excluded.gaps,
         edited_at = excluded.edited_at`)
        .run(sessionId, userId, JSON.stringify(facts), JSON.stringify(gaps));
    return getExtraction(userId, sessionId);
}
export async function runReadback(userId, sessionId, signal) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    const adapter = getSeedAdapter(session.seed.type);
    const material = await adapter.extract(userId, session, signal);
    const extraction = upsert(userId, sessionId, material.committed_facts, material.gaps);
    getDb()
        .prepare(`UPDATE weaver_sessions SET stage = 'readback', updated_at = unixepoch()
       WHERE id = ? AND user_id = ?`)
        .run(sessionId, userId);
    return extraction;
}
export function addCommittedFact(userId, sessionId, slot, fact, part, source = "user") {
    const existing = getExtraction(userId, sessionId);
    if (!existing)
        throw new Error("Extraction not found");
    const slots = slotsFor(userId, sessionId);
    if (!isSlotId(slots, slot))
        throw new Error("Invalid slot");
    const trimmed = fact.trim();
    if (!trimmed)
        throw new Error("Fact is empty");
    const validPart = coercePart(slots, slot, part);
    const facts = [
        ...existing.committed_facts,
        { slot, ...(validPart ? { part: validPart } : {}), fact: trimmed, source },
    ];
    const gaps = allElicitPartsCovered(slots, slot, facts)
        ? existing.gaps.filter((g) => g.slot !== slot)
        : existing.gaps;
    return upsert(userId, sessionId, facts, gaps);
}
function allElicitPartsCovered(slots, slot, facts) {
    const parts = slotParts(slots, slot);
    const hybrid = parts.length > 1;
    return parts
        .filter((p) => p.fill === "elicit")
        .every((p) => facts.some((f) => f.slot === slot && (hybrid ? f.part === p.id : true)));
}
export function revertSlotsToGaps(userId, sessionId, slots) {
    const existing = getExtraction(userId, sessionId);
    if (!existing)
        throw new Error("Extraction not found");
    const known = slotsFor(userId, sessionId);
    const revert = new Set(slots.filter((s) => isSlotId(known, s)));
    if (revert.size === 0)
        return existing;
    const facts = existing.committed_facts.filter((f) => !revert.has(f.slot));
    const gapSlots = new Set(existing.gaps.map((g) => g.slot));
    const gaps = [...existing.gaps];
    for (const slot of revert) {
        if (!gapSlots.has(slot))
            gaps.push({ slot, note: "", source: "extracted" });
    }
    return upsert(userId, sessionId, facts, gaps);
}
export function forgetSlots(userId, sessionId, slots) {
    const existing = getExtraction(userId, sessionId);
    if (!existing)
        throw new Error("Extraction not found");
    const known = slotsFor(userId, sessionId);
    const forget = new Set(slots.filter((s) => isSlotId(known, s)));
    if (forget.size === 0)
        return existing;
    return upsert(userId, sessionId, existing.committed_facts.filter((f) => !forget.has(f.slot)), existing.gaps.filter((g) => !forget.has(g.slot)));
}
export function updateExtraction(userId, sessionId, input) {
    const existing = getExtraction(userId, sessionId);
    if (!existing)
        throw new Error("Extraction not found");
    const slots = slotsFor(userId, sessionId);
    const facts = (input.committed_facts ?? existing.committed_facts).map((f) => {
        const part = coercePart(slots, f.slot, f.part);
        return {
            slot: f.slot,
            ...(part ? { part } : {}),
            fact: f.fact.trim(),
            // A hand-edit defaults to the author's words; valid provenance rides through.
            source: coerceFactSource(f.source, "user"),
        };
    }).filter((f) => isSlotId(slots, f.slot) && f.fact);
    const gaps = (input.gaps ?? existing.gaps).map((g) => ({
        slot: g.slot,
        note: (g.note ?? "").trim(),
        source: "user",
    })).filter((g) => isSlotId(slots, g.slot));
    return upsert(userId, sessionId, facts, gaps);
}
