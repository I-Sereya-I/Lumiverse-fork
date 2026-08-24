import { rawGenerate } from "../generate.service";
import { resolveConnection } from "../connections.service";
import { getWeaverTuning } from "./tuning";
export function resolveWeaverConnection(userId, session) {
    const conn = resolveConnection(userId, session.connection_id || undefined);
    if (!conn)
        throw new Error("Weaver session has no connection configured");
    const model = session.model?.trim() || conn.model;
    if (!model)
        throw new Error("Weaver session has no model configured");
    return { conn, model };
}
export function stripCodeFence(s) {
    const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return m ? m[1] : s;
}
function resolveTemperature(input, fallback) {
    const tuning = getWeaverTuning(input.userId);
    const override = input.kind === "review" ? tuning.review_temperature : tuning.generation_temperature;
    return override ?? input.temperature ?? fallback;
}
function normalizeUsage(usage) {
    const prompt = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
    const completion = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
    const total = Math.max(0, Math.round(usage?.total_tokens ?? prompt + completion));
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}
export async function weaverGenerateJsonWithUsage(input) {
    const { conn, model } = resolveWeaverConnection(input.userId, input.session);
    const response = await rawGenerate(input.userId, {
        provider: conn.provider,
        model,
        connection_id: conn.id,
        messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
        ],
        parameters: { temperature: resolveTemperature(input, 0.4) },
        signal: input.signal,
    });
    const content = stripCodeFence((response.content ?? "").trim());
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw new Error("Weaver model returned invalid JSON");
    }
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    return { data, usage: normalizeUsage(response.usage) };
}
export async function weaverGenerateJson(input) {
    return (await weaverGenerateJsonWithUsage(input)).data;
}
export async function weaverGenerateTextWithUsage(input) {
    const { conn, model } = resolveWeaverConnection(input.userId, input.session);
    const response = await rawGenerate(input.userId, {
        provider: conn.provider,
        model,
        connection_id: conn.id,
        messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
        ],
        parameters: { temperature: resolveTemperature(input, 0.7) },
        signal: input.signal,
    });
    const text = stripCodeFence((response.content ?? "").trim()).trim();
    return { text, usage: normalizeUsage(response.usage) };
}
