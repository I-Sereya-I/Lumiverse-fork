export function normalizeSpindleAppNavigationPath(rawUrl, fallback = "/") {
    const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!trimmed)
        return fallback;
    if (!trimmed.startsWith("/") || trimmed.startsWith("//"))
        return fallback;
    return trimmed;
}
export function normalizeSpindleHttpsUrl(rawUrl, fieldName, options) {
    const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!trimmed) {
        if (options?.required) {
            throw new Error(`Missing ${fieldName} in spindle.json`);
        }
        return "";
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new Error(`Invalid ${fieldName} URL in spindle.json`);
    }
    if (parsed.protocol !== "https:") {
        throw new Error(`${fieldName} URL must use https://`);
    }
    return parsed.toString();
}
