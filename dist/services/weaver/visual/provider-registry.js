import { comfyUIProviderAdapter } from "./providers/comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./providers/simple-provider-adapter";
import { swarmUIProviderAdapter } from "./providers/swarmui-provider-adapter";
const adapters = new Map([
    ["novelai", createSimpleProviderAdapter("novelai")],
    ["nanogpt", createSimpleProviderAdapter("nanogpt")],
    ["google_gemini", createSimpleProviderAdapter("google_gemini")],
    ["openrouter", createSimpleProviderAdapter("openrouter")],
    ["sdapi", createSimpleProviderAdapter("sdapi")],
    ["swarmui", swarmUIProviderAdapter],
    ["comfyui", comfyUIProviderAdapter],
]);
export function getVisualProviderAdapter(provider) {
    return adapters.get(provider);
}
export function listVisualProviderAdapters() {
    return [...adapters.values()];
}
