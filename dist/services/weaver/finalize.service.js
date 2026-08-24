import { getSession, updateSession } from "./session.service";
import { getBible } from "./bible.service";
import { getFields } from "./render.service";
import { commitPersona } from "./persona-build.service";
import { getBuildRegistry } from "./build-registry";
import { ensureRoleBook, renderBackingWorldbook } from "./worldbook-render.service";
import { DEPTH_ROLE_ID, GOVERNANCE_ROLE_ID, getWorldbookRole } from "./worldbook-roles";
import { createEntry, getWorldBook, listEntries, normalizeImportedEntryInput, } from "../world-books.service";
import * as charactersSvc from "../characters.service";
import * as chatsSvc from "../chats.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
const WEAVER_CREATOR = "Lumiverse Weaver";
const WEAVER_TAG = "weaver";
const WEAVER_EXTENSION_SCHEMA = 1;
function isFieldReady(field) {
    if (!field || !field.content.trim())
        return false;
    return field.status === "passed" || field.status === "manually_edited" || field.provenance.accepted === true;
}
export function splitListField(content, separator) {
    const token = separator.trim();
    const trimmed = content.trim();
    if (!token)
        return trimmed ? [trimmed] : [];
    const parts = [];
    let buf = [];
    for (const line of content.split("\n")) {
        if (line.trim() === token) {
            parts.push(buf.join("\n"));
            buf = [];
        }
        else {
            buf.push(line);
        }
    }
    parts.push(buf.join("\n"));
    return parts.map((p) => p.trim()).filter(Boolean);
}
export function applyFieldsToCard(base, defs, contentFor) {
    const card = { ...base };
    for (const def of defs) {
        const content = contentFor(def.id);
        card[def.charlField] = def.list ? splitListField(content, def.list.separator) : content;
    }
    return card;
}
function buildWeaverExtension(sessionId, spine, extensionSlots) {
    const structured = {};
    for (const slot of extensionSlots) {
        const entry = spine.entries.find((e) => e.slot === slot);
        if (!entry || !entry.content.trim())
            continue;
        structured[slot] = entry.parts ? { content: entry.content, parts: entry.parts } : { content: entry.content };
    }
    return {
        schema: WEAVER_EXTENSION_SCHEMA,
        source: "weaver",
        session_id: sessionId,
        structured,
    };
}
export function provenanceBindBookIds(provenance) {
    if (!provenance || typeof provenance !== "object")
        return [];
    const raw = provenance.bind_world_book_ids;
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const id of raw) {
        if (typeof id === "string" && id.trim() && !out.includes(id.trim()))
            out.push(id.trim());
    }
    return out;
}
export function provenanceAvatarImageId(provenance) {
    if (!provenance || typeof provenance !== "object")
        return null;
    const raw = provenance.avatar_image_id;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
export function missingGovernanceEntries(existing, wanted) {
    const have = new Set(existing.map((e) => (typeof e.comment === "string" ? e.comment : "")).filter(Boolean));
    return wanted.filter((w) => typeof w.comment === "string" && w.comment && !have.has(w.comment));
}
export function ensureGovernanceForContext(userId, session, character, ctx) {
    const reg = getBuildRegistry(session.build_type);
    const bible = getBible(userId, session.id);
    if (!bible)
        return character;
    const wanted = [
        reg.reanchorEntry(character.name, bible.spine),
        ...reg.governanceEntries(bible.spine, ctx),
    ];
    const ensured = ensureRoleBook(userId, session, GOVERNANCE_ROLE_ID, character);
    const existing = listEntries(userId, ensured.book.id);
    const missing = missingGovernanceEntries(existing, wanted);
    for (const [i, entry] of missing.entries()) {
        createEntry(userId, ensured.book.id, normalizeImportedEntryInput(entry, existing.length + i));
    }
    return ensured.character;
}
function requestedBooks(options) {
    return {
        ...(options.depthBook === undefined ? {} : { [DEPTH_ROLE_ID]: options.depthBook }),
        ...options.books,
    };
}
async function attachBackingBook(userId, session, roleId, character) {
    try {
        const book = await renderBackingWorldbook(userId, session, roleId, character);
        if (!book)
            return { character, book: null };
        const ids = getCharacterWorldBookIds(character.extensions);
        const extensions = setCharacterWorldBookIds(character.extensions ?? {}, [...ids, book.id]);
        const updated = charactersSvc.updateCharacter(userId, character.id, { extensions });
        return { character: updated ?? character, book };
    }
    catch (err) {
        const role = getWorldbookRole(roleId);
        const message = err instanceof Error ? err.message : `${role?.label ?? roleId} render failed`;
        return { character, book: null, error: message };
    }
}
export async function finalizeSession(userId, sessionId, options = {}) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    const reg = getBuildRegistry(session.build_type);
    const bible = getBible(userId, sessionId);
    if (!bible || bible.spine.entries.length === 0) {
        throw new Error("Synthesize a Bible first — there is nothing to finalize from");
    }
    const fields = getFields(userId, sessionId);
    const byName = new Map(fields.map((f) => [f.field_name, f]));
    const notReady = reg.fieldDefs.filter((def) => !isFieldReady(byName.get(def.id)));
    if (notReady.length > 0) {
        const labels = notReady.map((def) => def.label).join(", ");
        throw new Error(`Render and accept every field before finalizing — still pending: ${labels}`);
    }
    const fieldContent = (id) => byName.get(id).content.trim();
    const name = fieldContent("name");
    const plan = session.persona_plan;
    const pairedGreeting = plan?.enabled && plan.pairing.greeting && plan.pairing.greeting_text.trim()
        ? plan.pairing.greeting_text.trim()
        : "";
    const base = {
        name,
        system_prompt: "",
        post_history_instructions: "",
        creator: WEAVER_CREATOR,
        creator_notes: reg.creatorNotes,
        tags: [WEAVER_TAG],
        alternate_greetings: pairedGreeting ? [pairedGreeting] : [],
        extensions: {
            weaver: buildWeaverExtension(sessionId, bible.spine, reg.extensionSlots),
        },
    };
    const input = applyFieldsToCard(base, reg.fieldDefs, fieldContent);
    const existing = session.character_id
        ? charactersSvc.getCharacter(userId, session.character_id)
        : null;
    const books = {};
    const bookErrors = {};
    let committedPersonaId = null;
    let created;
    if (existing) {
        const update = {};
        for (const def of reg.fieldDefs) {
            const content = fieldContent(def.id);
            update[def.charlField] = def.list
                ? splitListField(content, def.list.separator)
                : content;
        }
        update.extensions = {
            ...(existing.extensions ?? {}),
            weaver: buildWeaverExtension(sessionId, bible.spine, reg.extensionSlots),
        };
        created = charactersSvc.updateCharacter(userId, existing.id, update) ?? existing;
    }
    else {
        created = charactersSvc.createCharacter(userId, input);
    }
    let character = ensureGovernanceForContext(userId, session, created, {});
    if (!existing) {
        const wanted = requestedBooks(options);
        for (const roleId of reg.finalizeBookRoles) {
            const role = getWorldbookRole(roleId);
            if (!role)
                continue;
            if (!(wanted[roleId] ?? role.defaultEnabled))
                continue;
            const attached = await attachBackingBook(userId, session, roleId, character);
            character = attached.character;
            books[roleId] = attached.book;
            if (attached.error)
                bookErrors[roleId] = attached.error;
        }
        const seedBookIds = provenanceBindBookIds(session.seed.provenance).filter((id) => Boolean(getWorldBook(userId, id)));
        if (seedBookIds.length > 0) {
            const current = getCharacterWorldBookIds(character.extensions);
            const fresh = seedBookIds.filter((id) => !current.includes(id));
            if (fresh.length > 0) {
                const extensions = setCharacterWorldBookIds(character.extensions ?? {}, [...current, ...fresh]);
                character = charactersSvc.updateCharacter(userId, character.id, { extensions }) ?? character;
            }
        }
        const avatarImageId = provenanceAvatarImageId(session.seed.provenance);
        if (avatarImageId) {
            character = charactersSvc.setCharacterAvatarFromImage(userId, character.id, avatarImageId) ?? character;
        }
        if (plan?.enabled && plan.draft) {
            committedPersonaId = commitPersona(userId, session, plan.draft).id;
        }
    }
    const boundPersonaId = committedPersonaId ?? session.persona_id;
    updateSession(userId, sessionId, {
        stage: "finalize",
        status: "finalized",
        character_id: created.id,
        ...(committedPersonaId ? { persona_id: committedPersonaId } : {}),
    });
    return {
        character,
        books,
        ...(Object.keys(bookErrors).length > 0 ? { book_errors: bookErrors } : {}),
        depth_book: books[DEPTH_ROLE_ID] ?? null,
        ...(bookErrors[DEPTH_ROLE_ID] ? { depth_book_error: bookErrors[DEPTH_ROLE_ID] } : {}),
        persona_id: boundPersonaId,
    };
}
export function startChat(userId, sessionId) {
    const session = getSession(userId, sessionId);
    if (!session)
        throw new Error("Session not found");
    if (!session.character_id)
        throw new Error("Finalize the card first — there is nothing to start a chat with");
    const chat = chatsSvc.createChat(userId, { character_id: session.character_id });
    updateSession(userId, sessionId, { launch_chat_id: chat.id });
    return { chat };
}
