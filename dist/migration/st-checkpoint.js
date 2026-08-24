import { deleteSetting, getSetting, putSetting } from "../services/settings.service";
export const ST_MIGRATION_CHECKPOINT_KEY = "st_migration_checkpoint";
export const ST_MIGRATION_PHASES = [
    "connections",
    "characters",
    "worldBooks",
    "personas",
    "chats",
    "groupChats",
];
function sameScope(a, b) {
    return (!!a.characters === !!b.characters
        && !!a.worldBooks === !!b.worldBooks
        && !!a.personas === !!b.personas
        && !!a.chats === !!b.chats
        && !!a.groupChats === !!b.groupChats
        && !!a.connections === !!b.connections
        && !!a.repairExisting === !!b.repairExisting
        && !!a.dryRun === !!b.dryRun);
}
function isPhase(value) {
    return typeof value === "string" && ST_MIGRATION_PHASES.includes(value);
}
export function parseStMigrationCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.version !== 1)
        return null;
    if (typeof raw.migrationId !== "string" || !raw.migrationId)
        return null;
    if (typeof raw.dataDir !== "string" || !raw.dataDir)
        return null;
    if (!raw.scope || typeof raw.scope !== "object" || Array.isArray(raw.scope))
        return null;
    if (!Array.isArray(raw.completedPhases))
        return null;
    const completedPhases = raw.completedPhases.filter(isPhase);
    return {
        version: 1,
        migrationId: raw.migrationId,
        dataDir: raw.dataDir,
        scope: raw.scope,
        completedPhases,
        results: raw.results && typeof raw.results === "object" && !Array.isArray(raw.results)
            ? raw.results
            : {},
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    };
}
export function loadStMigrationCheckpoint(userId, dataDir, scope) {
    const stored = getSetting(userId, ST_MIGRATION_CHECKPOINT_KEY);
    const checkpoint = parseStMigrationCheckpoint(stored?.value);
    if (!checkpoint)
        return null;
    if (checkpoint.dataDir !== dataDir || !sameScope(checkpoint.scope, scope))
        return null;
    return checkpoint;
}
export function saveStMigrationCheckpoint(userId, checkpoint) {
    putSetting(userId, ST_MIGRATION_CHECKPOINT_KEY, {
        ...checkpoint,
        version: 1,
        updatedAt: Date.now(),
    }, { suppressBroadcast: true });
}
export function clearStMigrationCheckpoint(userId) {
    deleteSetting(userId, ST_MIGRATION_CHECKPOINT_KEY);
}
export function markStMigrationPhase(userId, checkpoint, phase, results) {
    const completedPhases = checkpoint.completedPhases.includes(phase)
        ? checkpoint.completedPhases
        : [...checkpoint.completedPhases, phase];
    const next = {
        ...checkpoint,
        completedPhases,
        results: { ...checkpoint.results, ...results },
        updatedAt: Date.now(),
    };
    saveStMigrationCheckpoint(userId, next);
    return next;
}
