import { getDb } from "../db/connection";
import { paginatedQuery } from "./pagination";
import * as regexScriptsSvc from "./regex-scripts.service";
// --- Row mappers ---
function rowToPack(row) {
    return {
        ...row,
        is_custom: !!row.is_custom,
        extras: JSON.parse(row.extras),
    };
}
function rowToLumiaItem(row) {
    return { ...row };
}
function rowToLoomItem(row) {
    return { ...row };
}
function rowToLoomTool(row) {
    return {
        ...row,
        store_in_deliberation: !!row.store_in_deliberation,
        input_schema: JSON.parse(row.input_schema),
    };
}
// --- Pack CRUD ---
export function listPacks(userId, pagination) {
    return paginatedQuery("SELECT * FROM packs WHERE user_id = ? ORDER BY updated_at DESC", "SELECT COUNT(*) as count FROM packs WHERE user_id = ?", [userId], pagination, rowToPack);
}
export function getPack(userId, id) {
    const row = getDb().query("SELECT * FROM packs WHERE id = ? AND user_id = ?").get(id, userId);
    return row ? rowToPack(row) : null;
}
export function createPack(userId, input) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO packs (id, user_id, name, author, cover_url, version, is_custom, source_url, extras, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, input.name, input.author || "", input.cover_url || null, input.version || "1.0.0", input.is_custom !== false ? 1 : 0, input.source_url || null, JSON.stringify(input.extras || {}), now, now);
    return getPack(userId, id);
}
export function updatePack(userId, id, input) {
    const existing = getPack(userId, id);
    if (!existing)
        return null;
    const fields = [];
    const values = [];
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.author !== undefined) {
        fields.push("author = ?");
        values.push(input.author);
    }
    if (input.cover_url !== undefined) {
        fields.push("cover_url = ?");
        values.push(input.cover_url);
    }
    if (input.version !== undefined) {
        fields.push("version = ?");
        values.push(input.version);
    }
    if (input.is_custom !== undefined) {
        fields.push("is_custom = ?");
        values.push(input.is_custom ? 1 : 0);
    }
    if (input.source_url !== undefined) {
        fields.push("source_url = ?");
        values.push(input.source_url);
    }
    if (input.extras !== undefined) {
        fields.push("extras = ?");
        values.push(JSON.stringify(input.extras));
    }
    if (fields.length === 0)
        return existing;
    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    values.push(userId);
    getDb().query(`UPDATE packs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
    return getPack(userId, id);
}
export function deletePack(userId, id) {
    return getDb().query("DELETE FROM packs WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
export function repairOldLumiverseGenderMapping(userId, id) {
    const pack = getPack(userId, id);
    if (!pack)
        return null;
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
        const items = db.query("SELECT id, gender_identity FROM lumia_items WHERE pack_id = ?").all(id);
        const updateStmt = db.query("UPDATE lumia_items SET gender_identity = ?, updated_at = ? WHERE id = ?");
        for (const item of items) {
            updateStmt.run(remapLegacyLumiverseGenderIdentity(item.gender_identity), now, item.id);
        }
        db.query("UPDATE packs SET updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
    })();
    return getPackWithItems(userId, id);
}
// Prepared statements for pack item queries (avoid re-compiling on every call)
let _stmtPackById = null;
let _stmtLumiaByPack = null;
let _stmtLoomByPack = null;
let _stmtToolsByPack = null;
let _packStmtsGen = -1;
function getPackStmts() {
    const db = getDb();
    // Invalidate cached statements when the underlying Database is replaced
    // (reset/reopen); statements bound to a closed DB throw on reuse.
    const gen = require("../db/connection").getDbGeneration();
    if (_packStmtsGen !== gen) {
        _stmtPackById = null;
        _stmtLumiaByPack = null;
        _stmtLoomByPack = null;
        _stmtToolsByPack = null;
        _packStmtsGen = gen;
    }
    if (!_stmtPackById)
        _stmtPackById = db.query("SELECT * FROM packs WHERE id = ? AND user_id = ?");
    if (!_stmtLumiaByPack)
        _stmtLumiaByPack = db.query("SELECT * FROM lumia_items WHERE pack_id = ? ORDER BY sort_order ASC");
    if (!_stmtLoomByPack)
        _stmtLoomByPack = db.query("SELECT * FROM loom_items WHERE pack_id = ? ORDER BY sort_order ASC");
    if (!_stmtToolsByPack)
        _stmtToolsByPack = db.query("SELECT * FROM loom_tools WHERE pack_id = ? ORDER BY sort_order ASC");
    return { packById: _stmtPackById, lumiaByPack: _stmtLumiaByPack, loomByPack: _stmtLoomByPack, toolsByPack: _stmtToolsByPack };
}
export function getPackWithItems(userId, id) {
    const stmts = getPackStmts();
    const row = stmts.packById.get(id, userId);
    if (!row)
        return null;
    const pack = rowToPack(row);
    const lumia_items = stmts.lumiaByPack.all(id).map(rowToLumiaItem);
    const loom_items = stmts.loomByPack.all(id).map(rowToLoomItem);
    const loom_tools = stmts.toolsByPack.all(id).map(rowToLoomTool);
    const regex_scripts = regexScriptsSvc.getRegexScriptsByPackId(userId, id);
    return { ...pack, lumia_items, loom_items, loom_tools, regex_scripts };
}
/** List all packs with their items in a single efficient batch. */
export function listPacksWithItems(userId, pagination) {
    const result = listPacks(userId, pagination);
    if (result.data.length === 0)
        return { ...result, data: [] };
    const stmts = getPackStmts();
    const packsWithItems = result.data.map((pack) => {
        const lumia_items = stmts.lumiaByPack.all(pack.id).map(rowToLumiaItem);
        const loom_items = stmts.loomByPack.all(pack.id).map(rowToLoomItem);
        const loom_tools = stmts.toolsByPack.all(pack.id).map(rowToLoomTool);
        const regex_scripts = regexScriptsSvc.getRegexScriptsByPackId(userId, pack.id);
        return { ...pack, lumia_items, loom_items, loom_tools, regex_scripts };
    });
    return { ...result, data: packsWithItems };
}
// --- Lumia Item CRUD ---
export function listLumiaItems(userId, packId) {
    const pack = getPack(userId, packId);
    if (!pack)
        return [];
    return getDb().query("SELECT * FROM lumia_items WHERE pack_id = ? ORDER BY sort_order ASC").all(packId).map(rowToLumiaItem);
}
export function getLumiaItem(userId, id) {
    const row = getDb().query("SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE li.id = ? AND p.user_id = ?").get(id, userId);
    return row ? rowToLumiaItem(row) : null;
}
export function createLumiaItem(userId, packId, input) {
    const pack = getPack(userId, packId);
    if (!pack)
        return null;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO lumia_items (id, pack_id, name, avatar_url, author_name, definition, personality, behavior, gender_identity, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, packId, input.name, input.avatar_url || null, input.author_name || "", input.definition || "", input.personality || "", input.behavior || "", input.gender_identity ?? 3, input.version || "1.0.0", input.sort_order ?? 0, now, now);
    return getLumiaItem(userId, id);
}
export function updateLumiaItem(userId, id, input) {
    const existing = getLumiaItem(userId, id);
    if (!existing)
        return null;
    const fields = [];
    const values = [];
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.avatar_url !== undefined) {
        fields.push("avatar_url = ?");
        values.push(input.avatar_url);
    }
    if (input.author_name !== undefined) {
        fields.push("author_name = ?");
        values.push(input.author_name);
    }
    if (input.definition !== undefined) {
        fields.push("definition = ?");
        values.push(input.definition);
    }
    if (input.personality !== undefined) {
        fields.push("personality = ?");
        values.push(input.personality);
    }
    if (input.behavior !== undefined) {
        fields.push("behavior = ?");
        values.push(input.behavior);
    }
    if (input.gender_identity !== undefined) {
        fields.push("gender_identity = ?");
        values.push(input.gender_identity);
    }
    if (input.version !== undefined) {
        fields.push("version = ?");
        values.push(input.version);
    }
    if (input.sort_order !== undefined) {
        fields.push("sort_order = ?");
        values.push(input.sort_order);
    }
    if (fields.length === 0)
        return existing;
    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    getDb().query(`UPDATE lumia_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getLumiaItem(userId, id);
}
export function deleteLumiaItem(userId, id) {
    const item = getLumiaItem(userId, id);
    if (!item)
        return false;
    return getDb().query("DELETE FROM lumia_items WHERE id = ?").run(id).changes > 0;
}
// --- Loom Item CRUD ---
export function listLoomItems(userId, packId) {
    const pack = getPack(userId, packId);
    if (!pack)
        return [];
    return getDb().query("SELECT * FROM loom_items WHERE pack_id = ? ORDER BY sort_order ASC").all(packId).map(rowToLoomItem);
}
export function getLoomItem(userId, id) {
    const row = getDb().query("SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE li.id = ? AND p.user_id = ?").get(id, userId);
    return row ? rowToLoomItem(row) : null;
}
export function createLoomItem(userId, packId, input) {
    const pack = getPack(userId, packId);
    if (!pack)
        return null;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO loom_items (id, pack_id, name, content, category, author_name, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, packId, input.name, input.content || "", input.category || "narrative_style", input.author_name || "", input.version || "1.0.0", input.sort_order ?? 0, now, now);
    return getLoomItem(userId, id);
}
export function updateLoomItem(userId, id, input) {
    const existing = getLoomItem(userId, id);
    if (!existing)
        return null;
    const fields = [];
    const values = [];
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.content !== undefined) {
        fields.push("content = ?");
        values.push(input.content);
    }
    if (input.category !== undefined) {
        fields.push("category = ?");
        values.push(input.category);
    }
    if (input.author_name !== undefined) {
        fields.push("author_name = ?");
        values.push(input.author_name);
    }
    if (input.version !== undefined) {
        fields.push("version = ?");
        values.push(input.version);
    }
    if (input.sort_order !== undefined) {
        fields.push("sort_order = ?");
        values.push(input.sort_order);
    }
    if (fields.length === 0)
        return existing;
    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    getDb().query(`UPDATE loom_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getLoomItem(userId, id);
}
export function deleteLoomItem(userId, id) {
    const item = getLoomItem(userId, id);
    if (!item)
        return false;
    return getDb().query("DELETE FROM loom_items WHERE id = ?").run(id).changes > 0;
}
// --- Loom Tool CRUD ---
export function listLoomTools(userId, packId) {
    const pack = getPack(userId, packId);
    if (!pack)
        return [];
    return getDb().query("SELECT * FROM loom_tools WHERE pack_id = ? ORDER BY sort_order ASC").all(packId).map(rowToLoomTool);
}
export function getLoomTool(userId, id) {
    const row = getDb().query("SELECT lt.* FROM loom_tools lt JOIN packs p ON lt.pack_id = p.id WHERE lt.id = ? AND p.user_id = ?").get(id, userId);
    return row ? rowToLoomTool(row) : null;
}
export function createLoomTool(userId, packId, input) {
    const pack = getPack(userId, packId);
    if (!pack)
        return null;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO loom_tools (id, pack_id, tool_name, display_name, description, prompt, input_schema, result_variable, store_in_deliberation, author_name, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, packId, input.tool_name, input.display_name || "", input.description || "", input.prompt || "", JSON.stringify(input.input_schema || {}), input.result_variable || "", input.store_in_deliberation ? 1 : 0, input.author_name || "", input.version || "1.0.0", input.sort_order ?? 0, now, now);
    return getLoomTool(userId, id);
}
export function updateLoomTool(userId, id, input) {
    const existing = getLoomTool(userId, id);
    if (!existing)
        return null;
    const fields = [];
    const values = [];
    if (input.tool_name !== undefined) {
        fields.push("tool_name = ?");
        values.push(input.tool_name);
    }
    if (input.display_name !== undefined) {
        fields.push("display_name = ?");
        values.push(input.display_name);
    }
    if (input.description !== undefined) {
        fields.push("description = ?");
        values.push(input.description);
    }
    if (input.prompt !== undefined) {
        fields.push("prompt = ?");
        values.push(input.prompt);
    }
    if (input.input_schema !== undefined) {
        fields.push("input_schema = ?");
        values.push(JSON.stringify(input.input_schema));
    }
    if (input.result_variable !== undefined) {
        fields.push("result_variable = ?");
        values.push(input.result_variable);
    }
    if (input.store_in_deliberation !== undefined) {
        fields.push("store_in_deliberation = ?");
        values.push(input.store_in_deliberation ? 1 : 0);
    }
    if (input.author_name !== undefined) {
        fields.push("author_name = ?");
        values.push(input.author_name);
    }
    if (input.version !== undefined) {
        fields.push("version = ?");
        values.push(input.version);
    }
    if (input.sort_order !== undefined) {
        fields.push("sort_order = ?");
        values.push(input.sort_order);
    }
    if (fields.length === 0)
        return existing;
    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    getDb().query(`UPDATE loom_tools SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getLoomTool(userId, id);
}
export function deleteLoomTool(userId, id) {
    const item = getLoomTool(userId, id);
    if (!item)
        return false;
    return getDb().query("DELETE FROM loom_tools WHERE id = ?").run(id).changes > 0;
}
// --- Cross-pack queries ---
/** Fetch multiple Lumia items by IDs in a single query (used by council member loading). */
export function getLumiaItemsByIds(userId, ids) {
    if (ids.length === 0)
        return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
        .query(`SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE li.id IN (${placeholders}) AND p.user_id = ?`)
        .all(...ids, userId);
    const result = new Map();
    for (const row of rows) {
        result.set(row.id, rowToLumiaItem(row));
    }
    return result;
}
/** Fetch every Lumia item across all packs for a user (used by randomLumia macro). */
export function getAllLumiaItems(userId) {
    return getDb()
        .query("SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? ORDER BY li.name ASC")
        .all(userId).map(rowToLumiaItem);
}
/** Fetch every Loom item across all packs for a user, optionally filtered by category. */
export function getAllLoomItems(userId, category) {
    if (category) {
        return getDb()
            .query("SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? AND li.category = ? ORDER BY li.name ASC")
            .all(userId, category).map(rowToLoomItem);
    }
    return getDb()
        .query("SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? ORDER BY li.name ASC")
        .all(userId).map(rowToLoomItem);
}
/**
 * Return every DLC item available to a user in a single read-only catalog.
 * Pack metadata is deliberately reduced to the extension-safe subset; the
 * ownership id and arbitrary pack extras are not surfaced to extensions.
 */
