import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { paginatedQuery } from "./pagination";
import { getSetting as getUserSetting } from "./settings.service";
import { resolvePersonaAvatarInfo, } from "./persona-addon-states";
function rowToPersona(row) {
    return {
        ...row,
        title: row.title || '',
        subjective_pronoun: row.subjective_pronoun || '',
        objective_pronoun: row.objective_pronoun || '',
        possessive_pronoun: row.possessive_pronoun || '',
        reflexive_pronoun: row.reflexive_pronoun || '',
        possessive_pronoun_standalone: row.possessive_pronoun_standalone || '',
        folder: row.folder || '',
        avatar_path: row.avatar_path || null,
        image_id: row.image_id || null,
        attached_world_book_id: row.attached_world_book_id || null,
        is_default: !!row.is_default,
        is_narrator: !!row.is_narrator,
        metadata: JSON.parse(row.metadata),
    };
}
export function listPersonas(userId, pagination) {
    return paginatedQuery("SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC", "SELECT COUNT(*) as count FROM personas WHERE user_id = ?", [userId], pagination, rowToPersona);
}
export function getPersona(userId, id) {
    const row = getDb().query("SELECT * FROM personas WHERE id = ? AND user_id = ?").get(id, userId);
    if (!row)
        return null;
    return rowToPersona(row);
}
export function getPersonaAvatarInfo(userId, id, options = {}) {
    return resolvePersonaAvatarInfo(getPersona(userId, id), options.addonStates, options.addonToggleOrder);
}
export function createPersona(userId, input) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb().transaction(() => {
        if (input.is_default) {
            getDb().query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
        }
        getDb()
            .query(`INSERT INTO personas (
           id, user_id, name, title, description,
           subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone,
           folder, is_default, is_narrator, attached_world_book_id, metadata, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, userId, input.name, input.title || "", input.description || "", input.subjective_pronoun || "", input.objective_pronoun || "", input.possessive_pronoun || "", input.reflexive_pronoun || "", input.possessive_pronoun_standalone || "", input.folder || "", input.is_default ? 1 : 0, input.is_narrator ? 1 : 0, input.attached_world_book_id || null, JSON.stringify(input.metadata || {}), now, now);
    })();
    const persona = getPersona(userId, id);
    eventBus.emit(EventType.PERSONA_CHANGED, { id, persona }, userId);
    return persona;
}
/** Load SillyTavern persona identities once so reruns stay linear. */
export function listPersonaSourceFilenameIds(userId) {
    const rows = getDb()
        .query(`SELECT id, name, json_extract(metadata, '$._lumiverse_source_filename') AS source_filename
       FROM personas
       WHERE user_id = ?
         AND json_type(metadata, '$._lumiverse_source_filename') = 'text'
       ORDER BY updated_at ASC`)
        .all(userId);
    const result = new Map();
    for (const row of rows)
        result.set(row.source_filename, { id: row.id, name: row.name });
    return result;
}
export function updatePersona(userId, id, input) {
    const existing = getPersona(userId, id);
    if (!existing)
        return null;
    const now = Math.floor(Date.now() / 1000);
    const fields = [];
    const values = [];
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.title !== undefined) {
        fields.push("title = ?");
        values.push(input.title);
    }
    if (input.description !== undefined) {
        fields.push("description = ?");
        values.push(input.description);
    }
    if (input.subjective_pronoun !== undefined) {
        fields.push("subjective_pronoun = ?");
        values.push(input.subjective_pronoun);
    }
    if (input.objective_pronoun !== undefined) {
        fields.push("objective_pronoun = ?");
        values.push(input.objective_pronoun);
    }
    if (input.possessive_pronoun !== undefined) {
        fields.push("possessive_pronoun = ?");
        values.push(input.possessive_pronoun);
    }
    if (input.reflexive_pronoun !== undefined) {
        fields.push("reflexive_pronoun = ?");
        values.push(input.reflexive_pronoun);
    }
    if (input.possessive_pronoun_standalone !== undefined) {
        fields.push("possessive_pronoun_standalone = ?");
        values.push(input.possessive_pronoun_standalone);
    }
    if (input.folder !== undefined) {
        fields.push("folder = ?");
        values.push(input.folder);
    }
    if (input.is_default !== undefined) {
        fields.push("is_default = ?");
        values.push(input.is_default ? 1 : 0);
    }
    if (input.is_narrator !== undefined) {
        fields.push("is_narrator = ?");
        values.push(input.is_narrator ? 1 : 0);
    }
    if (input.attached_world_book_id !== undefined) {
        fields.push("attached_world_book_id = ?");
        values.push(input.attached_world_book_id || null);
    }
    if (input.metadata !== undefined) {
        fields.push("metadata = ?");
        values.push(JSON.stringify(input.metadata));
    }
    if (fields.length === 0)
        return existing;
    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);
    values.push(userId);
    getDb().transaction(() => {
        if (input.is_default) {
            getDb().query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
        }
        getDb().query(`UPDATE personas SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
    })();
    const updated = getPersona(userId, id);
    eventBus.emit(EventType.PERSONA_CHANGED, { id, persona: updated }, userId);
    return updated;
}
export function renamePersonaFolder(userId, oldName, newName) {
    const source = oldName.trim();
    const target = newName.trim();
    if (!source || !target)
        return [];
    const rows = getDb()
        .query("SELECT * FROM personas WHERE user_id = ? AND folder = ?")
        .all(userId, source);
    if (rows.length === 0)
        return [];
    if (source === target) {
        return rows.map(rowToPersona);
    }
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query("UPDATE personas SET folder = ?, updated_at = ? WHERE user_id = ? AND folder = ?")
        .run(target, now, userId, source);
    const updated = rows.map((row) => rowToPersona({ ...row, folder: target, updated_at: now }));
    for (const persona of updated) {
        eventBus.emit(EventType.PERSONA_CHANGED, { id: persona.id, persona }, userId);
    }
    return updated;
}
export function deletePersonaFolder(userId, name) {
    const folder = name.trim();
    if (!folder)
        return [];
    const rows = getDb()
        .query("SELECT * FROM personas WHERE user_id = ? AND folder = ?")
        .all(userId, folder);
    if (rows.length === 0)
        return [];
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query("UPDATE personas SET folder = '', updated_at = ? WHERE user_id = ? AND folder = ?")
        .run(now, userId, folder);
    const updated = rows.map((row) => rowToPersona({ ...row, folder: '', updated_at: now }));
    for (const persona of updated) {
        eventBus.emit(EventType.PERSONA_CHANGED, { id: persona.id, persona }, userId);
    }
    return updated;
}
export function isPersonaAvatarPathReferenced(userId, avatarPath) {
    return !!getDb()
        .query("SELECT 1 FROM personas WHERE user_id = ? AND avatar_path = ? LIMIT 1")
        .get(userId, avatarPath);
}
export function bulkUpdatePersonas(userId, ids, input) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const updated = [];
    for (const id of uniqueIds) {
        const existing = getPersona(userId, id);
        if (!existing)
            continue;
        const patch = {};
        if (input.folder !== undefined)
            patch.folder = input.folder.trim();
        if (input.attached_world_book_id !== undefined) {
            patch.attached_world_book_id = input.attached_world_book_id;
        }
        if (input.toggle_narrator)
            patch.is_narrator = !existing.is_narrator;
        const persona = updatePersona(userId, id, patch);
        if (persona)
            updated.push(persona);
    }
    return updated;
}
export function setPersonaAvatar(userId, id, avatarPath) {
    const result = getDb()
        .query("UPDATE personas SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
    return result.changes > 0;
}
export function setPersonaImage(userId, id, imageId) {
    const result = getDb()
        .query("UPDATE personas SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(imageId, Math.floor(Date.now() / 1000), id, userId);
    return result.changes > 0;
}
/**
 * Attach or clear a persona-specific avatar override for an add-on. The image
 * lives on the persona's add-on reference, including attached global add-ons,
 * so a shared global add-on never dictates another persona's appearance.
 */
export function setPersonaAddonAvatar(userId, personaId, addonId, avatar) {
    const existing = getPersona(userId, personaId);
    if (!existing)
        return null;
    const metadata = existing.metadata ?? {};
    let found = false;
    const updateAddons = (addons) => {
        if (!Array.isArray(addons))
            return addons;
        return addons.map((addon) => {
            if (!addon || addon.id !== addonId)
                return addon;
            found = true;
            const next = { ...addon };
            if (avatar.image_id)
                next.avatar_image_id = avatar.image_id;
            else
                delete next.avatar_image_id;
            if (avatar.avatar_crop_image_id)
                next.avatar_crop_image_id = avatar.avatar_crop_image_id;
            else
                delete next.avatar_crop_image_id;
            return next;
        });
    };
    const nextMetadata = {
        ...metadata,
        ...(Array.isArray(metadata.addons) ? { addons: updateAddons(metadata.addons) } : {}),
        ...(Array.isArray(metadata.attached_global_addons)
            ? { attached_global_addons: updateAddons(metadata.attached_global_addons) }
            : {}),
    };
    if (!found)
        return null;
    return updatePersona(userId, personaId, { metadata: nextMetadata });
}
export function duplicatePersona(userId, id) {
    const existing = getPersona(userId, id);
    if (!existing)
        return null;
    const newId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
        .query(`INSERT INTO personas (
         id, user_id, name, title, description,
         subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone,
         folder, avatar_path, image_id, is_default, is_narrator, attached_world_book_id, metadata, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .run(newId, userId, `${existing.name} (Copy)`, existing.title, existing.description, existing.subjective_pronoun, existing.objective_pronoun, existing.possessive_pronoun, existing.reflexive_pronoun, existing.possessive_pronoun_standalone, existing.folder, existing.avatar_path, existing.image_id, existing.is_narrator ? 1 : 0, existing.attached_world_book_id, JSON.stringify(existing.metadata), now, now);
    const persona = getPersona(userId, newId);
    eventBus.emit(EventType.PERSONA_CHANGED, { id: newId, persona }, userId);
    return persona;
}
export function getDefaultPersona(userId) {
    const row = getDb().query("SELECT * FROM personas WHERE is_default = 1 AND user_id = ? LIMIT 1").get(userId);
    if (!row)
        return null;
    return rowToPersona(row);
}
export function resolvePersonaOrDefault(userId, personaId) {
    if (personaId) {
        const requested = getPersona(userId, personaId);
        if (requested)
            return requested;
    }
    try {
        const active = getUserSetting(userId, "activePersonaId");
        if (active && typeof active.value === "string" && active.value.length > 0) {
            const fromSetting = getPersona(userId, active.value);
            if (fromSetting)
                return fromSetting;
        }
    }
    catch { /* */ }
    return getDefaultPersona(userId);
}
export function deletePersona(userId, id) {
    const result = getDb().query("DELETE FROM personas WHERE id = ? AND user_id = ?").run(id, userId);
    if (result.changes > 0) {
        eventBus.emit(EventType.PERSONA_CHANGED, { id, deleted: true }, userId);
    }
    return result.changes > 0;
}
