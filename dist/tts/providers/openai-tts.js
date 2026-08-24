import { OpenAICompatibleTtsProvider } from "./openai-compatible-tts";
export class OpenAITtsProvider extends OpenAICompatibleTtsProvider {
    name = "openai_tts";
    displayName = "OpenAI TTS";
    capabilities = {
        parameters: {
            speed: {
                type: "number",
                default: 1.0,
                min: 0.25,
                max: 4.0,
                step: 0.05,
                description: "Playback speed multiplier",
            },
            instructions: {
                type: "string",
                description: "Style instructions (gpt-4o-mini-tts only). E.g. 'Speak warmly with a slight British accent'",
                group: "advanced",
            },
        },
        apiKeyRequired: true,
        voiceListStyle: "static",
        staticVoices: [
            { id: "alloy", name: "Alloy" },
            { id: "ash", name: "Ash" },
            { id: "ballad", name: "Ballad" },
            { id: "cedar", name: "Cedar" },
            { id: "coral", name: "Coral" },
            { id: "echo", name: "Echo" },
            { id: "fable", name: "Fable" },
            { id: "marin", name: "Marin" },
            { id: "nova", name: "Nova" },
            { id: "onyx", name: "Onyx" },
            { id: "sage", name: "Sage" },
            { id: "shimmer", name: "Shimmer" },
            { id: "verse", name: "Verse" },
        ],
        modelListStyle: "dynamic",
        supportsStreaming: true,
        supportedFormats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
        defaultUrl: "https://api.openai.com/v1",
        defaultFormat: "mp3",
    };
    buildBody(request) {
        const body = super.buildBody(request);
        // Only gpt-4o-mini-tts supports the instructions field
        if (request.parameters.instructions && request.model === "gpt-4o-mini-tts") {
            body.instructions = request.parameters.instructions;
        }
        return body;
    }
}
