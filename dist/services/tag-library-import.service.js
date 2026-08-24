import { getDb } from "../db/connection";
function stripUtf8Bom(value) {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeTagName(name) {
    return name.trim();
}
function dedupeStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}
function parseJsonRecord(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function parseJsonStringArray(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
    }
    catch {
        return [];
    }
}
export function normalizeTagLibraryFilename(value) {
    return value.split(/[\\/]/).pop()?.trim().toLowerCase() ?? "";
}
export function normalizeLooseCharacterKey(value) {
    return (value.split(/[\\/]/).pop() ?? value)
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function parseTagLibraryBackupJson(raw) {
    if (!isRecord(raw)) {
        throw new Error("TagLibrary backup must be a JSON object");
    }
    const tags = raw.tags;
    const tagMap = isRecord(raw.tag_map) ? raw.tag_map : isRecord(raw.tagMap) ? raw.tagMap : null;
    if (!Array.isArray(tags) || !isRecord(tagMap)) {
        throw new Error("TagLibrary backup must contain 'tags' and 'tag_map'");
    }
    const idToName = new Map();
    for (const entry of tags) {
        if (!isRecord(entry))
            continue;
        const id = entry.id;
        const name = entry.name;
        if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string")
            continue;
        const normalizedName = normalizeTagName(name);
        if (!normalizedName)
            continue;
        idToName.set(String(id), normalizedName);
    }
    const assignmentsByFilename = new Map();
    for (const [rawFilename, rawTagIds] of Object.entries(tagMap)) {
        if (!Array.isArray(rawTagIds))
            continue;
        const filename = normalizeTagLibraryFilename(rawFilename);
        if (!filename)
            continue;
        const tagNames = dedupeStrings(rawTagIds
            .map((tagId) => idToName.get(String(tagId)) ?? "")
            .map(normalizeTagName)
            .filter(Boolean));
        if (tagNames.length === 0)
            continue;
        assignmentsByFilename.set(filename, tagNames);
    }
    return {
        tagDefinitions: idToName.size,
        characterMappings: assignmentsByFilename.size,
        assignmentsByFilename,
    };
}
export function parseTagLibraryBackupText(text) {
    let raw;
    try {
        raw = JSON.parse(stripUtf8Bom(text));
    }
    catch {
        throw new Error("TagLibrary backup is not valid JSON");
    }
    return parseTagLibraryBackupJson(raw);
}
function buildFilenameIndex(characters, pickValue) {
    const index = new Map();
    for (const character of characters) {
        const rawValue = pickValue(character);
        if (!rawValue)
            continue;
        const key = normalizeTagLibraryFilename(rawValue);
        if (!key)
            continue;
        const existing = index.get(key);
        if (existing)
            existing.push(character);
        else
            index.set(key, [character]);
    }
    return index;
}
function buildNameIndex(characters) {
    const index = new Map();
    for (const character of characters) {
        const key = normalizeLooseCharacterKey(character.name);
        if (!key)
            continue;
        const existing = index.get(key);
        if (existing)
            existing.push(character);
        else
            index.set(key, [character]);
    }
    return index;
}
export function buildTagLibraryImportPlan(characters, backup) {
    const sourceFilenameIndex = buildFilenameIndex(characters, (character) => character.sourceFilename);
    const imageFilenameIndex = buildFilenameIndex(characters, (character) => character.imageOriginalFilename);
    const nameIndex = buildNameIndex(characters);
    const pendingTags = new Map();
    const matchSourceByCharacterId = new Map();
    const matchedBy = {
        source_filename: 0,
        image_original_filename: 0,
        normalized_name: 0,
    };
    const unmatchedFilenames = [];
    for (const [filename, tagNames] of backup.assignmentsByFilename.entries()) {
        let matched = sourceFilenameIndex.get(filename) ?? [];
        let matchedVia = "source_filename";
        if (matched.length === 0) {
            matched = imageFilenameIndex.get(filename) ?? [];
            matchedVia = "image_original_filename";
        }
        if (matched.length === 0) {
            matched = nameIndex.get(normalizeLooseCharacterKey(filename)) ?? [];
            matchedVia = "normalized_name";
        }
        if (matched.length === 0) {
            unmatchedFilenames.push(filename);
            continue;
        }
        for (const character of matched) {
            let tagSet = pendingTags.get(character.id);
            if (!tagSet) {
                tagSet = new Set(character.tags);
                pendingTags.set(character.id, tagSet);
            }
            for (const tagName of tagNames)
                tagSet.add(tagName);
            if (!matchSourceByCharacterId.has(character.id)) {
                matchSourceByCharacterId.set(character.id, matchedVia);
                matchedBy[matchedVia]++;
            }
        }
    }
    const characterById = new Map(characters.map((character) => [character.id, character]));
    const plans = [];
    for (const [characterId, tagSet] of pendingTags.entries()) {
        const character = characterById.get(characterId);
        if (!character)
            continue;
        const nextTags = dedupeStrings([...tagSet]);
        const currentTagSet = new Set(character.tags);
        const addedTags = nextTags.filter((tag) => !currentTagSet.has(tag));
        plans.push({
            characterId,
            nextTags,
            addedTags,
            matchedVia: matchSourceByCharacterId.get(characterId) ?? "source_filename",
        });
    }
    return { plans, matchedBy, unmatchedFilenames };
}
function listCharacterTagImportCandidates(userId) {
    const rows = getDb()
        .query(`SELECT c.id, c.name, c.tags, c.extensions, i.original_filename AS image_original_filename
       FROM characters c
       LEFT JOIN images i ON i.id = c.image_id
       WHERE c.user_id = ?`)
        .all(userId);
    return rows.map((row) => {
        const extensions = parseJsonRecord(row.extensions);
        return {
            id: row.id,
            name: row.name,
            tags: parseJsonStringArray(row.tags),
            sourceFilename: typeof extensions._lumiverse_source_filename === "string" ? extensions._lumiverse_source_filename : null,
            imageOriginalFilename: row.image_original_filename,
        };
    });
}
export async function importTagLibraryBackup(userId, file) {
    if (!file || file.size === 0) {
        throw new Error("TagLibrary backup file is required");
    }
    const backup = parseTagLibraryBackupText(await file.text());
    const characters = listCharacterTagImportCandidates(userId);
    const { plans, matchedBy, unmatchedFilenames } = buildTagLibraryImportPlan(characters, backup);
    let updatedCharacters = 0;
    let unchangedCharacters = 0;
    let addedTags = 0;
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();
    const updateStmt = db.query("UPDATE characters SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?");
    db.transaction(() => {
        for (const plan of plans) {
            if (plan.addedTags.length === 0) {
                unchangedCharacters++;
                continue;
            }
            updateStmt.run(JSON.stringify(plan.nextTags), now, plan.characterId, userId);
            updatedCharacters++;
            addedTags += plan.addedTags.length;
        }
    })();
    return {
        tagDefinitions: backup.tagDefinitions,
        characterMappings: backup.characterMappings,
        matchedCharacters: plans.length,
        updatedCharacters,
        unchangedCharacters,
        unmatchedMappings: unmatchedFilenames.length,
        addedTags,
        matchedBy,
        unmatchedFilenames: unmatchedFilenames.slice(0, 50),
    };
}
