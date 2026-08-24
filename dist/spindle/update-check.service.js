import * as managerSvc from "./manager.service";
import { probeGitRepositoryForUpdate } from "./update-check-git";
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const UPDATE_CHECK_CONCURRENCY = 3;
let cachedUpdates = new Map();
const cacheGenerationByExtensionId = new Map();
const activeExtensionChecks = new Map();
let lastCheckedAt = null;
let activeCheck = null;
let intervalTimer = null;
async function inspectExtension(ext) {
    try {
        const manifest = await managerSvc.getManifest(ext.identifier);
        if (manifest.dev_mode === true) {
            return { kind: "remove" };
        }
        const probe = await probeGitRepositoryForUpdate(managerSvc.getRepoPath(ext.identifier), ext.branch);
        if (probe.status === "unavailable")
            return { kind: "retain" };
        if (probe.status !== "update")
            return { kind: "remove" };
        return {
            kind: "replace",
            update: {
                extensionId: ext.id,
                identifier: ext.identifier,
                name: ext.name,
                currentVersion: ext.version,
                branch: probe.branch,
                localCommit: probe.localCommit,
                remoteCommit: probe.remoteCommit,
            },
        };
    }
    catch {
        // A malformed/missing manifest or transient filesystem error should not
        // make a previously known update flicker out of the UI.
        return { kind: "retain" };
    }
}
async function checkAllExtensions() {
    const extensions = managerSvc.listExtensionUpdateCandidates();
    const enabledIds = new Set(extensions.map((ext) => ext.id));
    for (const extensionId of cachedUpdates.keys()) {
        if (!enabledIds.has(extensionId))
            cachedUpdates.delete(extensionId);
    }
    let nextIndex = 0;
    const workerCount = Math.min(UPDATE_CHECK_CONCURRENCY, Math.max(1, extensions.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const ext = extensions[nextIndex++];
            if (!ext)
                return;
            const cacheGeneration = cacheGenerationByExtensionId.get(ext.id) ?? 0;
            const result = await inspectExtension(ext);
            if ((cacheGenerationByExtensionId.get(ext.id) ?? 0) !== cacheGeneration) {
                continue;
            }
            if (result.kind === "replace") {
                cachedUpdates.set(ext.id, result.update);
            }
            else if (result.kind === "remove") {
                cachedUpdates.delete(ext.id);
            }
        }
    }));
    lastCheckedAt = Date.now();
    return getExtensionUpdateSnapshot();
}
export function refreshExtensionUpdates() {
    if (activeCheck)
        return activeCheck;
    activeCheck = checkAllExtensions()
        .catch((err) => {
        console.warn("[Spindle] Extension update check failed:", err instanceof Error ? err.message : err);
        return getExtensionUpdateSnapshot();
    })
        .finally(() => {
        activeCheck = null;
    });
    return activeCheck;
}
/** Check one newly enabled extension without waiting for the next full sweep. */
export function refreshExtensionUpdate(extensionId) {
    const existing = activeExtensionChecks.get(extensionId);
    if (existing)
        return existing;
    const check = (async () => {
        const ext = managerSvc
            .listExtensionUpdateCandidates()
            .find((candidate) => candidate.id === extensionId);
        if (!ext) {
            clearCachedExtensionUpdate(extensionId);
            return getExtensionUpdateSnapshot();
        }
        const cacheGeneration = cacheGenerationByExtensionId.get(extensionId) ?? 0;
        const result = await inspectExtension(ext);
        if ((cacheGenerationByExtensionId.get(extensionId) ?? 0) === cacheGeneration) {
            if (result.kind === "replace") {
                cachedUpdates.set(extensionId, result.update);
            }
            else if (result.kind === "remove") {
                cachedUpdates.delete(extensionId);
            }
        }
        lastCheckedAt = Date.now();
        return getExtensionUpdateSnapshot();
    })()
        .catch((err) => {
        console.warn(`[Spindle] Extension update check failed for ${extensionId}:`, err instanceof Error ? err.message : err);
        return getExtensionUpdateSnapshot();
    })
        .finally(() => {
        activeExtensionChecks.delete(extensionId);
    });
    activeExtensionChecks.set(extensionId, check);
    return check;
}
export function getExtensionUpdateSnapshot() {
    return {
        updates: [...cachedUpdates.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
        checkedAt: lastCheckedAt,
        checking: activeCheck !== null,
    };
}
export function clearCachedExtensionUpdate(extensionId) {
    cachedUpdates.delete(extensionId);
    cacheGenerationByExtensionId.set(extensionId, (cacheGenerationByExtensionId.get(extensionId) ?? 0) + 1);
}
export function startExtensionUpdateMonitor() {
    if (intervalTimer)
        return;
    intervalTimer = setInterval(() => {
        void refreshExtensionUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);
    if (typeof intervalTimer.unref === "function")
        intervalTimer.unref();
    void refreshExtensionUpdates();
}
export function stopExtensionUpdateMonitor() {
    if (intervalTimer)
        clearInterval(intervalTimer);
    intervalTimer = null;
}
