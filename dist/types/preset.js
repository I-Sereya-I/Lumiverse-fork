export class PresetRevisionConflictError extends Error {
    code = "PRESET_REVISION_CONFLICT";
    presetId;
    expectedCacheRevision;
    actualCacheRevision;
    constructor(presetId, expectedCacheRevision, actualCacheRevision) {
        super(`Preset ${presetId} changed since revision ${expectedCacheRevision}; current revision is ${actualCacheRevision}`);
        this.name = "PresetRevisionConflictError";
        this.presetId = presetId;
        this.expectedCacheRevision = expectedCacheRevision;
        this.actualCacheRevision = actualCacheRevision;
    }
}
