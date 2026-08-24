import { getDb } from "../../db/connection";
import { getSession, setStage } from "./session.service";
import { getExtraction } from "./extraction.service";
import { getTaste } from "./interview.service";
import { isSlotId, slotParts, slotSynthesisGroup, } from "./slots";
import { getBuildRegistry } from "./build-registry";
import { weaverGenerateJsonWithUsage } from "./llm";
import { buildBibleSynthesisPrompt, buildBibleSynthesisUserMessage, buildBibleWeavePrompt, buildBibleWeaveUserMessage, buildBibleGatePrompt, buildBibleGateUserMessage, } from "./prompts";
import { buildGateVerdict, deriveStatus, applicableBibleCriteria } from "./gate";
import { seedSourceNoun } from "./seed-adapter";
import { getDynamicEntries } from "./dynamic-question.service";
function factKey(f) {
    return `${f.slot}:${f.part ?? f.slot}`;
}
function isHybrid(slot) {
    return Boolean(slot.parts && slot.parts.length > 0);
}
function activeSlots(reg, facts) {
    const covered = new Set(facts.filter((f) => f.fact.trim()).map((f) => f.slot));
    return reg.slots.filter((s) => !s.optional || covered.has(s.id));
}
export function slotsToAuthor(reg, facts) {
    const covered = new Set(facts.map((f) => f.slot));
    return reg.slots.filter((s) => !covered.has(s.id) && !s.optional);
}
export function partsToAuthor(reg, facts) {
    const covered = new Set(facts.filter((f) => f.fact.trim()).map(factKey));
    const out = [];
    for (const slot of activeSlots(reg, facts)) {
        const hybrid = isHybrid(slot);
        for (const part of slotParts(reg.slots, slot.id)) {
            if (covered.has(`${slot.id}:${part.id}`))
                continue;
            const description = part.description ?? (hybrid ? undefined : slot.description);
            out.push({ slot: slot.id, part: part.id, label: part.label, description, fill: part.fill });
        }
    }
    return out;
}
export function coerceAuthoredParts(slots, value, authorable) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const slot = r.slot;
        if (typeof slot !== "string" || !isSlotId(slots, slot))
            continue;
        const part = typeof r.part === "string" && r.part.trim() ? r.part.trim() : slot;
        const content = r.content;
        const key = `${slot}:${part}`;
        if (!authorable.has(key) || seen.has(key))
            continue;
        if (typeof content !== "string" || !content.trim())
            continue;
        seen.add(key);
        out.push({ slot, part, content: content.trim() });
    }
    return out;
}
function dominantOrigin(parts) {
    if (parts.some((p) => p.origin === "established"))
        return "established";
    if (parts.some((p) => p.origin === "authored"))
        return "authored";
    return "inferred";
}
function coerceLinks(slots, value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object")
            continue;
        const from = raw.from;
        const to = raw.to;
        const relation = raw.relation;
        if (!isSlotId(slots, from) || !isSlotId(slots, to) || from === to)
            continue;
        if (typeof relation !== "string" || !relation.trim())
            continue;
        out.push({ from, to, relation: relation.trim() });
    }
    return out;
}
function parseDynamicRegion(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const id = typeof r.id === "string" ? r.id.trim() : "";
        const content = typeof r.content === "string" ? r.content.trim() : "";
        if (!id || !content || seen.has(id))
            continue;
        seen.add(id);
        out.push({
            id,
            question: typeof r.question === "string" ? r.question.trim() : "",
            content,
            origin: coerceOrigin(r.origin),
        });
    }
    return out;
}
function buildFactContent(reg, facts) {
    const factContent = new Map();
    for (const f of facts) {
        if (!f.fact.trim() || !isSlotId(reg.slots, f.slot))
            continue;
        const key = factKey(f);
        const bucket = factContent.get(key);
        if (bucket)
            bucket.push(f.fact.trim());
        else
            factContent.set(key, [f.fact.trim()]);
    }
    return factContent;
}
function buildSlotEntry(reg, slot, factContent, authoredBy) {
    const hybrid = isHybrid(slot);
    const builtParts = [];
    if (hybrid) {
        const general = factContent.get(`${slot.id}:${slot.id}`);
        if (general && general.length) {
            builtParts.push({ id: slot.id, content: general.join(" "), origin: "established" });
        }
    }
    for (const part of slotParts(reg.slots, slot.id)) {
        const key = `${slot.id}:${part.id}`;
        const established = factContent.get(key);
        if (established && established.length) {
            builtParts.push({ id: part.id, content: established.join(" "), origin: "established" });
            continue;
        }
        const authored = authoredBy.get(key);
        if (authored) {
            builtParts.push({
                id: part.id,
                content: authored,
                origin: part.fill === "generate" ? "authored" : "inferred",
            });
        }
    }
    if (builtParts.length === 0)
        return null;
    if (hybrid) {
        const partLabel = (id) => id === slot.id ? slot.label : slot.parts.find((p) => p.id === id)?.label ?? id;
        const content = builtParts.map((bp) => `${partLabel(bp.id)}: ${bp.content}`).join(" ");
        return { slot: slot.id, content, origin: dominantOrigin(builtParts), parts: builtParts };
    }
    const only = builtParts[0];
    return { slot: slot.id, content: only.content, origin: only.origin };
}
export function assembleSpine(reg, facts, authoredRaw, linksRaw, briefRaw, dynamicRaw = []) {
    const authorable = new Set(partsToAuthor(reg, facts).map((t) => `${t.slot}:${t.part}`));
    const authoredBy = new Map(coerceAuthoredParts(reg.slots, authoredRaw, authorable).map((a) => [`${a.slot}:${a.part}`, a.content]));
    const factContent = buildFactContent(reg, facts);
    const entries = [];
    for (const slot of activeSlots(reg, facts)) {
        const entry = buildSlotEntry(reg, slot, factContent, authoredBy);
        if (entry)
            entries.push(entry);
    }
    const brief = typeof briefRaw === "string" ? briefRaw.trim() : "";
    return {
        entries,
        causal_links: coerceLinks(reg.slots, linksRaw),
        brief,
        dynamic: parseDynamicRegion(dynamicRaw),
    };
}
function emptyUsage() {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
}
function addUsage(base, ...next) {
    return next.reduce((acc, u) => ({
        prompt_tokens: acc.prompt_tokens + u.prompt_tokens,
        completion_tokens: acc.completion_tokens + u.completion_tokens,
        total_tokens: acc.total_tokens + u.total_tokens,
        calls: acc.calls + 1,
    }), base);
}
function rowToBible(reg, row) {
    const spine = parseSpine(reg.slots, row.spine);
    return {
        session_id: row.session_id,
        spine,
        status: parseStatus(row.status),
        gate: parseGate(reg, row.gate, spine),
        token_usage: parseUsage(row.token_usage),
        gated_at: row.gated_at ?? null,
        updated_at: row.updated_at ?? null,
    };
}
function parseObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function coerceOrigin(value) {
    return ["established", "authored", "inferred"].includes(value)
        ? value
        : "authored";
}
function parseEntryParts(value) {
    if (!Array.isArray(value))
        return undefined;
    const parts = [];
    for (const p of value) {
        if (!p || typeof p !== "object")
            continue;
        const r = p;
        if (typeof r.id !== "string" || !r.id.trim() || typeof r.content !== "string")
            continue;
        parts.push({ id: r.id, content: r.content.trim(), origin: coerceOrigin(r.origin) });
    }
    return parts.length > 0 ? parts : undefined;
}
export function parseSpine(slots, value) {
    const obj = parseObject(value);
    const entries = Array.isArray(obj.entries)
        ? obj.entries
            .filter((e) => {
            if (!e || typeof e !== "object")
                return false;
            const r = e;
            return isSlotId(slots, r.slot) && typeof r.content === "string";
        })
            .map((e) => {
            const parts = parseEntryParts(e.parts);
            const entry = {
                slot: e.slot,
                content: e.content.trim(),
                origin: coerceOrigin(e.origin),
            };
            return parts ? { ...entry, parts } : entry;
        })
        : [];
    const causal_links = coerceLinks(slots, obj.causal_links);
    const brief = typeof obj.brief === "string" ? obj.brief.trim() : "";
    return { entries, causal_links, brief, dynamic: parseDynamicRegion(obj.dynamic) };
}
function parseStatus(value) {
    return value === "gated" || value === "flagged" ? value : "pending";
}
function parseGate(reg, value, spine) {
    const obj = parseObject(value);
    if (!Array.isArray(obj.criteria))
        return null;
    return buildGateVerdict(obj, applicableBibleCriteria(reg.bibleGateCriteria, spine));
}
function parseUsage(value) {
    const obj = parseObject(value);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    return {
        prompt_tokens: num(obj.prompt_tokens),
        completion_tokens: num(obj.completion_tokens),
        total_tokens: num(obj.total_tokens),
        calls: num(obj.calls),
    };
}
function persist(userId, sessionId, spine, status, gate, usage, gatedAt) {
    getDb()
        .prepare(`INSERT INTO weaver_bible (session_id, user_id, spine, status, gate, token_usage, gated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(session_id) DO UPDATE SET
         spine = excluded.spine,
         status = excluded.status,
         gate = excluded.gate,
         token_usage = excluded.token_usage,
         gated_at = excluded.gated_at,
         updated_at = excluded.updated_at`)
        .run(sessionId, userId, JSON.stringify(spine), status, JSON.stringify(gate ?? {}), JSON.stringify(usage), gatedAt);
}
function regFor(userId, sessionId) {
    const session = getSession(userId, sessionId);
    return getBuildRegistry(session?.build_type ?? "");
}
export function getBible(userId, sessionId) {
    const row = getDb()
        .prepare(`SELECT * FROM weaver_bible WHERE session_id = ? AND user_id = ?`)
        .get(sessionId, userId);
    return row ? rowToBible(regFor(userId, sessionId), row) : null;
}
export async function synthesizeBible(userId, sessionId, signal) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    const reg = getBuildRegistry(session.build_type);
    const extraction = getExtraction(userId, sessionId);
    if (!extraction)
        throw new Error("Read the dream first — there is nothing to synthesize");
    const facts = extraction.committed_facts;
    const taste = getTaste(userId);
    const targets = partsToAuthor(reg, facts);
    const dream = session.seed.text;
    const sourceNoun = seedSourceNoun(session.seed.type);
    const dynamicEntries = getDynamicEntries(userId, sessionId);
    let usage = emptyUsage();
    const authoredAll = [];
    for (const group of reg.synthesisGroups) {
        const groupTargets = targets.filter((t) => slotSynthesisGroup(reg.slots, reg.synthesisGroups, t.slot) === group.id);
        if (groupTargets.length === 0)
            continue;
        const res = await weaverGenerateJsonWithUsage({
            userId,
            session,
            system: buildBibleSynthesisPrompt(reg, group, sourceNoun),
            user: buildBibleSynthesisUserMessage(reg, {
                dream,
                facts,
                taste,
                targets: groupTargets,
                priorAuthored: authoredAll,
                dynamic: dynamicEntries,
                source_noun: sourceNoun,
            }),
            temperature: 0.7,
            signal,
        });
        const authorable = new Set(groupTargets.map((t) => `${t.slot}:${t.part}`));
        authoredAll.push(...coerceAuthoredParts(reg.slots, res.data.authored, authorable));
        usage = addUsage(usage, res.usage);
    }
    const partial = assembleSpine(reg, facts, authoredAll, [], "", dynamicEntries);
    if (partial.entries.length === 0)
        throw new Error("The model returned an unusable Bible");
    const weaveRes = await weaverGenerateJsonWithUsage({
        userId,
        session,
        system: buildBibleWeavePrompt(reg),
        user: buildBibleWeaveUserMessage(reg, partial, dream, sourceNoun),
        temperature: 0.5,
        signal,
    });
    usage = addUsage(usage, weaveRes.usage);
    const spine = assembleSpine(reg, facts, authoredAll, weaveRes.data.causal_links, weaveRes.data.brief, dynamicEntries);
    const applicable = applicableBibleCriteria(reg.bibleGateCriteria, spine);
    const gateRes = await weaverGenerateJsonWithUsage({
        userId,
        session,
        system: buildBibleGatePrompt(reg, applicable),
        user: buildBibleGateUserMessage(reg, spine, dream, sourceNoun),
        temperature: 0.2,
        kind: "review",
        signal,
    });
    const verdict = buildGateVerdict(gateRes.data, applicable);
    const status = deriveStatus(verdict);
    usage = addUsage(usage, gateRes.usage);
    persist(userId, sessionId, spine, status, verdict, usage, Math.floor(Date.now() / 1000));
    setStage(userId, sessionId, "bible");
    return getBible(userId, sessionId);
}
export async function resynthesizeEntry(userId, sessionId, slotId, nudge, signal) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    const reg = getBuildRegistry(session.build_type);
    if (!isSlotId(reg.slots, slotId))
        throw new Error(`Unknown entry: ${slotId}`);
    const bible = getBible(userId, sessionId);
    if (!bible || bible.spine.entries.length === 0) {
        throw new Error("Synthesize a Bible first — there is nothing to redo");
    }
    const existingEntry = bible.spine.entries.find((e) => e.slot === slotId);
    if (!existingEntry)
        throw new Error("That entry isn't in the Bible");
    const extraction = getExtraction(userId, sessionId);
    if (!extraction)
        throw new Error("Read the dream first — there is nothing to synthesize");
    const facts = extraction.committed_facts;
    const targets = partsToAuthor(reg, facts).filter((t) => t.slot === slotId);
    if (targets.length === 0) {
        throw new Error("This entry is built from your own committed facts — edit it directly.");
    }
    const slot = reg.slots.find((s) => s.id === slotId);
    const group = reg.synthesisGroups.find((g) => g.id === slotSynthesisGroup(reg.slots, reg.synthesisGroups, slotId));
    const taste = getTaste(userId);
    const sourceNoun = seedSourceNoun(session.seed.type);
    const dynamicEntries = getDynamicEntries(userId, sessionId);
    // Every other entry's authored content gives the re-author pass coherence context.
    const priorAuthored = bible.spine.entries
        .filter((e) => e.slot !== slotId)
        .flatMap((e) => e.parts && e.parts.length > 0
        ? e.parts
            .filter((p) => p.origin !== "established")
            .map((p) => ({ slot: e.slot, part: p.id, content: p.content }))
        : e.origin !== "established"
            ? [{ slot: e.slot, part: e.slot, content: e.content }]
            : []);
    const res = await weaverGenerateJsonWithUsage({
        userId,
        session,
        system: buildBibleSynthesisPrompt(reg, group, sourceNoun),
        user: buildBibleSynthesisUserMessage(reg, {
            dream: session.seed.text,
            facts,
            taste,
            targets,
            priorAuthored,
            dynamic: dynamicEntries,
            source_noun: sourceNoun,
            nudge,
        }),
        temperature: 0.7,
        signal,
    });
    const authorable = new Set(targets.map((t) => `${t.slot}:${t.part}`));
    const authored = coerceAuthoredParts(reg.slots, res.data.authored, authorable);
    const authoredBy = new Map();
    if (existingEntry.parts && existingEntry.parts.length > 0) {
        for (const p of existingEntry.parts) {
            if (p.origin !== "established")
                authoredBy.set(`${slotId}:${p.id}`, p.content);
        }
    }
    else if (existingEntry.origin !== "established") {
        authoredBy.set(`${slotId}:${slotId}`, existingEntry.content);
    }
    for (const a of authored)
        authoredBy.set(`${a.slot}:${a.part}`, a.content);
    const rebuilt = buildSlotEntry(reg, slot, buildFactContent(reg, facts), authoredBy);
    if (!rebuilt)
        throw new Error("The model returned nothing usable for this entry");
    const entries = bible.spine.entries.map((e) => (e.slot === slotId ? rebuilt : e));
    const spine = { ...bible.spine, entries };
    const usage = addUsage(bible.token_usage, res.usage);
    persist(userId, sessionId, spine, "pending", bible.gate, usage, bible.gated_at);
    setStage(userId, sessionId, "bible");
    return getBible(userId, sessionId);
}
export async function gateBible(userId, sessionId, signal) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    const reg = getBuildRegistry(session.build_type);
    const bible = getBible(userId, sessionId);
    if (!bible)
        throw new Error("No Bible to check yet");
    const applicable = applicableBibleCriteria(reg.bibleGateCriteria, bible.spine);
    const gateRes = await weaverGenerateJsonWithUsage({
        userId,
        session,
        system: buildBibleGatePrompt(reg, applicable),
        user: buildBibleGateUserMessage(reg, bible.spine, session.seed.text, seedSourceNoun(session.seed.type)),
        temperature: 0.2,
        kind: "review",
        signal,
    });
    const verdict = buildGateVerdict(gateRes.data, applicable);
    const status = deriveStatus(verdict);
    const usage = addUsage(bible.token_usage, gateRes.usage);
    persist(userId, sessionId, bible.spine, status, verdict, usage, Math.floor(Date.now() / 1000));
    return getBible(userId, sessionId);
}
export function syncDynamicRegion(userId, sessionId) {
    const bible = getBible(userId, sessionId);
    if (!bible)
        return null;
    const known = new Set(bible.spine.dynamic.map((d) => d.id));
    const fresh = getDynamicEntries(userId, sessionId).filter((d) => !known.has(d.id));
    if (fresh.length === 0)
        return bible;
    const spine = {
        ...bible.spine,
        dynamic: [...bible.spine.dynamic, ...fresh],
    };
    persist(userId, sessionId, spine, bible.status, bible.gate, bible.token_usage, bible.gated_at);
    return getBible(userId, sessionId);
}
export function updateBible(userId, sessionId, input) {
    const reg = regFor(userId, sessionId);
    const bible = getBible(userId, sessionId);
    if (!bible)
        throw new Error("No Bible to edit yet");
    const entries = input.entries === undefined
        ? bible.spine.entries
        : input.entries
            .filter((e) => isSlotId(reg.slots, e.slot) && typeof e.content === "string" && e.content.trim())
            .map((e) => {
            const entry = {
                slot: e.slot,
                content: e.content.trim(),
                origin: coerceOrigin(e.origin),
            };
            return e.parts ? { ...entry, parts: parseEntryParts(e.parts) } : entry;
        });
    const causal_links = input.causal_links === undefined ? bible.spine.causal_links : coerceLinks(reg.slots, input.causal_links);
    const brief = input.brief === undefined ? bible.spine.brief : input.brief.trim();
    const spine = { entries, causal_links, brief, dynamic: bible.spine.dynamic };
    persist(userId, sessionId, spine, "pending", bible.gate, bible.token_usage, bible.gated_at);
    return getBible(userId, sessionId);
}
