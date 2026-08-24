const visualJobs = new Map();
function now() {
    return Date.now();
}
function requireVisualJob(jobId, userId) {
    const job = visualJobs.get(jobId);
    if (!job || job.userId !== userId) {
        throw new Error("Visual job not found");
    }
    return job;
}
export function createVisualJob(input) {
    const timestamp = now();
    const job = {
        id: crypto.randomUUID(),
        userId: input.userId,
        sessionId: input.sessionId,
        characterId: input.characterId,
        kind: input.kind,
        variant: input.variant,
        connectionId: input.connectionId,
        status: "queued",
        progress: {
            stage: "queued",
            message: "Queued for generation",
        },
        result: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        completedAt: null,
    };
    visualJobs.set(job.id, job);
    return job;
}
export function getVisualJob(jobId, userId) {
    const job = visualJobs.get(jobId);
    if (!job || job.userId !== userId) {
        return null;
    }
    return job;
}
export function updateVisualJobProgress(jobId, userId, progress) {
    const existing = requireVisualJob(jobId, userId);
    const timestamp = now();
    const next = {
        ...existing,
        status: "running",
        progress,
        updatedAt: timestamp,
        startedAt: existing.startedAt ?? timestamp,
    };
    visualJobs.set(jobId, next);
    return next;
}
export function completeVisualJob(jobId, userId, result) {
    const existing = requireVisualJob(jobId, userId);
    const timestamp = now();
    const next = {
        ...existing,
        status: "completed",
        progress: {
            stage: "completed",
            message: "Generation complete",
        },
        result,
        error: null,
        updatedAt: timestamp,
        startedAt: existing.startedAt ?? timestamp,
        completedAt: timestamp,
    };
    visualJobs.set(jobId, next);
    return next;
}
export function failVisualJob(jobId, userId, error) {
    const existing = requireVisualJob(jobId, userId);
    const timestamp = now();
    const next = {
        ...existing,
        status: "failed",
        progress: {
            stage: "failed",
            message: error,
        },
        result: null,
        error,
        updatedAt: timestamp,
        startedAt: existing.startedAt ?? timestamp,
        completedAt: timestamp,
    };
    visualJobs.set(jobId, next);
    return next;
}
export function clearVisualJobs() {
    visualJobs.clear();
}
