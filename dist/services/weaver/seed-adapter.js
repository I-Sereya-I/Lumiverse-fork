import { rawGenerate } from "../generate.service";
import { resolveConnection } from "../connections.service";
import { isSlotId, slotParts } from "./slots";
import { getBuildRegistry } from "./build-registry";
import { buildExtractionPrompt, buildExtractionUserMessage } from "./prompts";
function stripCodeFence(s) {
    const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return m ? m[1] : s;
}
function coercePart(slots, slot, value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const v = value.trim();
    return slotParts(slots, slot).some((p) => p.id === v) ? v : undefined;
}
function coerceFacts(slots, value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object")
            continue;
        const slot = raw.slot;
        const fact = raw.fact;
        if (!isSlotId(slots, slot))
            continue;
        if (typeof fact !== "string" || !fact.trim())
            continue;
        const part = coercePart(slots, slot, raw.part);
        out.push({ slot, ...(part ? { part } : {}), fact: fact.trim(), source: "extracted" });
    }
    return out;
}
function coerceGaps(slots, value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object")
            continue;
        const slot = raw.slot;
        const note = raw.note;
        if (!isSlotId(slots, slot))
            continue;
        out.push({
            slot,
            note: typeof note === "string" ? note.trim() : "",
            source: "extracted",
        });
    }
    return out;
}
async function runExtraction(userId, session, seedText, signal) {
    const reg = getBuildRegistry(session.build_type);
    const conn = resolveConnection(userId, session.connection_id || undefined);
    if (!conn)
        throw new Error("Weaver session has no connection configured");
    const model = session.model?.trim() || conn.model;
    if (!model)
        throw new Error("Weaver session has no model configured");
    const response = await rawGenerate(userId, {
        provider: conn.provider,
        model,
        connection_id: conn.id,
        messages: [
            { role: "system", content: buildExtractionPrompt(reg) },
            { role: "user", content: buildExtractionUserMessage(seedText) },
        ],
        parameters: { temperature: 0.4 },
        signal,
    });
    const content = stripCodeFence((response.content ?? "").trim());
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw new Error("Extraction returned invalid JSON");
    }
    const obj = parsed && typeof parsed === "object" ? parsed : {};
    return {
        committed_facts: coerceFacts(reg.slots, obj.committed_facts),
        gaps: coerceGaps(reg.slots, obj.gaps),
    };
}
const dreamAdapter = {
    type: "dream",
    sourceNoun: "dream",
    async extract(userId, session, signal) {
        const seedText = session.seed.text.trim();
        if (!seedText)
            throw new Error("Seed is empty — nothing to read back");
        const { committed_facts, gaps } = await runExtraction(userId, session, seedText, signal);
        return {
            committed_facts,
            gaps,
            raw_source_text: seedText,
            provenance: { ...session.seed.provenance, seed_type: session.seed.type },
        };
    },
};
const npcAdapter = { ...dreamAdapter, type: "npc", sourceNoun: "dossier" };
const cardAdapter = { ...dreamAdapter, type: "card", sourceNoun: "imported card" };
const worldbookAdapter = { ...dreamAdapter, type: "worldbook", sourceNoun: "imported worldbook" };
const ADAPTERS = [dreamAdapter, npcAdapter, cardAdapter, worldbookAdapter];
export function getSeedAdapter(seedType) {
    return ADAPTERS.find((a) => a.type === seedType) ?? dreamAdapter;
}
export function seedSourceNoun(seedType) {
    return getSeedAdapter(seedType).sourceNoun;
}
