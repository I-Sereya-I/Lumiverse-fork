import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS } from "../param-schema";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
// In-memory caches with TTL
const _modelCache = new Map();
let _providerListCache = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Drop provider metadata that can be fetched again on demand. */
export function clearOpenRouterMetadataCache() {
    _modelCache.clear();
    _providerListCache = null;
}
export class OpenRouterProvider extends OpenAICompatibleProvider {
    name = "openrouter";
    displayName = "OpenRouter";
    defaultUrl = "https://openrouter.ai/api/v1";
    capabilities = {
        parameters: {
            temperature: { ...COMMON_PARAMS.temperature, max: 2 },
            max_tokens: COMMON_PARAMS.max_tokens,
            top_p: COMMON_PARAMS.top_p,
            top_k: COMMON_PARAMS.top_k,
            frequency_penalty: COMMON_PARAMS.frequency_penalty,
            presence_penalty: COMMON_PARAMS.presence_penalty,
            stop: COMMON_PARAMS.stop,
            min_p: COMMON_PARAMS.min_p,
            repetition_penalty: COMMON_PARAMS.repetition_penalty,
        },
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: true,
        modelListStyle: "openai",
        // OpenRouter preserves reasoning across tool calls via its normalized,
        // opaque `reasoning_details` blocks. OpenAICompatibleProvider captures them
        // (streaming + non-streaming) and flattenForChat replays the sequence
        // verbatim on the assistant message, so the structured continuation keeps
        // chain-of-thought intact across tool calls for any upstream model that
        // supports it (Claude, Gemini, Kimi, GLM, MiniMax, …). Enable upstream
        // reasoning by passing the `reasoning` param (sent via passthrough).
        interleavedThinking: true,
    };
    extraHeaders() {
        return {
            "HTTP-Referer": "https://lumiverse.chat",
            "X-Title": "Lumiverse",
            "X-OpenRouter-Categories": "ai-chat,roleplay",
        };
    }
    /**
     * Override buildBody to inject OpenRouter-specific fields from parameters:
     * - provider routing (order, allow_fallbacks, etc.)
     * - plugins (web search, response healing, context compression)
     * These are passed via GenerationRequest.parameters._openrouter which is
     * injected by the generate service from connection metadata.
     */
    buildBody(request, stream) {
        const body = super.buildBody(request, stream);
        const orSettings = request.parameters?._openrouter;
        // Remove internal key so it doesn't reach the API
        delete body._openrouter;
        // Provider routing
        if (orSettings?.provider_routing) {
            const routing = orSettings.provider_routing;
            const providerObj = {};
            if (routing.order?.length)
                providerObj.order = routing.order;
            if (routing.allow_fallbacks !== undefined)
                providerObj.allow_fallbacks = routing.allow_fallbacks;
            if (routing.require_parameters !== undefined)
                providerObj.require_parameters = routing.require_parameters;
            if (routing.data_collection)
                providerObj.data_collection = routing.data_collection;
            if (routing.ignore?.length)
                providerObj.ignore = routing.ignore;
            if (routing.only?.length)
                providerObj.only = routing.only;
            if (routing.quantizations?.length)
                providerObj.quantizations = routing.quantizations;
            if (routing.sort)
                providerObj.sort = routing.sort;
            if (Object.keys(providerObj).length > 0)
                body.provider = providerObj;
        }
        // Plugins
        if (orSettings?.plugins?.length) {
            body.plugins = orSettings.plugins;
        }
        return body;
    }
    /**
     * Validate key using OpenRouter's dedicated /key endpoint which returns
     * credit info. Falls back to /models if /key fails.
     */
    async validateKey(apiKey, apiUrl) {
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/key`, {
                headers: this.headers(apiKey),
            });
            if (res.ok)
                return true;
            if (res.status === 401 || res.status === 403) {
                await throwProviderResponseError(this.displayName, "authentication", res);
            }
            // Fall back to models endpoint
            return super.validateKey(apiKey, apiUrl);
        }
        catch (err) {
            if (err instanceof ProviderRequestError)
                throw err;
            throw new ProviderRequestError({
                provider: this.displayName,
                operation: "authentication",
                detail: err instanceof Error ? err.message : "network request failed",
                retryable: true,
            });
        }
    }
    /**
     * Fetch models from OpenRouter with rich metadata. Caches results for 5 minutes.
     * Returns sorted model IDs for the standard listModels interface.
     */
    async listModels(apiKey, apiUrl) {
        const models = await this.fetchModelsWithMetadata(apiKey, apiUrl);
        return models.map((m) => m.id).sort();
    }
    /**
     * Fetch full model metadata from OpenRouter. Cached in-memory with TTL.
     * Used by the credits/models info endpoint.
     */
    async fetchModelsWithMetadata(apiKey, apiUrl, opts) {
        const cacheKey = opts?.outputModalities?.trim() || "default";
        const cached = _modelCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
            return cached.data;
        }
        const url = new URL(`${this.baseUrl(apiUrl)}/models`);
        if (opts?.outputModalities?.trim()) {
            url.searchParams.set("output_modalities", opts.outputModalities.trim());
        }
        try {
            const data = await fetchProviderJson(this.displayName, "model listing", url.toString(), {
                headers: this.headers(apiKey),
            });
            const models = (data.data || []).map((m) => ({
                id: m.id,
                name: m.name,
                context_length: m.context_length,
                pricing: m.pricing || {},
                top_provider: m.top_provider,
                architecture: m.architecture,
                supported_parameters: m.supported_parameters,
            }));
            _modelCache.set(cacheKey, { data: models, fetchedAt: Date.now() });
            return models;
        }
        catch (err) {
            if (cached?.data)
                return cached.data;
            throw err;
        }
    }
    /**
     * Fetch user credit/usage info from OpenRouter's /key endpoint.
     */
    async fetchCredits(apiKey, apiUrl) {
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/key`, {
                headers: this.headers(apiKey),
            });
            if (!res.ok)
                return null;
            const raw = (await res.json());
            // Response is wrapped in { data: { ... } }
            const d = raw.data ?? raw;
            return {
                label: d.label ?? null,
                limit: d.limit ?? null,
                limit_remaining: d.limit_remaining ?? null,
                limit_reset: d.limit_reset ?? null,
                usage: d.usage ?? 0,
                usage_daily: d.usage_daily ?? 0,
                usage_weekly: d.usage_weekly ?? 0,
                usage_monthly: d.usage_monthly ?? 0,
                is_free_tier: d.is_free_tier ?? false,
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Fetch generation stats for a specific generation ID.
     */
    async fetchGenerationStats(apiKey, apiUrl, generationId) {
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/generation?id=${encodeURIComponent(generationId)}`, {
                headers: this.headers(apiKey),
            });
            if (!res.ok)
                return null;
            return await res.json();
        }
        catch {
            return null;
        }
    }
    /**
     * Fetch the list of upstream providers from OpenRouter. Cached in-memory.
     */
    async fetchProviderList(apiKey, apiUrl) {
        if (_providerListCache && Date.now() - _providerListCache.fetchedAt < MODEL_CACHE_TTL_MS) {
            return _providerListCache.data;
        }
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/providers`, {
                headers: this.headers(apiKey),
            });
            if (!res.ok)
                return _providerListCache?.data || [];
            const raw = (await res.json());
            const list = (raw.data || []).map((p) => ({
                name: p.name,
                slug: p.slug,
            }));
            _providerListCache = { data: list, fetchedAt: Date.now() };
            return list;
        }
        catch {
            return _providerListCache?.data || [];
        }
    }
}
