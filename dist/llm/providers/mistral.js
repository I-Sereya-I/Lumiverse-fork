import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS } from "../param-schema";
export class MistralProvider extends OpenAICompatibleProvider {
    name = "mistral";
    displayName = "Mistral";
    defaultUrl = "https://api.mistral.ai/v1";
    capabilities = {
        parameters: {
            temperature: { ...COMMON_PARAMS.temperature, max: 2 },
            max_tokens: COMMON_PARAMS.max_tokens,
            top_p: COMMON_PARAMS.top_p,
            frequency_penalty: COMMON_PARAMS.frequency_penalty,
            presence_penalty: COMMON_PARAMS.presence_penalty,
            stop: COMMON_PARAMS.stop,
            min_p: COMMON_PARAMS.min_p,
        },
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: true,
        modelListStyle: "openai",
    };
}
