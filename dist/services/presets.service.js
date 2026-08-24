import { createHash } from "node:crypto";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { PresetRevisionConflictError } from "../types/preset";
import { paginatedQuery } from "./pagination";
import { deleteRegexScriptsByPresetId } from "./regex-scripts.service";
import { sanitizePromptBlockCharacterTagTrigger } from "../utils/prompt-block-character-tags";
import * as settingsSvc from "./settings.service";
import { reconcileStashedPromptBlocks, syncStashedBlocksAcrossPresets, } from "./prompt-stash.service";
/**
 * Drop entries in metadata.promptVariables that no longer correspond to a
 * variable defined on some block in prompt_order. Keeps the JSON tidy and
 * prevents stale overrides from resurfacing if a creator re-adds a variable
 * with the same name later.
 */
function prunePromptVariableOrphans(promptOrder, metadata) {
    if (!metadata || typeof metadata !== "object")
        return metadata;
    const raw = metadata.promptVariables;
    if (!raw || typeof raw !== "object")
        return metadata;
    const blocks = Array.isArray(promptOrder) ? promptOrder : [];
    const blockById = new Map();
    for (const b of blocks)
        if (b && typeof b === "object" && b.id)
            blockById.set(b.id, b);
    const cleaned = {};
    for (const [blockId, bucket] of Object.entries(raw)) {
        const block = blockById.get(blockId);
        if (!block || !block.variables?.length)
            continue;
        const validNames = new Set(block.variables.map((v) => v.name));
        const kept = {};
        for (const [name, value] of Object.entries(bucket || {})) {
            if (validNames.has(name))
                kept[name] = value;
        }
        if (Object.keys(kept).length)
            cleaned[blockId] = kept;
    }
    return { ...metadata, promptVariables: cleaned };
}
function rowToPreset(row) {
    // Construct explicitly from the Preset fields rather than spreading `...row`:
    // the latter ships internal columns (e.g. user_id) to the client and carries
    // the raw JSON-string columns alongside the parsed ones.
    return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        engine: row.engine,
        parameters: JSON.parse(row.parameters),
        prompt_order: JSON.parse(row.prompt_order),
        prompts: JSON.parse(row.prompts),
        metadata: JSON.parse(row.metadata),
        cache_revision: row.cache_revision ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
export function listPresets(userId, pagination) {
    return paginatedQuery("SELECT * FROM presets WHERE user_id = ? ORDER BY updated_at DESC", "SELECT COUNT(*) as count FROM presets WHERE user_id = ?", [userId], pagination, rowToPreset);
}
export function listPresetRegistry(userId, pagination, provider, engine) {
    const filters = [];
    const params = [userId];
    if (provider) {
        filters.push("provider = ?");
        params.push(provider);
    }
    if (engine) {
        filters.push("engine = ?");
        params.push(engine);
    }
    const filterSQL = filters.length > 0 ? " AND " + filters.join(" AND ") : "";
    return paginatedQuery(`SELECT id, name, provider, updated_at,
            COALESCE(json_array_length(prompt_order), 0) as block_count,
            COALESCE(json_extract(metadata, '$.coverUrl'), json_extract(metadata, '$.cover_url')) as cover_url
     FROM presets
     WHERE user_id = ?${filterSQL}
     ORDER BY updated_at DESC`, `SELECT COUNT(*) as count FROM presets WHERE user_id = ?${filterSQL}`, params, pagination, (row) => ({
        id: row.id,
        name: row.name,
        provider: row.provider,
        updated_at: row.updated_at,
        block_count: row.block_count ?? 0,
        cover_url: typeof row.cover_url === "string" && row.cover_url.trim() ? row.cover_url : null,
    }));
}
/**
 * Stable content signature for registry ETags. The ordered `(id, cache_revision)`
 * stream changes for creates, deletes, and every content update without
 * serializing large JSON columns or distorting user-visible update times.
 */
export function getPresetRegistrySignature(userId, provider, engine) {
    const filters = [];
    const params = [userId];
    if (provider) {
        filters.push("provider = ?");
        params.push(provider);
    }
    if (engine) {
        filters.push("engine = ?");
        params.push(engine);
    }
    const filterSQL = filters.length > 0 ? " AND " + filters.join(" AND ") : "";
    const rows = getDb()
        .query(`SELECT id, cache_revision FROM presets WHERE user_id = ?${filterSQL} ORDER BY id`)
        .all(...params);
    const digest = createHash("sha256");
    digest.update(userId).update("\0").update(provider ?? "").update("\0").update(engine ?? "").update("\0");
    for (const row of rows) {
        digest.update(row.id).update("\0").update(String(row.cache_revision)).update("\0");
    }
    return digest.digest("base64url");
}
// Prepared statement for hot-path preset fetch (avoids re-compiling for large JSON blobs)
let _stmtPresetById = null;
let _stmtPresetByIdGen = -1;
export function getPreset(userId, id) {
    const gen = require("../db/connection").getDbGeneration();
    if (!_stmtPresetById || _stmtPresetByIdGen !== gen) {
        _stmtPresetById = getDb().query("SELECT * FROM presets WHERE id = ? AND user_id = ?");
        _stmtPresetByIdGen = gen;
    }
    const row = _stmtPresetById.get(id, userId);
    return row ? rowToPreset(row) : null;
}
export function countPresets(userId) {
    const row = getDb().query("SELECT COUNT(*) as count FROM presets WHERE user_id = ?").get(userId);
    return row?.count ?? 0;
}
const ACTIVE_LOOM_PRESET_SETTING = "activeLoomPresetId";
/**
 * Return the active Loom preset when it still exists, otherwise replace a
 * stale selection with the most recently updated remaining Loom preset.
 *
 * Presets can be removed in another tab or on another device. Keeping this
 * repair server-side means a refresh cannot restore a deleted id and send it
 * back with the next generation request.
 */
export function reconcileActiveLoomPreset(userId) {
    const setting = settingsSvc.getSetting(userId, ACTIVE_LOOM_PRESET_SETTING);
    const selectedId = typeof setting?.value === "string" && setting.value.trim()
        ? setting.value
        : null;
    if (selectedId && getPreset(userId, selectedId))
        return selectedId;
    if (!selectedId)
        return null;
    const replacement = getDb()
        .query(`SELECT id FROM presets
       WHERE user_id = ? AND provider = 'loom'
       ORDER BY updated_at DESC, created_at DESC, id ASC
       LIMIT 1`)
        .get(userId);
    const replacementId = replacement?.id ?? null;
    settingsSvc.putSetting(userId, ACTIVE_LOOM_PRESET_SETTING, replacementId);
    return replacementId;
}
/**
 * Find a preset previously installed from LumiHub by its hub preset id (stored in
 * metadata._lumiverse_lumihub_id). Used to update-in-place on re-install instead of
 * creating a duplicate.
 */
export function findPresetByLumihubId(userId, lumihubId) {
    const row = getDb()
        .query(`SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_lumihub_id') = ?
         AND (
           json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
           OR (
             json_extract(metadata, '$._lumiverse_install_source') IS NULL
             AND json_extract(metadata, '$._lumiverse_preset_version') IS NOT NULL
           )
         )
       LIMIT 1`)
        .get(userId, lumihubId);
    return row ? rowToPreset(row) : null;
}
/**
 * Resolve an installed LumiHub preset by the canonical slug used by the Hub's
 * install manifest. This is the identity fallback for listings whose Hub row
 * id changed while their creator/name identity stayed the same.
 */
export function findLumihubPresetBySlug(userId, slug) {
    const row = getDb()
        .query(`SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
         AND json_extract(metadata, '$._lumiverse_preset_slug') = ?
       LIMIT 1`)
        .get(userId, slug);
    return row ? rowToPreset(row) : null;
}
export function findPresetBySlug(userId, slug) {
    const row = getDb()
        .query("SELECT * FROM presets WHERE user_id = ? AND json_extract(metadata, '$._lumiverse_preset_slug') = ? LIMIT 1")
        .get(userId, slug);
    return row ? rowToPreset(row) : null;
}
/** Lightweight preset list for building the LumiHub install manifest. */
export function listPresetsForManifest(userId) {
    const rows = getDb()
        .query("SELECT name, metadata, created_at FROM presets WHERE user_id = ?")
        .all(userId);
    return rows.map((r) => {
        let metadata = {};
        try {
            metadata = JSON.parse(r.metadata) || {};
        }
        catch {
            metadata = {};
        }
        return { name: r.name, created_at: r.created_at, metadata };
    });
}
/** Fetch a monotonic row revision for cache validation without reading preset JSON. */
export function getPresetCacheRevision(userId, id) {
    const row = getDb()
        .query("SELECT cache_revision FROM presets WHERE id = ? AND user_id = ?")
        .get(id, userId);
    return row ? row.cache_revision : null;
}
/**
 * Validate that a usable preset exists for generation. Throws a config error
 * (mapped to HTTP 400 by the route) when the user has no presets at all or
 * when the resolved preset id points at a row that was deleted.
 *
 * `requestedPresetId` is the explicit preset the caller asked for; `connectionPresetId`
 * is the fallback carried by the connection profile. Either pointing at a
 * missing row is a hard error — silently falling back to legacy assembly lets
 * stale state produce working-but-unintended generations.
 */
export function assertUsablePreset(userId, requestedPresetId, connectionPresetId) {
    const resolvedId = requestedPresetId || connectionPresetId || null;
    if (resolvedId) {
        if (!getPreset(userId, resolvedId)) {
            throw new Error("The selected preset was deleted. Pick a different preset before generating.");
        }
        return;
    }
    if (countPresets(userId) === 0) {
        throw new Error("No presets available. Create a preset before generating.");
    }
    throw new Error("No preset selected. Choose a preset before generating.");
}
export function createPreset(userId, input) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const cleanedMetadata = prunePromptVariableOrphans(input.prompt_order, input.metadata) || {};
    getDb()
        .query("INSERT INTO presets (id, name, provider, engine, parameters, prompt_order, prompts, metadata, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.name, input.provider, input.engine || "classic", JSON.stringify(input.parameters || {}), JSON.stringify(input.prompt_order || []), JSON.stringify(input.prompts || {}), JSON.stringify(cleanedMetadata), userId, now, now);
    return getPreset(userId, id);
}
export function updatePreset(userId, id, input) {
    const existing = getPreset(userId, id);
    if (!existing)
        return null;
    // Avoid mutating shared stash state for a request we already know is stale.
    // The conditional UPDATE below remains the authoritative race-safe check.
    if (input.expected_cache_revision !== undefined && input.expected_cache_revision !== (existing.cache_revision ?? 0)) {
        throw new PresetRevisionConflictError(id, input.expected_cache_revision, existing.cache_revision ?? 0);
    }
    // A stashed block has global content/configuration but local visibility and
    // list placement. Reconcile before validating prompt variables so the
    // response and persisted row both contain the canonical stash fields.
    let reconciledPromptOrder = input.prompt_order;
    let changedStashIds = [];
    let commitStashReconciliation;
    if (Array.isArray(input.prompt_order) && input.prompt_order.some((block) => block && typeof block === "object" && typeof block.stashId === "string")) {
        const reconciliation = reconcileStashedPromptBlocks(userId, (existing.prompt_order || []), input.prompt_order);
        reconciledPromptOrder = reconciliation.blocks;
        changedStashIds = reconciliation.changedStashIds;
        commitStashReconciliation = reconciliation.commit;
    }
    const fields = [];
    const values = [];
    // Orphan-GC: if prompt_order or metadata is being written, re-derive a cleaned
    // metadata.promptVariables so stale values (orphaned by a removed def) don't stick.
    // When prompt_order changes alone, persist the cleaned metadata even if the
    // caller didn't touch it — otherwise the orphans would live forever.
    let writeMetadata;
    if (input.metadata !== undefined) {
        const resolvedOrder = reconciledPromptOrder !== undefined ? reconciledPromptOrder : existing.prompt_order;
        writeMetadata = prunePromptVariableOrphans(resolvedOrder, input.metadata) ?? input.metadata;
    }
    else if (reconciledPromptOrder !== undefined) {
        const cleaned = prunePromptVariableOrphans(reconciledPromptOrder, existing.metadata);
        if (cleaned && JSON.stringify(cleaned) !== JSON.stringify(existing.metadata)) {
            writeMetadata = cleaned;
        }
    }
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.provider !== undefined) {
        fields.push("provider = ?");
        values.push(input.provider);
    }
    if (input.engine !== undefined) {
        fields.push("engine = ?");
        values.push(input.engine);
    }
    if (input.parameters !== undefined) {
        fields.push("parameters = ?");
        values.push(JSON.stringify(input.parameters));
    }
    if (reconciledPromptOrder !== undefined) {
        fields.push("prompt_order = ?");
        values.push(JSON.stringify(reconciledPromptOrder));
    }
    if (input.prompts !== undefined) {
        fields.push("prompts = ?");
        values.push(JSON.stringify(input.prompts));
    }
    if (writeMetadata !== undefined) {
        fields.push("metadata = ?");
        values.push(JSON.stringify(writeMetadata));
    }
    const expectedCacheRevision = input.expected_cache_revision;
    if (fields.length === 0) {
        if (expectedCacheRevision !== undefined && expectedCacheRevision !== (existing.cache_revision ?? 0)) {
            throw new PresetRevisionConflictError(id, expectedCacheRevision, existing.cache_revision ?? 0);
        }
        return existing;
    }
    fields.push("updated_at = ?", "cache_revision = cache_revision + 1");
    values.push(Math.floor(Date.now() / 1000));
    const where = ["id = ?", "user_id = ?"];
    values.push(id, userId);
    if (expectedCacheRevision !== undefined) {
        where.push("cache_revision = ?");
        values.push(expectedCacheRevision);
    }
    const changes = getDb()
        .query(`UPDATE presets SET ${fields.join(", ")} WHERE ${where.join(" AND ")}`)
        .run(...values)
        .changes;
    if (changes === 0) {
        // A conditional miss is either a deleted row (the normal not-found result)
        // or a stale writer. Read the current revision only after the atomic update
        // has failed so the distinction cannot race the mutation itself.
        const current = getPreset(userId, id);
        if (!current)
            return null;
        if (expectedCacheRevision !== undefined) {
            throw new PresetRevisionConflictError(id, expectedCacheRevision, current.cache_revision ?? 0);
        }
        return null;
    }
    const updated = getPreset(userId, id);
    if (!updated)
        return null;
    commitStashReconciliation?.();
    syncStashedBlocksAcrossPresets(userId, id, changedStashIds);
    eventBus.emit(EventType.PRESET_CHANGED, { id, preset: updated }, userId);
    return updated;
}
export function deletePreset(userId, id) {
    const db = getDb();
    // Capture connection profiles that reference this preset. The FK on
    // connection_profiles.preset_id (ON DELETE SET NULL) will clear the
    // references when the preset row is removed, but we need the list up front
    // so we can broadcast refreshed profiles to subscribers afterwards.
    const affectedConnectionIds = db
        .query("SELECT id FROM connection_profiles WHERE user_id = ? AND preset_id = ?")
        .all(userId, id).map((r) => r.id);
    // Cascade-delete any regex scripts that were imported from this preset so
    // they don't linger as orphaned "preset regexes" in the user's list.
    deleteRegexScriptsByPresetId(userId, id);
    const deleted = db.query("DELETE FROM presets WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    if (!deleted)
        return false;
    // Preserve a usable active selection for the next page load. This also
    // repairs stale selections left behind by older versions that did not
    // update the setting when a preset was removed.
    reconcileActiveLoomPreset(userId);
    // Clean up preset_profile bindings (setting-keyed, no FK) that referenced
    // the now-deleted preset. Covers defaults, per-character, per-chat, and
    // per-connection profile bindings.
    for (const s of settingsSvc.getAllSettings(userId)) {
        if (s.key !== "presetProfileDefaults"
            && !s.key.startsWith("presetProfileDefaults:")
            && !s.key.startsWith("presetProfile:character:")
            && !s.key.startsWith("presetProfile:chat:")
            && !s.key.startsWith("presetProfile:connection:"))
            continue;
        if (s.value && typeof s.value === "object" && s.value.preset_id === id) {
            settingsSvc.deleteSetting(userId, s.key);
        }
    }
    // Broadcast refreshed connection profiles so frontends drop stale preset_id
    // references from their in-memory stores.
    for (const connId of affectedConnectionIds) {
        const row = db
            .query("SELECT * FROM connection_profiles WHERE id = ? AND user_id = ?")
            .get(connId, userId);
        if (!row)
            continue;
        const profile = {
            ...row,
            preset_id: row.preset_id || null,
            is_default: !!row.is_default,
            has_api_key: !!row.has_api_key,
            metadata: JSON.parse(row.metadata),
        };
        eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id: connId, profile }, userId);
    }
    eventBus.emit(EventType.PRESET_DELETED, { id }, userId);
    return true;
}
function normalizePromptBlock(input) {
    const marker = typeof input.marker === "string" ? input.marker : null;
    const role = input.role === "system" || input.role === "user" || input.role === "assistant" || input.role === "user_append" || input.role === "assistant_append"
        ? input.role
        : "system";
    const position = input.position === "pre_history" || input.position === "post_history" || input.position === "in_history"
        ? input.position
        : "pre_history";
    const characterTagTrigger = sanitizePromptBlockCharacterTagTrigger(input.characterTagTrigger);
    const placementBinding = normalizePromptBlockPlacementBinding(input.placementBinding);
    return {
        id: typeof input.id === "string" && input.id.trim() ? input.id : crypto.randomUUID(),
        name: typeof input.name === "string" && input.name.trim() ? input.name : "New Chat",
        content: typeof input.content === "string" ? input.content : "",
        role,
        enabled: input.enabled !== undefined ? !!input.enabled : true,
        position,
        depth: typeof input.depth === "number" ? input.depth : 0,
        marker,
        isLocked: input.isLocked !== undefined ? !!input.isLocked : false,
        color: typeof input.color === "string" ? input.color : null,
        injectionTrigger: Array.isArray(input.injectionTrigger) ? input.injectionTrigger.filter((v) => typeof v === "string") : [],
        ...(characterTagTrigger.length > 0 ? { characterTagTrigger } : {}),
        group: typeof input.group === "string" ? input.group : null,
        categoryMode: marker === "category" && (input.categoryMode === "radio" || input.categoryMode === "checkbox")
            ? input.categoryMode
            : null,
        ...(Array.isArray(input.variables) ? { variables: input.variables } : {}),
        ...(placementBinding ? { placementBinding } : {}),
        ...(typeof input.stashId === "string" && input.stashId.trim() ? { stashId: input.stashId.trim() } : {}),
    };
}
function normalizePromptBlockPlacementBinding(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const raw = value;
    if (typeof raw.variableId !== "string" || !raw.variableId.trim())
        return undefined;
    if (!raw.options || typeof raw.options !== "object" || Array.isArray(raw.options))
        return undefined;
    const options = {};
    for (const [optionId, candidate] of Object.entries(raw.options)) {
        if (!optionId.trim() || !candidate || typeof candidate !== "object" || Array.isArray(candidate))
            continue;
        const placement = candidate;
        if ((placement.role !== "system" && placement.role !== "user" && placement.role !== "assistant" && placement.role !== "user_append" && placement.role !== "assistant_append") ||
            (placement.position !== "pre_history" && placement.position !== "post_history" && placement.position !== "in_history") ||
            typeof placement.depth !== "number" || !Number.isFinite(placement.depth) || placement.depth < 0) {
            continue;
        }
        options[optionId] = {
            role: placement.role,
            position: placement.position,
            depth: Math.floor(placement.depth),
        };
    }
    if (Object.keys(options).length === 0)
        return undefined;
    return { variableId: raw.variableId.trim(), options };
}
export function normalizePromptBlocks(blocks) {
    return blocks.map((block) => normalizePromptBlock(block));
}
export function listPromptBlocks(userId, presetId) {
    const preset = getPreset(userId, presetId);
    if (!preset)
        return null;
    return normalizePromptBlocks((preset.prompt_order || []));
}
export function getPromptBlock(userId, presetId, blockId) {
    const blocks = listPromptBlocks(userId, presetId);
    if (!blocks)
        return null;
    return blocks.find((block) => block.id === blockId) || null;
}
export function createPromptBlock(userId, presetId, input, index) {
    const preset = getPreset(userId, presetId);
    if (!preset)
        return null;
    const blocks = normalizePromptBlocks((preset.prompt_order || []));
    const block = normalizePromptBlock(input || {});
    const insertAt = typeof index === "number" && Number.isFinite(index)
        ? Math.max(0, Math.min(blocks.length, Math.floor(index)))
        : blocks.length;
    blocks.splice(insertAt, 0, block);
    updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
    return block;
}
export function updatePromptBlock(userId, presetId, blockId, input) {
    const preset = getPreset(userId, presetId);
    if (!preset)
        return null;
    const blocks = normalizePromptBlocks((preset.prompt_order || []));
    const index = blocks.findIndex((block) => block.id === blockId);
    if (index === -1)
        return null;
    const updated = normalizePromptBlock({ ...blocks[index], ...(input || {}), id: blockId });
    blocks[index] = updated;
    updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
    return updated;
}
export function deletePromptBlock(userId, presetId, blockId) {
    const preset = getPreset(userId, presetId);
    if (!preset)
        return false;
    const blocks = normalizePromptBlocks((preset.prompt_order || []));
    const index = blocks.findIndex((block) => block.id === blockId);
    if (index === -1)
        return false;
    blocks.splice(index, 1);
    updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
    return true;
}
export function listPromptBlockCategories(userId, presetId) {
    const blocks = listPromptBlocks(userId, presetId);
    if (!blocks)
        return null;
    const groups = [];
    let current = { categoryBlock: null, children: [] };
    for (const block of blocks) {
        if (block.marker === "category") {
            if (current.categoryBlock || current.children.length > 0)
                groups.push(current);
            current = { categoryBlock: block, children: [] };
        }
        else {
            current.children.push(block);
        }
    }
    if (current.categoryBlock || current.children.length > 0)
        groups.push(current);
    return groups;
}
