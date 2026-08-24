const DEFAULT_CONFIG = {
    asteriskMode: "thought",
    plainTextMode: "narration",
};
/**
 * Parse text into speech segments based on formatting delimiters.
 *
 * - Text in "quotes" → speech
 * - Text in *asterisks* → thought or narration (configurable)
 * - Everything else → narration or speech (configurable)
 *
 * Handles unmatched delimiters by treating them as plain text.
 * Merges adjacent segments of the same type.
 */
export function detectSpeechSegments(text, config) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // Regex: match *asterisked*, "quoted", or undecorated text in order
    // Uses a non-greedy match for content between delimiters
    const pattern = /\*([^*]+)\*|"([^"]+)"|([^*"]+)/g;
    const raw = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match[1] !== undefined) {
            // Asterisked content
            const trimmed = match[1].trim();
            if (trimmed) {
                raw.push({ type: cfg.asteriskMode, text: trimmed });
            }
        }
        else if (match[2] !== undefined) {
            // Quoted content — always speech
            const trimmed = match[2].trim();
            if (trimmed) {
                raw.push({ type: "speech", text: trimmed });
            }
        }
        else if (match[3] !== undefined) {
            // Undecorated content
            const trimmed = match[3].trim();
            if (trimmed) {
                raw.push({ type: cfg.plainTextMode, text: trimmed });
            }
        }
    }
    // Merge adjacent segments of the same type
    const merged = [];
    for (const seg of raw) {
        const last = merged[merged.length - 1];
        if (last && last.type === seg.type) {
            last.text += " " + seg.text;
        }
        else {
            merged.push({ ...seg });
        }
    }
    return merged;
}
