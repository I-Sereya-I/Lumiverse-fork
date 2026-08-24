import { COMMON_PARAMS } from "../param-schema";
import { cancelStreamAndCloseConnection, createCooperativeYielder, fetchWithPreflightAbort, readJsonWithAbort, readWithAbort } from "../stream-utils";
import { getTextContent } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import { appendGoogleSearchTool, buildGoogleSearchTool, GOOGLE_SEARCH_HANDLED_PARAMS, GOOGLE_SEARCH_PARAMETERS, } from "./google-search";
const GEMINI_SCHEMA_FIELDS = new Set(["type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example", "anyOf", "propertyOrdering", "default", "items", "minimum", "maximum"]);
export function sanitizeGeminiSchema(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
        return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (!GEMINI_SCHEMA_FIELDS.has(k))
            continue;
        if (k === "items")
            out[k] = sanitizeGeminiSchema(v);
        else if (k === "anyOf" && Array.isArray(v))
            out[k] = v.map(sanitizeGeminiSchema);
        else if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
            const p = {};
            for (const [pn, ps] of Object.entries(v))
                p[pn] = sanitizeGeminiSchema(ps);
            out[k] = p;
        }
        else
            out[k] = v;
    }
    return out;
}
export class GoogleProvider {
    name = "google";
    displayName = "Google Gemini";
    defaultUrl = "https://generativelanguage.googleapis.com";
    capabilities = {
        parameters: {
            temperature: { ...COMMON_PARAMS.temperature, max: 2 },
            max_tokens: COMMON_PARAMS.max_tokens,
            top_p: COMMON_PARAMS.top_p,
            top_k: COMMON_PARAMS.top_k,
            stop: COMMON_PARAMS.stop,
            ...GOOGLE_SEARCH_PARAMETERS,
        },
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: true,
        modelListStyle: "google",
        // Gemini preserves reasoning across tool calls via the opaque
        // `thoughtSignature` attached to each functionCall part. generate()/
        // generateStream() capture it onto ToolCallResult.thought_signature and
        // formatParts re-emits it, so the structured continuation round-trips the
        // signature (mandatory on Gemini 3 when thinking is enabled).
        interleavedThinking: true,
    };
    baseUrl(apiUrl) {
        let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
        // Strip path suffixes the user may have included that we append ourselves
        url = url.replace(/\/v1beta\/models(\/.*)?$/, "");
        url = url.replace(/\/v1beta$/, "");
        return url;
    }
    async generate(apiKey, apiUrl, request) {
        const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:generateContent?key=${apiKey}`;
        const body = this.buildBody(request);
        const res = await fetchWithPreflightAbort(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }, request.signal);
        if (!res.ok)
            await throwProviderResponseError(this.displayName, "generate", res);
        const data = await readJsonWithAbort(res, request.signal);
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        // Separate thinking parts from regular text, and collect function calls
        let content = "";
        let reasoning = "";
        const fnCalls = [];
        for (const p of parts) {
            if (p.thought) {
                reasoning += p.text || "";
            }
            else if (p.functionCall) {
                fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID(), thought_signature: p.thoughtSignature });
            }
            else {
                content += p.text || "";
            }
        }
        const thoughtSignature = this.getNonToolThoughtSignature(parts, request.parameters?._replay_thought_signatures === true);
        const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;
        const groundingMetadata = candidate?.groundingMetadata ?? data.groundingMetadata;
        return {
            content,
            reasoning: reasoning || undefined,
            finish_reason: toolCalls ? "tool_calls" : (candidate?.finishReason || "STOP"),
            tool_calls: toolCalls,
            ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}),
            usage: data.usageMetadata
                ? {
                    prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                    completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                    total_tokens: data.usageMetadata.totalTokenCount || 0,
                    ...(groundingMetadata ? { provider_raw: { groundingMetadata } } : {}),
                }
                : undefined,
        };
    }
    async *generateStream(apiKey, apiUrl, request) {
        const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${apiKey}`;
        const body = this.buildBody(request);
        const res = await fetchWithPreflightAbort(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }, request.signal);
        if (!res.ok)
            await throwProviderResponseError(this.displayName, "stream", res);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const maybeYield = createCooperativeYielder(64, request.signal);
        // Some Vertex-based providers serialize a completed response as several
        // SSE messages, including an empty `STOP` envelope before the envelope
        // containing the response text. A finish reason is a property of the
        // complete response, not proof that this individual SSE message is final,
        // so hold it until the stream itself closes.
        // This also lets us retain the final (and often only accurate) usage data.
        let terminalFinishReason;
        let finalUsage;
        let streamDoneNaturally = false;
        try {
            while (true) {
                const { done, value } = await readWithAbort(reader, request.signal);
                if (done) {
                    streamDoneNaturally = !request.signal?.aborted;
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    await maybeYield();
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: "))
                        continue;
                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        const candidate = data.candidates?.[0];
                        const parts = candidate?.content?.parts || [];
                        const finishReason = candidate?.finishReason;
                        // Separate thinking parts (thought: true) from regular text parts, and collect function calls
                        let text = "";
                        let reasoning = "";
                        const fnCalls = [];
                        for (const p of parts) {
                            if (p.thought) {
                                reasoning += p.text || "";
                            }
                            else if (p.functionCall) {
                                fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID(), thought_signature: p.thoughtSignature });
                            }
                            else {
                                text += p.text || "";
                            }
                        }
                        const thoughtSignature = this.getNonToolThoughtSignature(parts, request.parameters?._replay_thought_signatures === true);
                        // Capture usage metadata (Google includes it in the final streaming chunk)
                        const usage = data.usageMetadata
                            ? {
                                prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                                completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                                total_tokens: data.usageMetadata.totalTokenCount || 0,
                                ...((candidate?.groundingMetadata ?? data.groundingMetadata)
                                    ? { provider_raw: { groundingMetadata: candidate?.groundingMetadata ?? data.groundingMetadata } }
                                    : {}),
                            }
                            : undefined;
                        const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;
                        if (toolCalls) {
                            terminalFinishReason = "tool_calls";
                        }
                        else if (finishReason && terminalFinishReason !== "tool_calls") {
                            terminalFinishReason = finishReason === "STOP" ? "stop" : finishReason;
                        }
                        if (usage)
                            finalUsage = usage;
                        if (text || reasoning || toolCalls || thoughtSignature) {
                            yield {
                                token: text,
                                reasoning: reasoning || undefined,
                                tool_calls: toolCalls,
                                ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}),
                                usage,
                            };
                        }
                        else if (usage) {
                            yield { token: "", usage };
                        }
                    }
                    catch {
                        // Skip malformed SSE lines
                    }
                }
            }
            if (terminalFinishReason) {
                yield { token: "", finish_reason: terminalFinishReason, usage: finalUsage };
            }
        }
        finally {
            if (!streamDoneNaturally)
                await cancelStreamAndCloseConnection(reader, res);
        }
    }
    async validateKey(apiKey, apiUrl) {
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`);
            if (!res.ok)
                await throwProviderResponseError(this.displayName, "authentication", res);
            return res.ok;
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
    async listModels(apiKey, apiUrl) {
        const data = await fetchProviderJson(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/v1beta/models?key=${apiKey}`);
        return (data.models || [])
            .map((m) => m.name?.replace("models/", "") || m.name)
            .filter((n) => n.includes("gemini"))
            .sort();
    }
    /** Format message content into Google Gemini parts array, handling multipart (vision/audio) content. */
    getNonToolThoughtSignature(parts, enabled) {
        if (!enabled)
            return undefined;
        for (let index = parts.length - 1; index >= 0; index--) {
            const part = parts[index];
            if (!part?.functionCall && typeof part?.thoughtSignature === "string") {
                return part.thoughtSignature;
            }
        }
        return undefined;
    }
    formatParts(m, toolNameById, replayThoughtSignatures) {
        if (typeof m.content === "string") {
            return [{
                    text: m.content,
                    ...(m.role === "assistant" && replayThoughtSignatures && m.thought_signature
                        ? { thoughtSignature: m.thought_signature }
                        : {}),
                }];
        }
        const formatted = m.content.map((part) => {
            switch (part.type) {
                case "text":
                    return {
                        text: part.text,
                        ...(m.role === "assistant" && replayThoughtSignatures && part.thought_signature
                            ? { thoughtSignature: part.thought_signature }
                            : {}),
                    };
                case "image":
                case "audio":
                    return { inlineData: { mimeType: part.mime_type, data: part.data } };
                case "tool_use":
                    return { functionCall: { name: part.name, args: part.input }, thoughtSignature: part.thought_signature || "context_engineering_is_the_way_to_go" };
                case "tool_result": {
                    let payload = part.content;
                    try {
                        payload = JSON.parse(part.content);
                    }
                    catch { /* keep as string */ }
                    const key = part.is_error ? "error" : "output";
                    const response = { [key]: payload };
                    const name = toolNameById.get(part.tool_use_id) ?? "tool";
                    return { functionResponse: { name, response } };
                }
                default:
                    return { text: "" };
            }
        });
        if (m.role === "assistant" && replayThoughtSignatures && m.thought_signature) {
            const target = [...formatted].reverse().find((part) => Object.hasOwn(part, "text") || Object.hasOwn(part, "inlineData"));
            if (target)
                target.thoughtSignature = m.thought_signature;
        }
        return formatted;
    }
    buildToolNameMap(messages) {
        const map = new Map();
        for (const m of messages) {
            if (typeof m.content === "string")
                continue;
            for (const p of m.content) {
                if (p.type === "tool_use")
                    map.set(p.id, p.name);
            }
        }
        return map;
    }
    /** Keys that are internal to Lumiverse and should never be sent to any provider API. */
    static INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "_streaming", "_replay_thought_signatures"]);
    /** Keys explicitly handled by Google's buildBody — excluded from passthrough. */
    static HANDLED_PARAMS = new Set([
        "temperature", "max_tokens", "top_p", "top_k", "stop", "thinkingConfig",
        "responseMimeType", "responseSchema", "responseJsonSchema",
        ...GOOGLE_SEARCH_HANDLED_PARAMS,
    ]);
    buildBody(request) {
        const params = request.parameters || {};
        // Google uses a different message format
        const systemMessages = request.messages.filter((m) => m.role === "system");
        const otherMessages = request.messages.filter((m) => m.role !== "system");
        const toolNameById = this.buildToolNameMap(request.messages);
        const replayThoughtSignatures = params._replay_thought_signatures === true;
        const functionTools = request.tools ?? [];
        const hasFunctionDeclarations = functionTools.length > 0;
        const googleSearchTool = buildGoogleSearchTool(this.name, request.model, params, hasFunctionDeclarations);
        const body = {
            contents: otherMessages.map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: this.formatParts(m, toolNameById, replayThoughtSignatures),
            })),
        };
        if (systemMessages.length > 0) {
            body.systemInstruction = {
                parts: [{ text: systemMessages.map((m) => getTextContent(m)).join("\n\n") }],
            };
        }
        const generationConfig = {};
        if (params.temperature !== undefined)
            generationConfig.temperature = params.temperature;
        if (params.max_tokens !== undefined)
            generationConfig.maxOutputTokens = params.max_tokens;
        if (params.top_p !== undefined)
            generationConfig.topP = params.top_p;
        if (params.top_k !== undefined)
            generationConfig.topK = params.top_k;
        if (params.stop)
            generationConfig.stopSequences = params.stop;
        // Thinking configuration for Gemini 2.5+ and 3.x models
        if (params.thinkingConfig) {
            generationConfig.thinkingConfig = params.thinkingConfig;
        }
        // Structured output: responseMimeType and responseSchema go inside generationConfig
        if (params.responseMimeType !== undefined) {
            generationConfig.responseMimeType = params.responseMimeType;
        }
        // Accept both "responseSchema" (Google's native name) and "responseJsonSchema" (alias)
        const responseSchema = params.responseSchema ?? params.responseJsonSchema;
        if (responseSchema !== undefined) {
            generationConfig.responseSchema = responseSchema;
        }
        if (Object.keys(generationConfig).length > 0) {
            body.generationConfig = generationConfig;
        }
        // Passthrough: inject extra params (e.g. from custom body) directly into the
        // top-level request body. This enables provider-specific fields like
        // safetySettings, cachedContent, etc. to reach the API.
        for (const key of Object.keys(params)) {
            if (body[key] !== undefined)
                continue; // already set (e.g. generationConfig)
            if (GoogleProvider.HANDLED_PARAMS.has(key))
                continue;
            if (GoogleProvider.INTERNAL_PARAMS.has(key))
                continue;
            body[key] = params[key];
        }
        // Default safety settings: disable all content filters unless the user
        // has already provided their own safetySettings via passthrough.
        if (!body.safetySettings) {
            body.safetySettings = [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
            ];
        }
        // Inline council tools: pass as Google function calling format
        if (hasFunctionDeclarations) {
            body.tools = [{
                    functionDeclarations: functionTools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parameters: sanitizeGeminiSchema(t.parameters),
                    })),
                }];
        }
        else {
            // Insert dummy thought signature on model parts when tools are NOT in use.
            // This bypasses Google's thought signature validator for non-tool contexts.
            for (const entry of body.contents) {
                if (entry.role === "model") {
                    for (const part of entry.parts) {
                        if (!part.thoughtSignature) {
                            part.thoughtSignature = "context_engineering_is_the_way_to_go";
                        }
                    }
                }
            }
        }
        appendGoogleSearchTool(this.name, body, googleSearchTool);
        return body;
    }
}
