import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS } from "../param-schema";
export class CustomProvider extends OpenAICompatibleProvider {
    name = "custom";
    displayName = "Custom (OpenAI-compatible)";
    defaultUrl = "";
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
        apiKeyRequired: false,
        modelListStyle: "openai",
    };
}
