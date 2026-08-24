import { assemblePrompt } from "../services/prompt-assembly.service";
import { prefetchAssemblyData } from "../services/prompt-assembly-prefetch";
import { assemblePromptInWorker, canUsePromptAssemblyWorker, } from "../services/prompt-assembly-worker-client";
import { normalizePromptBlocks } from "../services/presets.service";
const MAX_ASSEMBLY_BLOCKS = 256;
const MAX_ASSEMBLY_BLOCK_BYTES = 1_000_000;
const ALLOWED_GENERATION_TYPES = new Set([
    "normal",
    "continue",
    "regenerate",
    "swipe",
    "impersonate",
    "quiet",
]);
export function validateAndNormalizeAssemblyBlocks(value) {
    if (!Array.isArray(value))
        throw new Error("blocks must be an array");
    if (value.length === 0)
        throw new Error("blocks must contain at least one prompt block");
    if (value.length > MAX_ASSEMBLY_BLOCKS) {
        throw new Error(`blocks exceeds the maximum of ${MAX_ASSEMBLY_BLOCKS}`);
    }
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        throw new Error("blocks must be JSON-serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_ASSEMBLY_BLOCK_BYTES) {
        throw new Error(`blocks exceeds the ${MAX_ASSEMBLY_BLOCK_BYTES}-byte limit`);
    }
    return normalizePromptBlocks(value);
}
export function normalizeAssemblyGenerationType(value) {
    if (value === undefined)
        return "normal";
    if (typeof value !== "string" || !ALLOWED_GENERATION_TYPES.has(value)) {
        throw new Error("generationType is invalid");
    }
    return value;
}
/** Native prompt assembly for extension-supplied blocks, without generation hooks or a provider call. */
export async function assembleSpindleBlocks(userId, extensionIdentifier, input, signal) {
    const chatId = typeof input?.chatId === "string" ? input.chatId.trim() : "";
    if (!chatId)
        throw new Error("chatId is required");
    const blocks = validateAndNormalizeAssemblyBlocks(input?.blocks);
    const generationType = normalizeAssemblyGenerationType(input?.generationType);
    const now = Math.floor(Date.now() / 1000);
    const presetOverride = {
        id: `spindle-assembly:${extensionIdentifier}`,
        name: `${extensionIdentifier} transient assembly`,
        provider: "loom",
        engine: "classic",
        parameters: {},
        prompt_order: blocks,
        prompts: {},
        metadata: {
            promptVariables: input.promptVariables && typeof input.promptVariables === "object"
                ? input.promptVariables
                : {},
        },
        created_at: now,
        updated_at: now,
    };
    const ctx = {
        userId,
        chatId,
        connectionId: input.connectionId,
        personaId: input.personaId,
        generationType,
        presetOverride,
        skipPresetProfileBinding: true,
        macroCommit: false,
        signal,
    };
    const assembled = canUsePromptAssemblyWorker()
        ? await assemblePromptInWorker(ctx)
        : await (async () => {
            const prefetched = await prefetchAssemblyData(ctx);
            return assemblePrompt({ ...ctx, prefetched });
        })();
    return {
        messages: assembled.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
        })),
        breakdown: assembled.breakdown,
    };
}
