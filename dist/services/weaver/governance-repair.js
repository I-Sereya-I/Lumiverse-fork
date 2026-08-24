import { getDb } from "../../db/connection";
import { GOVERNANCE_ROLE_ID, getWorldbookRole } from "./worldbook-roles";
import { createEntry, createWorldBook, getWorldBook, normalizeImportedEntries, normalizeImportedEntryInput, } from "../world-books.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
import * as charactersSvc from "../characters.service";
export function repairEmbeddedGovernance() {
    const rows = getDb()
        .prepare(`SELECT id, user_id FROM characters
        WHERE extensions LIKE '%"character_book"%' AND extensions LIKE '%"weaver"%'`)
        .all();
    let repaired = 0;
    for (const row of rows) {
        try {
            if (repairCharacter(row.user_id, row.id))
                repaired++;
        }
        catch (err) {
            console.warn(`[weaver] Governance repair failed for character ${row.id}:`, err);
        }
    }
    return repaired;
}
function repairCharacter(userId, characterId) {
    const character = charactersSvc.getCharacter(userId, characterId);
    if (!character)
        return false;
    const extensions = (character.extensions ?? {});
    const weaver = extensions.weaver;
    if (!weaver || typeof weaver !== "object" || weaver.source !== "weaver")
        return false;
    const embedded = extensions.character_book;
    const rawEntries = normalizeImportedEntries(embedded && typeof embedded === "object" ? embedded.entries : undefined);
    if (rawEntries.length === 0)
        return false;
    // Already repaired (or authored after the fix): a governance book is bound.
    const boundIds = getCharacterWorldBookIds(extensions);
    const hasGovernanceBook = boundIds.some((id) => {
        const meta = getWorldBook(userId, id)?.metadata;
        return meta?.weaver_role === GOVERNANCE_ROLE_ID && meta?.source_character_id === characterId;
    });
    if (hasGovernanceBook)
        return false;
    const role = getWorldbookRole(GOVERNANCE_ROLE_ID);
    const book = createWorldBook(userId, {
        name: role.bookName(character.name),
        description: role.bookDescription(character.name),
        metadata: {
            source: "weaver",
            weaver_role: role.id,
            weaver_session_id: typeof weaver.session_id === "string" ? weaver.session_id : "",
            source_character_id: characterId,
            auto_managed_by_character: true,
        },
    });
    for (const [i, raw] of rawEntries.entries()) {
        createEntry(userId, book.id, normalizeImportedEntryInput(raw, i));
    }
    const { character_book: _dropped, ...rest } = extensions;
    const next = setCharacterWorldBookIds(rest, [...boundIds, book.id]);
    charactersSvc.updateCharacter(userId, characterId, { extensions: next });
    return true;
}
