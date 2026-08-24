import { getBuildRegistry } from "./build-registry";
import { ensureGovernanceForContext } from "./finalize.service";
import { findBoundRoleBook } from "./worldbook-render.service";
import { GOVERNANCE_ROLE_ID } from "./worldbook-roles";
import { getBible } from "./bible.service";
import { listEntries, updateEntry } from "../world-books.service";
import * as charactersSvc from "../characters.service";
function governanceEntries(userId, character) {
    const book = findBoundRoleBook(userId, character, GOVERNANCE_ROLE_ID);
    return book ? listEntries(userId, book.id) : [];
}
export function normalizeAgencyMaterial(input) {
    const agenda = typeof input.agenda === "string" ? input.agenda.trim() : "";
    if (!agenda)
        return null;
    const holds = [];
    if (Array.isArray(input.holds)) {
        for (const raw of input.holds) {
            if (typeof raw !== "string")
                continue;
            const hold = raw.trim();
            if (hold && !holds.includes(hold))
                holds.push(hold);
        }
    }
    return { agenda, holds };
}
export function agencyMaterialFromExtension(extensions, module) {
    const weaver = (extensions ?? {}).weaver;
    if (!weaver || typeof weaver !== "object")
        return null;
    const structured = weaver.structured;
    if (!structured || typeof structured !== "object")
        return null;
    const slot = structured[module.slotId];
    if (!slot || typeof slot !== "object")
        return null;
    const record = slot;
    const parts = Array.isArray(record.parts) ? record.parts : [];
    const partContent = (id) => {
        const part = parts.find((p) => p.id === id);
        return typeof part?.content === "string" ? part.content.trim() : "";
    };
    const agenda = partContent(module.agendaPart);
    const holds = partContent(module.holdsPart);
    if (agenda || holds) {
        return { agenda, holds: holds ? holds.split("\n").map((h) => h.trim()).filter(Boolean) : [] };
    }
    const content = typeof record.content === "string" ? record.content.trim() : "";
    return content ? { agenda: content, holds: [] } : null;
}
export function withAgencyExtension(extensions, module, material) {
    const base = { ...(extensions ?? {}) };
    const weaver = base.weaver && typeof base.weaver === "object"
        ? { ...base.weaver }
        : {};
    const structured = weaver.structured && typeof weaver.structured === "object"
        ? { ...weaver.structured }
        : {};
    const holdsContent = material.holds.join("\n");
    structured[module.slotId] = {
        content: [material.agenda, holdsContent].filter(Boolean).join("\n"),
        parts: [
            { id: module.agendaPart, content: material.agenda, origin: "authored" },
            { id: module.holdsPart, content: holdsContent, origin: "authored" },
        ],
    };
    return { ...base, weaver: { ...weaver, structured } };
}
export function deriveAgencyState(module, character, entries) {
    const data = entries.find((e) => e.comment === module.dataEntryComment);
    const material = agencyMaterialFromExtension((character.extensions ?? {}), module);
    return {
        present: Boolean(data),
        enabled: Boolean(data) && !data.disabled,
        agenda: material?.agenda ?? "",
        holds: material?.holds ?? [],
    };
}
function requireModule(session) {
    const module = getBuildRegistry(session.build_type).agency;
    if (!module)
        throw new Error("This build type has no agency");
    return module;
}
function requireCharacter(userId, session) {
    const character = session.character_id
        ? charactersSvc.getCharacter(userId, session.character_id)
        : null;
    if (!character)
        throw new Error("The finalized card no longer exists");
    return character;
}
export function getAgencyState(userId, session) {
    const module = getBuildRegistry(session.build_type).agency;
    if (!module)
        return null;
    const character = requireCharacter(userId, session);
    return deriveAgencyState(module, character, governanceEntries(userId, character));
}
function setAgencyEntriesEnabled(userId, module, entries, enabled) {
    const match = new Set([module.governanceComment, module.dataEntryComment]);
    for (const entry of entries) {
        if (match.has(entry.comment) && entry.disabled !== !enabled) {
            updateEntry(userId, entry.id, { disabled: !enabled });
        }
    }
}
export function setAgencyEnabled(userId, session, enabled) {
    const module = requireModule(session);
    const character = requireCharacter(userId, session);
    const entries = governanceEntries(userId, character);
    const present = entries.some((e) => e.comment === module.dataEntryComment);
    if (!present) {
        if (enabled)
            throw new Error("Write an agenda first — there is nothing to turn on");
        return deriveAgencyState(module, character, entries);
    }
    setAgencyEntriesEnabled(userId, module, entries, enabled);
    return deriveAgencyState(module, character, governanceEntries(userId, character));
}
export function updateAgency(userId, session, input) {
    const module = requireModule(session);
    const material = normalizeAgencyMaterial(input);
    if (!material)
        throw new Error("An agenda is required");
    const reg = getBuildRegistry(session.build_type);
    const bible = getBible(userId, session.id);
    if (!bible)
        throw new Error("The session's Bible no longer exists");
    let character = requireCharacter(userId, session);
    character = ensureGovernanceForContext(userId, session, character, { agency: material });
    const wanted = reg.governanceEntries(bible.spine, { agency: material });
    const dataContent = String(wanted.find((e) => e.comment === module.dataEntryComment)?.content ?? "");
    const entries = governanceEntries(userId, character);
    const data = entries.find((e) => e.comment === module.dataEntryComment);
    if (data && data.content !== dataContent) {
        updateEntry(userId, data.id, { content: dataContent });
    }
    setAgencyEntriesEnabled(userId, module, entries, true);
    const extensions = withAgencyExtension((character.extensions ?? {}), module, material);
    const updated = charactersSvc.updateCharacter(userId, character.id, { extensions }) ?? character;
    return deriveAgencyState(module, updated, governanceEntries(userId, updated));
}
