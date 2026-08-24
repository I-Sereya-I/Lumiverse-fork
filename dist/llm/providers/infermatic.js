import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS } from "../param-schema";
export class InfermaticProvider extends OpenAICompatibleProvider {
    name = "infermatic";
    displayName = "Infermatic";
    defaultUrl = "https://api.totalgpt.ai/v1";
    capabilities = {
        parameters: {
            temperature: { ...COMMON_PARAMS.temperature, max: 2 },
            max_tokens: COMMON_PARAMS.max_tokens,
            top_p: COMMON_PARAMS.top_p,
            top_k: COMMON_PARAMS.top_k,
            frequency_penalty: COMMON_PARAMS.frequency_penalty,
            presence_penalty: COMMON_PARAMS.presence_penalty,
            stop: COMMON_PARAMS.stop,
            repetition_penalty: COMMON_PARAMS.repetition_penalty,
        },
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: true,
        modelListStyle: "openai",
    };
}
