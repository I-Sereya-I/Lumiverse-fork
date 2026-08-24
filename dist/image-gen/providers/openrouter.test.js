import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterImageProvider } from "./openrouter";
function stubFetch() {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url: String(input), body, headers: init?.headers || {} });
        return new Response(JSON.stringify({
            choices: [
                {
                    message: {
                        images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
                    },
                },
            ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return {
        calls,
        restore() {
            globalThis.fetch = original;
        },
    };
}
const BASE = "https://openrouter.ai/api/v1";
function req(model, parameters = {}) {
    return { prompt: "a fox", model, parameters };
}
describe("OpenRouterImageProvider", () => {
    const provider = new OpenRouterImageProvider();
    let fetchStub;
    afterEach(() => fetchStub?.restore());
    test("uses image-only modalities for Flux and Grok Imagine models", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("black-forest-labs/flux.2-flex"));
        await provider.generate("key", BASE, req("x-ai/grok-imagine-image-quality"));
        await provider.generate("key", BASE, req("x-ai/grok-2-image"));
        expect(fetchStub.calls[0].body.modalities).toEqual(["image"]);
        expect(fetchStub.calls[1].body.modalities).toEqual(["image"]);
        expect(fetchStub.calls[2].body.modalities).toEqual(["image"]);
    });
    test("keeps image and text modalities for multimodal output models", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("google/gemini-2.5-flash-image"));
        expect(fetchStub.calls[0].body.modalities).toEqual(["image", "text"]);
    });
    test("rawRequestOverride can still force modalities", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("google/gemini-2.5-flash-image", {
            rawRequestOverride: JSON.stringify({ modalities: ["image"] }),
        }));
        expect(fetchStub.calls[0].body.modalities).toEqual(["image"]);
    });
    test("uses plain string content for text-to-image with no source images", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("black-forest-labs/flux.2-klein-4b"));
        expect(fetchStub.calls[0].body.messages[0].content).toBe("a fox");
    });
    test("uses array content parts when source images are present", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("black-forest-labs/flux.2-klein-4b", {
            resolvedSourceImages: [{ data: "QUJD", mimeType: "image/jpeg" }],
        }));
        const content = fetchStub.calls[0].body.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0]).toEqual({ type: "text", text: "a fox" });
        expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
    });
    test("does not send image_config for Flux models", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("black-forest-labs/flux.2-klein-4b", {
            aspectRatio: "16:9",
            imageSize: "2K",
        }));
        expect(fetchStub.calls[0].body.image_config).toBeUndefined();
    });
    test("sends image_config for Gemini models", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("google/gemini-2.5-flash-image", {
            aspectRatio: "16:9",
            imageSize: "2K",
        }));
        expect(fetchStub.calls[0].body.image_config).toEqual({
            aspect_ratio: "16:9",
            image_size: "2K",
        });
    });
    test("rawRequestOverride can still inject image_config for Flux models", async () => {
        fetchStub = stubFetch();
        await provider.generate("key", BASE, req("black-forest-labs/flux.2-klein-4b", {
            rawRequestOverride: JSON.stringify({
                image_config: { aspect_ratio: "21:9", image_size: "4K" },
            }),
        }));
        expect(fetchStub.calls[0].body.image_config).toEqual({
            aspect_ratio: "21:9",
            image_size: "4K",
        });
    });
});
