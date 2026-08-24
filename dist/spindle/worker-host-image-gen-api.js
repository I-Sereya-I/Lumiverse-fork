import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import "../image-gen/index";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import { applyActiveComfyUIWorkflowConfig } from "../services/image-gen.service";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
/**
 * `generateStream` alone is not enough: an extension-facing stream promises
 * WebSocket previews and status, so providers must explicitly advertise both.
 */
/**
 * Shapes the result returned to an extension.
 *
 * The base64 `imageDataUrl` is the largest per-image RPC field. It is required
 * host-side (to persist the image into the images table), but extensions that
 * only consume `imageId` / `imageUrl` can opt out of receiving it by passing
 * `includeDataUrl: false` in the generate request. The default keeps the data
 * URL for backward compatibility.
 */
export function applyDataUrlInclusion(result, includeDataUrl) {
    if (includeDataUrl)
        return result;
    const { imageDataUrl: _omitted, ...rest } = result;
    return rest;
}
export function supportsWebSocketPreviewStreaming(provider) {
    return Boolean(provider.capabilities.websocketPreviewStreaming?.previews
        && provider.capabilities.websocketPreviewStreaming.status
        && typeof provider.generateStream === "function");
}
/**
 * Image-generation bridge for a Spindle worker.
 *
 * The stream API deliberately accepts only providers that advertise the
 * WebSocket preview/status capability. Other providers retain the regular
 * request/response API and cannot accidentally expose a partial stream.
 */
