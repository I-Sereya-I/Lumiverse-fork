import { configureLanceDbNativeOverride } from "../lancedb-preflight";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
// Mark this isolate as the assembly worker so assemblePrompt can skip work that
// only makes sense in the main process — notably the deferred cortex warm task,
// whose results must populate the *main* process's cache (and which would
// otherwise spawn a nested cortex worker from in here). Set at module load,
// before any assemblePrompt() call.
globalThis.__LUMIVERSE_ASSEMBLY_WORKER = true;
let initialized = null;
function ensureInitialized() {
    if (!initialized) {
        initialized = (async () => {
            await configureLanceDbNativeOverride();
            await initIdentity();
            initDatabase();
        })();
    }
    return initialized;
}
function isMacroDefinition(value) {
    return !!value && typeof value === "object" && "handler" in value;
}
function sanitizeDynamicMacroValue(value) {
    if (typeof value === "string")
        return value;
    if (isMacroDefinition(value) && typeof value.handler !== "function") {
        return undefined;
    }
    return undefined;
}
function sanitizeMacroEnv(env) {
    if (!env)
        return undefined;
    const dynamicMacros = {};
    for (const [key, value] of Object.entries(env.dynamicMacros ?? {})) {
        const sanitized = sanitizeDynamicMacroValue(value);
        if (sanitized !== undefined)
            dynamicMacros[key] = sanitized;
    }
    return {
        ...env,
        signal: undefined,
        dynamicMacros,
        _dynamicMacrosLower: new Map(Object.entries(dynamicMacros).map(([key, value]) => [key.toLowerCase(), value])),
    };
}
function sanitizeAssemblyResult(result) {
    return {
        ...result,
        macroEnv: sanitizeMacroEnv(result.macroEnv),
        macroEnvSeed: sanitizeMacroEnv(result.macroEnvSeed),
    };
}
async function handleAssemble(message) {
    await ensureInitialized();
    const [{ prefetchAssemblyData }, { assemblePrompt }] = await Promise.all([
        import("./prompt-assembly-prefetch"),
        import("./prompt-assembly.service"),
    ]);
    const prefetched = await prefetchAssemblyData(message.ctx);
    const result = await assemblePrompt({ ...message.ctx, prefetched });
    postMessage({
        type: "result",
        requestId: message.requestId,
        result: sanitizeAssemblyResult(result),
    });
}
self.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== "assemble")
        return;
    handleAssemble(message).catch((err) => {
        postMessage({
            type: "error",
            requestId: message.requestId,
            error: err?.message || String(err),
            name: err?.name,
            stack: err?.stack,
        });
    });
};
