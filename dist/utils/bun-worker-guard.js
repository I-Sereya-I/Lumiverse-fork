const WINDOWS_BUN_WORKER_OVERRIDE = "LUMIVERSE_FORCE_BUN_WORKERS";
const warnedContexts = new Set();
export function shouldUseBunWorkers(platform = process.platform, env = process.env) {
    if (platform !== "win32")
        return true;
    return env[WINDOWS_BUN_WORKER_OVERRIDE] === "1";
}
export function warnBunWorkerFallback(context) {
    if (shouldUseBunWorkers() || warnedContexts.has(context))
        return;
    warnedContexts.add(context);
    console.warn(`[bun] ${context} is using a Windows fallback instead of Bun workers to avoid known Bun worker crashes. Set ${WINDOWS_BUN_WORKER_OVERRIDE}=1 to re-enable Bun workers.`);
}
