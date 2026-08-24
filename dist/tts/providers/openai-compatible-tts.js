import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
/**
 * Abstract base class for providers that use the OpenAI-compatible
 * /audio/speech API format. Shared by OpenAI TTS and Kokoro TTS.
 */
export class OpenAICompatibleTtsProvider {
    get defaultUrl() {
        return this.capabilities.defaultUrl;
    }
    baseUrl(apiUrl) {
        let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
        url = url.replace(/\/audio\/speech$/, "");
        return url;
    }
    filterModels(data) {
        const models = Array.isArray(data?.data) ? data.data : [];
        return models
            .map((model) => typeof model === "string" ? model : model?.id)
            .filter((id) => typeof id === "string" && /(?:^|[-_.:/])(tts|speech)(?:$|[-_.:/])/i.test(id))
            .map((id) => ({ id, label: id }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }
    /** Override to add provider-specific headers. */
    extraHeaders(_apiKey) {
        return {};
    }
    headers(apiKey) {
        const h = {
            "Content-Type": "application/json",
            ...this.extraHeaders(apiKey),
        };
        if (apiKey) {
            h["Authorization"] = `Bearer ${apiKey}`;
        }
        return h;
    }
    /** Build the request body. Override in subclasses for provider-specific fields. */
    buildBody(request) {
        return {
            model: request.model,
            input: request.text,
            voice: request.voice,
            response_format: request.outputFormat || this.capabilities.defaultFormat,
            speed: request.parameters.speed ?? 1.0,
        };
    }
    async synthesize(apiKey, apiUrl, request) {
        const url = `${this.baseUrl(apiUrl)}/audio/speech`;
        const body = this.buildBody(request);
        const res = await fetch(url, {
            method: "POST",
            headers: this.headers(apiKey),
            body: JSON.stringify(body),
            signal: request.signal,
        });
        if (!res.ok)
            await throwProviderResponseError(this.displayName, "tts synthesize", res);
        const audioData = await res.arrayBuffer();
        const contentType = res.headers.get("content-type") || "audio/mpeg";
        return {
            audioData,
            contentType,
            model: request.model,
            provider: this.name,
        };
    }
    async *synthesizeStream(apiKey, apiUrl, request) {
        const url = `${this.baseUrl(apiUrl)}/audio/speech`;
        const body = this.buildBody(request);
        const res = await fetch(url, {
            method: "POST",
            headers: this.headers(apiKey),
            body: JSON.stringify(body),
            signal: request.signal,
        });
        if (!res.ok)
            await throwProviderResponseError(this.displayName, "tts stream", res);
        if (!res.body) {
            throw new Error(`${this.name}: no response body for streaming`);
        }
        const mimeType = res.headers.get("content-type") || "audio/mpeg";
        const reader = res.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    yield { data: new Uint8Array(0), done: true, kind: "bytes", mimeType };
                    break;
                }
                yield { data: value, done: false, kind: "bytes", mimeType };
            }
        }
        finally {
            reader.cancel().catch(() => { });
        }
    }
    async validateKey(apiKey, apiUrl) {
        try {
            const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
                headers: this.headers(apiKey),
            });
            if (!res.ok)
                await throwProviderResponseError(this.displayName, "authentication", res);
            return res.ok;
        }
        catch (err) {
            if (err instanceof ProviderRequestError)
                throw err;
            throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
        }
    }
    async listModels(apiKey, apiUrl) {
        if (this.capabilities.modelListStyle === "static")
            return this.capabilities.staticModels || [];
        const data = await fetchProviderJson(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models`, {
            headers: this.headers(apiKey),
        });
        return this.filterModels(data);
    }
    async listVoices(_apiKey, _apiUrl) {
        return this.capabilities.staticVoices || [];
    }
}