export function getLumiaDlcCatalog(userId) {
    const db = getDb();
    const packs = db
        .query(`SELECT id, name, author, cover_url, version, is_custom, source_url, created_at, updated_at
       FROM packs
       WHERE user_id = ?
       ORDER BY name COLLATE NOCASE ASC, id ASC`)
        .all(userId)
        .map((row) => ({
        ...row,
        is_custom: !!row.is_custom,
    }));
    const lumiaItems = db
        .query(`SELECT li.*
       FROM lumia_items li
       JOIN packs p ON li.pack_id = p.id
       WHERE p.user_id = ?
       ORDER BY p.name COLLATE NOCASE ASC, li.sort_order ASC, li.name COLLATE NOCASE ASC, li.id ASC`)
        .all(userId)
        .map(rowToLumiaItem);
    const loomItems = db
        .query(`SELECT li.*
       FROM loom_items li
       JOIN packs p ON li.pack_id = p.id
       WHERE p.user_id = ?
       ORDER BY p.name COLLATE NOCASE ASC, li.sort_order ASC, li.name COLLATE NOCASE ASC, li.id ASC`)
        .all(userId)
        .map(rowToLoomItem);
    const narrativeStyles = [];
    const utilities = [];
    const retrofits = [];
    for (const item of loomItems) {
        if (item.category === "loom_utility") {
            utilities.push(item);
        }
        else if (item.category === "retrofit") {
            retrofits.push(item);
        }
        else {
            // Pack imports normalize unknown categories to narrative styles. Keep the
            // catalog equally resilient to legacy rows that predate that validation.
            narrativeStyles.push(item);
        }
    }
    const tools = db
        .query(`SELECT lt.*
       FROM loom_tools lt
       JOIN packs p ON lt.pack_id = p.id
       WHERE p.user_id = ?
       ORDER BY p.name COLLATE NOCASE ASC, lt.sort_order ASC, lt.tool_name COLLATE NOCASE ASC, lt.id ASC`)
        .all(userId)
        .map(rowToLoomTool);
    return { packs, lumiaItems, narrativeStyles, utilities, retrofits, tools };
}
// --- Import / Export ---
/**
 * Normalizes a raw pack payload to PackImportPayload format.
 * Handles:
 * - Extension format fields (packName, lumiaName, lumiaDefinition, loomName, loomContent, etc.)
 * - Wrapper objects ({ pack: {...} } or { success: true, pack: {...} })
 * - snake_case tool fields (tool_name, display_name, input_schema, etc.)
 * - Category normalization (utility/utilities → loom_utility, etc.)
 */
