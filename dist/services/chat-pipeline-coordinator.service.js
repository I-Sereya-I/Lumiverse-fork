const lanes = new Map();
function createLane(chatId) {
    return {
        chatId,
        queue: [],
        activeTask: null,
        processing: false,
        completedTasks: 0,
        skippedTasks: 0,
        supersededTasks: 0,
        updatedAt: Date.now(),
    };
}
function getOrCreateLane(chatId) {
    const existing = lanes.get(chatId);
    if (existing)
        return existing;
    const lane = createLane(chatId);
    lanes.set(chatId, lane);
    return lane;
}
function touchLane(lane) {
    lane.updatedAt = Date.now();
}
function taskToSnapshot(task) {
    return {
        id: task.id,
        kind: task.kind,
        dedupeKey: task.dedupeKey,
        revision: task.revision,
        exclusive: task.exclusive,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
    };
}
function buildQueuedCounts(lane) {
    const counts = {
        chunk_rebuild: 0,
        cortex_ingest: 0,
        cortex_rebuild: 0,
        cortex_warmup: 0,
    };
    for (const task of lane.queue)
        counts[task.kind] += 1;
    return counts;
}
export function getChatPipelineStatus(chatId) {
    const lane = lanes.get(chatId);
    if (!lane)
        return null;
    return {
        chatId,
        activeTask: lane.activeTask ? taskToSnapshot(lane.activeTask) : null,
        queuedTasks: lane.queue.map(taskToSnapshot),
        running: lane.processing,
        queuedCounts: buildQueuedCounts(lane),
        completedTasks: lane.completedTasks,
        skippedTasks: lane.skippedTasks,
        supersededTasks: lane.supersededTasks,
        updatedAt: lane.updatedAt,
    };
}
function settleSuperseded(task, reason, lane) {
    lane.supersededTasks += 1;
    touchLane(lane);
    task.resolve({ status: "superseded", reason });
}
function settleSkipped(task, reason, lane) {
    lane.skippedTasks += 1;
    touchLane(lane);
    task.resolve({ status: "skipped", reason });
}
function settleCompleted(task, value, lane) {
    lane.completedTasks += 1;
    touchLane(lane);
    task.resolve({ status: "completed", value });
}
function supersedeQueuedIngestions(lane, reason) {
    if (lane.queue.length === 0)
        return;
    const survivors = [];
    for (const task of lane.queue) {
        if (task.kind === "cortex_ingest")
            settleSuperseded(task, reason, lane);
        else
            survivors.push(task);
    }
    lane.queue = survivors;
}
function supersedeQueuedDedupeMatch(lane, incomingKind, dedupeKey, reason) {
    if (!dedupeKey || incomingKind !== "cortex_ingest" || lane.queue.length === 0)
        return;
    const survivors = [];
    for (const task of lane.queue) {
        if (task.kind === incomingKind && task.dedupeKey === dedupeKey) {
            settleSuperseded(task, reason, lane);
        }
        else {
            survivors.push(task);
        }
    }
    lane.queue = survivors;
}
async function pumpLane(lane) {
    if (lane.processing)
        return;
    lane.processing = true;
    touchLane(lane);
    try {
        while (lane.queue.length > 0) {
            const task = lane.queue.shift();
            lane.activeTask = task;
            task.startedAt = Date.now();
            touchLane(lane);
            try {
                if (task.preflight) {
                    const decision = await task.preflight();
                    if (decision.action === "skip") {
                        settleSkipped(task, decision.reason, lane);
                        continue;
                    }
                }
                const value = await task.run();
                settleCompleted(task, value, lane);
            }
            catch (err) {
                task.reject(err);
            }
            finally {
                lane.activeTask = null;
                touchLane(lane);
            }
        }
    }
    finally {
        lane.processing = false;
        touchLane(lane);
    }
}
export function enqueueChatPipelineTask(options) {
    const lane = getOrCreateLane(options.chatId);
    const taskId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const task = {
            id: taskId,
            kind: options.kind,
            chatId: options.chatId,
            exclusive: options.exclusive === true,
            dedupeKey: options.dedupeKey ?? null,
            revision: options.revision ?? null,
            enqueuedAt: Date.now(),
            startedAt: null,
            preflight: options.preflight,
            run: options.run,
            resolve,
            reject,
        };
        supersedeQueuedDedupeMatch(lane, task.kind, task.dedupeKey, "superseded_by_newer_task");
        if (task.exclusive) {
            supersedeQueuedIngestions(lane, `superseded_by_${task.kind}`);
        }
        lane.queue.push(task);
        touchLane(lane);
        void pumpLane(lane);
    });
}
export function resetChatPipelineCoordinatorForTests() {
    lanes.clear();
}