export class WorkerHostImageGenApi {
    context;
    streamAbortControllers = new Map();
    constructor(context) {
        this.context = context;
    }
    postResponse(requestId, result, error) {
        this.context.post({
            type: "response",
            requestId,
            ...(error ? { error } : { result }),
        });
    }
    postStreamEvent(requestId, event) {
        this.context.post({ type: "image_gen_stream_chunk", requestId, event });
    }
    postStreamError(requestId, error) {
        this.context.post({ type: "image_gen_stream_error", requestId, error });
    }
    requirePermission() {
        if (!this.context.hasPermission("image_gen")) {
            throw new Error(`${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`);
        }
    }
    async resolveGeneration(input, signal) {
        this.requirePermission();
        const userId = this.context.resolveEffectiveUserId(input?.userId);
        if (!userId)
            throw new Error("userId is required for operator-scoped extensions");
        this.context.enforceScopedUser(userId);
        const connectionId = typeof input?.connection_id === "string" ? input.connection_id : null;
        const connection = connectionId
            ? imageGenConnSvc.getConnection(userId, connectionId)
            : imageGenConnSvc.getDefaultConnection(userId);
        if (!connection) {
            throw new Error(connectionId ? "Image gen connection not found" : "No default image gen connection configured");
        }
        const provider = getImageProvider(connection.provider);
        if (!provider)
            throw new Error(`Unknown image gen provider: ${connection.provider}`);
        const { getSecret } = await import("../services/secrets.service");
        const apiKey = await getSecret(userId, imageGenConnSvc.imageGenConnectionSecretKey(connection.id));
        if (!apiKey && provider.capabilities.apiKeyRequired) {
            throw new Error(`No API key for image gen connection "${connection.name}"`);
        }
        const hasExplicitWorkflow = Boolean(input?.parameters?.workflow && typeof input.parameters.workflow === "object");
        const parameters = { ...connection.default_parameters, ...(input?.parameters || {}) };
        if (!hasExplicitWorkflow
            && (connection.provider === "comfyui" || connection.provider === "swarmui")) {
            await applyActiveComfyUIWorkflowConfig(connection, parameters, typeof input?.prompt === "string" ? input.prompt : "", typeof input?.negativePrompt === "string" ? input.negativePrompt : undefined, undefined, false, apiKey || undefined);
        }
        return {
            userId,
            connection,
            provider,
            apiKey: apiKey || "",
            request: {
                prompt: typeof input?.prompt === "string" ? input.prompt : "",
                negativePrompt: typeof input?.negativePrompt === "string" ? input.negativePrompt : undefined,
                model: typeof input?.model === "string" && input.model ? input.model : connection.model,
                parameters,
                signal,
            },
        };
    }
    async persistResult(result, generation, input) {
        let imageId;
        let imageUrl;
        if (result.imageDataUrl) {
            try {
                const { saveImageFromDataUrl } = await import("../services/images.service");
                const image = await saveImageFromDataUrl(generation.userId, result.imageDataUrl, `image-gen-${generation.connection.provider}-${Date.now()}.png`, {
                    owner_extension_identifier: this.context.extensionIdentifier,
                    owner_character_id: typeof input?.owner_character_id === "string" && input.owner_character_id.trim()
                        ? input.owner_character_id.trim()
                        : undefined,
                    owner_chat_id: typeof input?.owner_chat_id === "string" && input.owner_chat_id.trim()
                        ? input.owner_chat_id.trim()
                        : undefined,
                });
                imageId = image.id;
                imageUrl = `/api/v1/image-gen/results/${image.id}`;
            }
            catch {
                // Persisting a generated image is best effort; the data URL is still usable.
            }
        }
        // Persisting already consumed the data URL; the extension-facing result
        // can drop it when the caller opts out of the base64 payload.
        return applyDataUrlInclusion({ ...result, imageId, imageUrl }, input?.includeDataUrl !== false);
    }
    async handleGenerate(requestId, input) {
        try {
            const generation = await this.resolveGeneration(input);
            const result = await generation.provider.generate(generation.apiKey, generation.connection.api_url || "", generation.request);
            this.postResponse(requestId, await this.persistResult(result, generation, input));
        }
        catch (err) {
            this.postResponse(requestId, undefined, err?.message ?? String(err));
        }
    }
    handleProviders(requestId) {
        try {
            this.requirePermission();
            const providers = getImageProviderList().map((provider) => ({
                id: provider.name,
                name: provider.displayName,
                capabilities: provider.capabilities,
            }));
            this.postResponse(requestId, providers);
        }
        catch (err) {
            this.postResponse(requestId, undefined, err?.message ?? String(err));
        }
    }
    handleConnectionsList(requestId, userId) {
        try {
            this.requirePermission();
            const resolvedUserId = this.context.resolveEffectiveUserId(userId);
            if (!resolvedUserId)
                throw new Error("userId is required for operator-scoped extensions");
            this.context.enforceScopedUser(resolvedUserId);
            const result = imageGenConnSvc.listConnections(resolvedUserId, { limit: 100, offset: 0 });
            this.postResponse(requestId, result.data);
        }
        catch (err) {
            this.postResponse(requestId, undefined, err?.message ?? String(err));
        }
    }
    handleConnectionsGet(requestId, connectionId, userId) {
        try {
            this.requirePermission();
            const resolvedUserId = this.context.resolveEffectiveUserId(userId);
            if (!resolvedUserId)
                throw new Error("userId is required for operator-scoped extensions");
            this.context.enforceScopedUser(resolvedUserId);
            this.postResponse(requestId, imageGenConnSvc.getConnection(resolvedUserId, connectionId));
        }
        catch (err) {
            this.postResponse(requestId, undefined, err?.message ?? String(err));
        }
    }
    async handleModels(requestId, connectionId, userId) {
        try {
            this.requirePermission();
            const resolvedUserId = this.context.resolveEffectiveUserId(userId);
            if (!resolvedUserId)
                throw new Error("userId is required for operator-scoped extensions");
            this.context.enforceScopedUser(resolvedUserId);
            const result = await imageGenConnSvc.listConnectionModels(resolvedUserId, connectionId);
            if (result.error)
                throw new Error(result.error);
            this.postResponse(requestId, result.models);
        }
        catch (err) {
            this.postResponse(requestId, undefined, err?.message ?? String(err));
        }
    }
    async handleGenerateStream(requestId, input) {
        const abortController = new AbortController();
        this.streamAbortControllers.set(requestId, abortController);
        try {
            const generation = await this.resolveGeneration(input, abortController.signal);
            const { provider } = generation;
            if (!supportsWebSocketPreviewStreaming(provider)) {
                throw new Error(`${provider.displayName} does not support WebSocket preview/status streaming`);
            }
            const stream = provider.generateStream(generation.apiKey, generation.connection.api_url || "", generation.request);
            while (true) {
                const next = await stream.next();
                if (next.done) {
                    const result = await this.persistResult(next.value, generation, input);
                    this.postStreamEvent(requestId, { type: "done", result });
                    return;
                }
                const update = next.value;
                const hasStatus = typeof update.step === "number"
                    || typeof update.totalSteps === "number"
                    || typeof update.nodeId === "string";
                if (hasStatus) {
                    this.postStreamEvent(requestId, {
                        type: "status",
                        ...(typeof update.step === "number" ? { step: update.step } : {}),
                        ...(typeof update.totalSteps === "number" ? { totalSteps: update.totalSteps } : {}),
                        ...(typeof update.nodeId === "string" ? { nodeId: update.nodeId } : {}),
                    });
                }
                if (typeof update.preview === "string" && update.preview) {
                    this.postStreamEvent(requestId, {
                        type: "preview",
                        imageDataUrl: update.preview,
                        ...(typeof update.step === "number" ? { step: update.step } : {}),
                        ...(typeof update.totalSteps === "number" ? { totalSteps: update.totalSteps } : {}),
                        ...(typeof update.nodeId === "string" ? { nodeId: update.nodeId } : {}),
                    });
                }
            }
        }
        catch (err) {
            const aborted = abortController.signal.aborted || err?.name === "AbortError";
            this.postStreamError(requestId, aborted ? "AbortError: Image generation aborted" : err?.message ?? String(err));
        }
        finally {
            this.streamAbortControllers.delete(requestId);
        }
    }
    cancelStream(requestId) {
        this.streamAbortControllers.get(requestId)?.abort();
    }
}