function normalizeImportedGenderIdentity(value) {
    const num = Number(value);
    if (num === 0 || num === 1 || num === 2 || num === 3)
        return num;
    return 3;
}
function remapLegacyLumiverseGenderIdentity(value) {
    const num = Number(value);
    if (num === 0)
        return 3;
    if (num === 1)
        return 0;
    if (num === 2)
        return 1;
    return 3;
}
function normalizePackPayload(raw) {
    // Unwrap { pack: {...} } wrapper
    const data = raw.pack && typeof raw.pack === "object" && !Array.isArray(raw.pack) ? raw.pack : raw;
    // If it already has standard `name` + `lumiaItems` array with `definition` fields, it's likely
    // already in PackImportPayload format. But we still normalize to handle mixed formats.
    const normCategory = (c) => {
        const lower = (c || "").toLowerCase();
        if (lower.includes("utility") || lower.includes("utilities"))
            return "loom_utility";
        if (lower.includes("retrofit"))
            return "retrofit";
        return "narrative_style";
    };
    return {
        name: data.name || data.packName || undefined,
        author: data.author ?? data.packAuthor ?? undefined,
        coverUrl: data.coverUrl || undefined,
        version: data.version != null ? String(data.version) : undefined,
        sourceUrl: data.sourceUrl || data.source_url || undefined,
        extras: data.extras ?? (data.packExtras?.length ? { items: data.packExtras } : undefined),
        lumiaItems: (data.lumiaItems || []).map((item) => ({
            name: item.name || item.lumiaName || "Unknown",
            avatarUrl: item.avatarUrl || item.avatar_url || undefined,
            authorName: item.authorName || item.author_name || "",
            definition: item.definition || item.lumiaDefinition || "",
            personality: item.personality || item.lumiaPersonality || "",
            behavior: item.behavior || item.lumiaBehavior || "",
            genderIdentity: normalizeImportedGenderIdentity(item.genderIdentity ?? item.gender_identity),
            version: item.version != null ? String(item.version) : undefined,
            sortOrder: item.sortOrder ?? item.sort_order ?? undefined,
        })),
        loomItems: (data.loomItems || []).map((item) => ({
            name: item.name || item.loomName || "Unknown",
            content: item.content || item.loomContent || "",
            category: normCategory(item.category || item.loomCategory || ""),
            authorName: item.authorName || item.author_name || "",
            version: item.version != null ? String(item.version) : undefined,
            sortOrder: item.sortOrder ?? item.sort_order ?? undefined,
        })),
        loomTools: (data.loomTools || []).map((tool) => ({
            toolName: tool.toolName || tool.tool_name || "unknown_tool",
            displayName: tool.displayName || tool.display_name || "",
            description: tool.description || "",
            prompt: tool.prompt || "",
            inputSchema: tool.inputSchema || tool.input_schema || {},
            resultVariable: tool.resultVariable || tool.result_variable || "",
            storeInDeliberation: tool.storeInDeliberation ?? tool.store_in_deliberation ?? false,
            authorName: tool.authorName || tool.author_name || "",
            version: tool.version != null ? String(tool.version) : undefined,
            sortOrder: tool.sortOrder ?? tool.sort_order ?? undefined,
        })),
        regexScripts: (data.regexScripts || data.regex_scripts || []).map((s, i) => ({
            name: s.name || s.scriptName || `Script ${i + 1}`,
            scriptId: s.scriptId || s.script_id || "",
            findRegex: s.findRegex || s.find_regex || "",
            replaceString: s.replaceString || s.replace_string || "",
            actions: s.actions || [],
            flags: s.flags || "gi",
            placement: s.placement || ["ai_output"],
            target: Array.isArray(s.target) ? s.target : [s.target || "response"],
            minDepth: s.minDepth ?? s.min_depth ?? null,
            maxDepth: s.maxDepth ?? s.max_depth ?? null,
            trimStrings: s.trimStrings || s.trim_strings || [],
            runOnEdit: s.runOnEdit ?? s.run_on_edit ?? false,
            substituteMacros: s.substituteMacros || s.substitute_macros || "none",
            disabled: s.disabled ?? false,
            sortOrder: s.sortOrder ?? s.sort_order ?? i,
            description: s.description || "",
            metadata: s.metadata || {},
        })),
    };
}
export function importPack(userId, rawPayload) {
    const payload = normalizePackPayload(rawPayload);
    const db = getDb();
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
        db.query(`INSERT INTO packs (id, user_id, name, author, cover_url, version, is_custom, source_url, extras, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, payload.name || "Imported Pack", payload.author || "", payload.coverUrl || null, payload.version || "1.0.0", 0, // downloaded pack, not custom
        payload.sourceUrl || null, JSON.stringify(payload.extras || {}), now, now);
        for (let i = 0; i < (payload.lumiaItems || []).length; i++) {
            const item = payload.lumiaItems[i];
            db.query(`INSERT INTO lumia_items (id, pack_id, name, avatar_url, author_name, definition, personality, behavior, gender_identity, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, item.name, item.avatarUrl || null, item.authorName || "", item.definition || "", item.personality || "", item.behavior || "", item.genderIdentity ?? 3, item.version || "1.0.0", item.sortOrder ?? i, now, now);
        }
        for (let i = 0; i < (payload.loomItems || []).length; i++) {
            const item = payload.loomItems[i];
            db.query(`INSERT INTO loom_items (id, pack_id, name, content, category, author_name, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, item.name, item.content || "", item.category || "narrative_style", item.authorName || "", item.version || "1.0.0", item.sortOrder ?? i, now, now);
        }
        for (let i = 0; i < (payload.loomTools || []).length; i++) {
            const tool = payload.loomTools[i];
            db.query(`INSERT INTO loom_tools (id, pack_id, tool_name, display_name, description, prompt, input_schema, result_variable, store_in_deliberation, author_name, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, tool.toolName, tool.displayName || "", tool.description || "", tool.prompt || "", JSON.stringify(tool.inputSchema || {}), tool.resultVariable || "", tool.storeInDeliberation ? 1 : 0, tool.authorName || "", tool.version || "1.0.0", tool.sortOrder ?? i, now, now);
        }
        // Import embedded regex scripts with folder set to pack name and pack_id for association
        for (let i = 0; i < (payload.regexScripts || []).length; i++) {
            const s = payload.regexScripts[i];
            if (!s.name || !s.findRegex)
                continue;
            regexScriptsSvc.createRegexScript(userId, {
                name: s.name,
                script_id: s.scriptId || "",
                find_regex: s.findRegex,
                replace_string: s.replaceString || "",
                actions: s.actions || [],
                flags: s.flags || "gi",
                placement: s.placement || ["ai_output"],
                scope: "global",
                scope_id: null,
                target: (Array.isArray(s.target) ? s.target : [s.target || "response"]),
                min_depth: s.minDepth ?? null,
                max_depth: s.maxDepth ?? null,
                trim_strings: s.trimStrings || [],
                run_on_edit: s.runOnEdit ?? false,
                substitute_macros: s.substituteMacros || "none",
                disabled: s.disabled ?? false,
                sort_order: s.sortOrder ?? i,
                description: s.description || "",
                folder: payload.name || "Imported Pack",
                pack_id: id,
                metadata: s.metadata || {},
            });
        }
    })();
    return getPackWithItems(userId, id);
}
// LumiHub stores loom categories as display strings; map Lumiverse enums to them.
// The importer's normCategory() maps these back (case-insensitive substring match).
const LOOM_CATEGORY_EXPORT = {
    narrative_style: "Narrative Style",
    loom_utility: "Loom Utilities",
    retrofit: "Loom Retrofit",
};
// LumiHub requires a positive integer version; Lumiverse stores semantic strings.
function toExportVersion(value) {
    const n = Math.floor(Number.parseFloat(String(value ?? "")));
    return Number.isFinite(n) && n > 0 ? n : 1;
}
// LumiHub gender identity is 0=she/her, 1=he/him, 2=they/them. Lumiverse adds
// 3=any, which has no LumiHub equivalent and collapses to they/them.
function toExportGenderIdentity(value) {
    return value === 3 ? 2 : value;
}
export function exportPack(userId, id) {
    const pack = getPackWithItems(userId, id);
    if (!pack)
        return null;
    const extrasItems = Array.isArray(pack.extras?.items) ? pack.extras.items : [];
    return {
        // LumiHub-compatible fields (validated by its lumiaPackSchema on upload)
        packName: pack.name,
        packAuthor: pack.author || "Unknown",
        coverUrl: pack.cover_url || null,
        version: toExportVersion(pack.version),
        packExtras: extrasItems.map((e) => ({
            type: String(e?.type ?? ""),
            name: String(e?.name ?? ""),
            description: String(e?.description ?? ""),
        })),
        lumiaItems: pack.lumia_items.map((item) => ({
            lumiaName: item.name,
            lumiaDefinition: item.definition,
            lumiaPersonality: item.personality,
            lumiaBehavior: item.behavior,
            avatarUrl: item.avatar_url || null,
            genderIdentity: toExportGenderIdentity(item.gender_identity),
            authorName: item.author_name || "Unknown",
            version: toExportVersion(item.version),
        })),
        loomItems: pack.loom_items.map((item) => ({
            loomName: item.name,
            loomContent: item.content,
            loomCategory: LOOM_CATEGORY_EXPORT[item.category] ?? "Narrative Style",
            authorName: item.author_name || null,
            version: toExportVersion(item.version),
        })),
        // Lumiverse-only — preserved via LumiHub's passthrough() for lossless round-trips
        sourceUrl: pack.source_url || undefined,
        extras: pack.extras,
        loomTools: pack.loom_tools.map((tool) => ({
            toolName: tool.tool_name,
            displayName: tool.display_name,
            description: tool.description,
            prompt: tool.prompt,
            inputSchema: tool.input_schema,
            resultVariable: tool.result_variable,
            storeInDeliberation: tool.store_in_deliberation,
            authorName: tool.author_name,
            version: tool.version,
            sortOrder: tool.sort_order,
        })),
        regexScripts: pack.regex_scripts.length > 0
            ? pack.regex_scripts.map((s) => ({
                name: s.name,
                scriptId: s.script_id || undefined,
                findRegex: s.find_regex,
                replaceString: s.replace_string || undefined,
                actions: s.actions.length > 0 ? s.actions : undefined,
                flags: s.flags,
                placement: s.placement,
                target: s.target,
                minDepth: s.min_depth,
                maxDepth: s.max_depth,
                trimStrings: s.trim_strings.length > 0 ? s.trim_strings : undefined,
                runOnEdit: s.run_on_edit || undefined,
                substituteMacros: s.substitute_macros !== "none" ? s.substitute_macros : undefined,
                disabled: s.disabled || undefined,
                sortOrder: s.sort_order,
                description: s.description || undefined,
                metadata: Object.keys(s.metadata).length > 0 ? s.metadata : undefined,
            }))
            : undefined,
    };
}
