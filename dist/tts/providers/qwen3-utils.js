export const QWEN_TTS_PROVIDER = "qwen3_tts_server";
export const QWEN_SPEAKER_PREFIX = "speaker:";
export const QWEN_PROMPT_PREFIX = "prompt:";
function normalizeText(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function normalizeCreatedAt(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}
export function qwenSpeakerVoiceId(speaker) {
    return `${QWEN_SPEAKER_PREFIX}${speaker.trim()}`;
}
export function qwenPromptVoiceId(promptId) {
    return `${QWEN_PROMPT_PREFIX}${promptId.trim()}`;
}
export function parseQwenVoice(rawVoice) {
    const voice = rawVoice.trim();
    if (!voice)
        return null;
    if (voice.startsWith(QWEN_PROMPT_PREFIX)) {
        const promptId = voice.slice(QWEN_PROMPT_PREFIX.length).trim();
        return promptId ? { kind: "prompt", promptId } : null;
    }
    if (voice.startsWith(QWEN_SPEAKER_PREFIX)) {
        const speaker = voice.slice(QWEN_SPEAKER_PREFIX.length).trim();
        return speaker ? { kind: "speaker", speaker } : null;
    }
    return { kind: "speaker", speaker: voice };
}
function coerceQwenCustomVoice(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    const promptId = normalizeText(row.prompt_id);
    const name = normalizeText(row.name);
    if (!promptId || !name)
        return null;
    return {
        id: normalizeText(row.id) || qwenPromptVoiceId(promptId),
        name,
        prompt_id: promptId,
        transcript: normalizeText(row.transcript),
        source_filename: normalizeText(row.source_filename),
        created_at: normalizeCreatedAt(row.created_at),
    };
}
export function readQwenCustomVoices(metadata) {
    const raw = metadata?.qwen?.custom_voices;
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const voices = [];
    for (const item of raw) {
        const voice = coerceQwenCustomVoice(item);
        if (!voice)
            continue;
        if (seen.has(voice.id))
            continue;
        seen.add(voice.id);
        voices.push(voice);
    }
    voices.sort((a, b) => {
        if (a.created_at !== b.created_at)
            return b.created_at - a.created_at;
        return a.name.localeCompare(b.name);
    });
    return voices;
}
export function writeQwenCustomVoices(metadata, voices) {
    const next = { ...(metadata || {}) };
    const qwen = next.qwen && typeof next.qwen === "object" ? { ...next.qwen } : {};
    qwen.custom_voices = voices;
    next.qwen = qwen;
    return next;
}
export function upsertQwenCustomVoice(metadata, voice) {
    const existing = readQwenCustomVoices(metadata).filter((item) => item.id !== voice.id);
    return writeQwenCustomVoices(metadata, [voice, ...existing]);
}
export function removeQwenCustomVoice(metadata, voiceId) {
    const existing = readQwenCustomVoices(metadata);
    const deleted = existing.find((item) => item.id === voiceId) || null;
    if (!deleted) {
        return {
            metadata: writeQwenCustomVoices(metadata, existing),
            deleted: null,
        };
    }
    return {
        metadata: writeQwenCustomVoices(metadata, existing.filter((item) => item.id !== voiceId)),
        deleted,
    };
}
export function qwenCustomVoicesAsTtsVoices(metadata) {
    return readQwenCustomVoices(metadata).map((voice) => ({
        id: voice.id,
        name: voice.name,
    }));
}
export function mergeQwenVoiceOptions(providerVoices, metadata) {
    const customVoices = qwenCustomVoicesAsTtsVoices(metadata);
    const merged = [...customVoices, ...providerVoices];
    const seen = new Set();
    return merged.filter((voice) => {
        if (!voice?.id || seen.has(voice.id))
            return false;
        seen.add(voice.id);
        return true;
    });
}
export function qwenApiBaseUrl(apiUrl) {
    let url = (apiUrl || "http://localhost:8000").trim();
    url = url.replace(/\/+$/, "");
    url = url.replace(/\/redoc(?:#.*)?$/, "");
    url = url.replace(/\/docs(?:#.*)?$/, "");
    url = url.replace(/\/api\/v1$/, "");
    return url;
}
