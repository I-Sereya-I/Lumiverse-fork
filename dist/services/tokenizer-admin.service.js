import { getDb } from "../db/connection";
import * as tokenizerService from "./tokenizer.service";
// ---- Config CRUD ----
export function listConfigs() {
    return tokenizerService.getAllConfigs();
}
export function createConfig(input) {
    const db = getDb();
    const id = input.id || crypto.randomUUID();
    const config = JSON.stringify(input.config || {});
    db.run(`INSERT INTO tokenizer_configs (id, name, type, config) VALUES (?, ?, ?, ?)`, [id, input.name, input.type, config]);
    return tokenizerService.getConfig(id);
}
/**
 * Create a tokenizer config and (optionally) its model-match pattern in a single
 * transaction, so a bad regex can't leave a dangling config behind. Used by the
 * resolve-from-repo flow where a paste-a-URL action installs both at once.
 */
export function installResolved(input) {
    const db = getDb();
    let config;
    let pattern = null;
    db.transaction(() => {
        config = createConfig({ name: input.name, type: input.type, config: input.config });
        if (input.pattern?.pattern) {
            pattern = createPattern({
                tokenizer_id: config.id,
                pattern: input.pattern.pattern,
                priority: input.pattern.priority,
            });
        }
    })();
    return { config, pattern };
}
export function updateConfig(id, updates) {
    const existing = tokenizerService.getConfig(id);
    if (!existing)
        return null;
    const db = getDb();
    const name = updates.name ?? existing.name;
    const type = updates.type ?? existing.type;
    const config = updates.config ? JSON.stringify(updates.config) : JSON.stringify(existing.config);
    db.run(`UPDATE tokenizer_configs SET name = ?, type = ?, config = ?, updated_at = unixepoch() WHERE id = ?`, [name, type, config, id]);
    tokenizerService.invalidate(id);
    return tokenizerService.getConfig(id);
}
export function deleteConfig(id) {
    const existing = tokenizerService.getConfig(id);
    if (!existing)
        return false;
    if (existing.is_built_in)
        throw new Error("Cannot delete built-in tokenizer");
    const db = getDb();
    db.run(`DELETE FROM tokenizer_configs WHERE id = ?`, [id]);
    tokenizerService.invalidate(id);
    tokenizerService.invalidatePatterns();
    return true;
}
// ---- Pattern CRUD ----
export function listPatterns() {
    return tokenizerService.getAllPatterns();
}
export function createPattern(input) {
    const db = getDb();
    const id = input.id || crypto.randomUUID();
    // Validate regex
    try {
        new RegExp(input.pattern);
    }
    catch {
        throw new Error("Invalid regex pattern");
    }
    db.run(`INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern, priority) VALUES (?, ?, ?, ?)`, [id, input.tokenizer_id, input.pattern, input.priority ?? 50]);
    tokenizerService.invalidatePatterns();
    const row = db.query("SELECT * FROM tokenizer_model_patterns WHERE id = ?").get(id);
    return { ...row, is_built_in: !!row.is_built_in };
}
export function updatePattern(id, updates) {
    const db = getDb();
    const existing = db.query("SELECT * FROM tokenizer_model_patterns WHERE id = ?").get(id);
    if (!existing)
        return null;
    if (updates.pattern) {
        try {
            new RegExp(updates.pattern);
        }
        catch {
            throw new Error("Invalid regex pattern");
        }
    }
    const tokenizerId = updates.tokenizer_id ?? existing.tokenizer_id;
    const pattern = updates.pattern ?? existing.pattern;
    const priority = updates.priority ?? existing.priority;
    db.run(`UPDATE tokenizer_model_patterns SET tokenizer_id = ?, pattern = ?, priority = ?, updated_at = unixepoch() WHERE id = ?`, [tokenizerId, pattern, priority, id]);
    tokenizerService.invalidatePatterns();
    const row = db.query("SELECT * FROM tokenizer_model_patterns WHERE id = ?").get(id);
    return { ...row, is_built_in: !!row.is_built_in };
}
export function deletePattern(id) {
    const db = getDb();
    const existing = db.query("SELECT * FROM tokenizer_model_patterns WHERE id = ?").get(id);
    if (!existing)
        return false;
    if (existing.is_built_in)
        throw new Error("Cannot delete built-in pattern");
    db.run(`DELETE FROM tokenizer_model_patterns WHERE id = ?`, [id]);
    tokenizerService.invalidatePatterns();
    return true;
}
