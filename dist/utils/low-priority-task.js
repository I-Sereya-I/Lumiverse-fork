const pending = [];
let timer = null;
let activeAsyncTasks = 0;
let idleResolvers = [];
function isPromiseLike(value) {
    return !!value && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function schedule() {
    if (timer)
        return;
    timer = setTimeout(runNext, 0);
    if (typeof timer.unref === "function") {
        timer.unref();
    }
}
function resolveIdleIfNeeded() {
    if (timer || pending.length > 0 || activeAsyncTasks > 0)
        return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers)
        resolve();
}
function finishAsyncTask() {
    activeAsyncTasks = Math.max(0, activeAsyncTasks - 1);
    resolveIdleIfNeeded();
}
function runNext() {
    timer = null;
    const task = pending.shift();
    if (!task) {
        resolveIdleIfNeeded();
        return;
    }
    try {
        const result = task.run();
        if (isPromiseLike(result)) {
            activeAsyncTasks += 1;
            result.catch((err) => {
                console.warn(`[deferred] ${task.label || "low-priority task"} failed:`, err);
            }).finally(finishAsyncTask);
        }
    }
    catch (err) {
        console.warn(`[deferred] ${task.label || "low-priority task"} failed:`, err);
    }
    if (pending.length > 0)
        schedule();
    resolveIdleIfNeeded();
}
export function scheduleLowPriorityTask(run, options) {
    pending.push({ run, label: options?.label });
    schedule();
}
export function waitForLowPriorityTasksForTests() {
    if (!timer && pending.length === 0 && activeAsyncTasks === 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        idleResolvers.push(resolve);
    });
}
export function resetLowPriorityTasksForTests() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    pending.length = 0;
    activeAsyncTasks = 0;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers)
        resolve();
}
