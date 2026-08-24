/** Helper: extract the text content from an LlmMessage regardless of format. */
export function getTextContent(msg) {
    if (typeof msg.content === "string")
        return msg.content;
    return msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
}
export function describeContentForDisplay(content) {
    if (typeof content === "string") {
        return { text: content, contentParts: [] };
    }
    const partCounts = new Map();
    const countPart = (type) => {
        partCounts.set(type, (partCounts.get(type) ?? 0) + 1);
    };
    const text = content
        .map((part) => {
        switch (part.type) {
            case "text":
                return part.text;
            case "image":
                countPart("image");
                return `[image: ${part.mime_type}]`;
            case "audio":
                countPart("audio");
                return `[audio: ${part.mime_type}]`;
            case "tool_use":
                countPart("tool_use");
                return `[tool_call: ${part.name}(${JSON.stringify(part.input)})]`;
            case "tool_result":
                countPart("tool_result");
                return `[tool_result${part.is_error ? " (error)" : ""}: ${part.content}]`;
            default: {
                const rawType = typeof part.type === "string"
                    ? part.type
                    : "part";
                countPart(rawType);
                return `[${rawType}]`;
            }
        }
    })
        .join("\n");
    return {
        text,
        contentParts: [...partCounts.entries()].map(([type, count]) => ({
            type,
            count,
        })),
    };
}
/**
 * Flatten message content to a human-readable string for display-only surfaces
 * (e.g. the dry-run prompt viewer) that can't render multimodal parts. Text is
 * inlined in order; non-text parts become bracketed placeholders so an
 * image/audio/tool part is still visible. Unlike {@link getTextContent}, this
 * never silently drops media — important for a debugging view.
 */
export function flattenContentForDisplay(content) {
    return describeContentForDisplay(content).text;
}
