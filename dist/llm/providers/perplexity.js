import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS } from "../param-schema";
export class PerplexityProvider extends OpenAICompatibleProvider {
    name = "perplexity";
    displayName = "Perplexity";
    defaultUrl = "https://api.perplexity.ai";
    capabilities = {
        parameters: {
            temperature: { ...COMMON_PARAMS.temperature, max: 2 },
            max_tokens: COMMON_PARAMS.max_tokens,
            top_p: COMMON_PARAMS.top_p,
            frequency_penalty: COMMON_PARAMS.frequency_penalty,
            presence_penalty: COMMON_PARAMS.presence_penalty,
            stop: COMMON_PARAMS.stop,
        },
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: true,
        modelListStyle: "none",
    };
    async listModels(_apiKey, _apiUrl) {
        return [];
    }
}
