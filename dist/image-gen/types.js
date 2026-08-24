/**
 * Top-level keys a user is NOT allowed to override via rawRequestOverride.
 * Without this guard, a user could swap the model, disable provider safety
 * settings, or smuggle their own auth fields into the outgoing request.
 * Provider-specific extensions can extend this list before invoking applyRawOverride.
 */
export const PROTECTED_RAW_OVERRIDE_KEYS = new Set([
    "model",
    "modelId",
    "model_id",
    "safetySettings",
    "safety_settings",
    "apiKey",
    "api_key",
    "key",
    "authorization",
    "Authorization",
    "headers",
    "endpoint",
    "url",
]);
/**
 * Deep-merge `override` into `target`, returning a new object.
 * Arrays in override replace (not concat) arrays in target.
 * Top-level keys in `protectedKeys` are dropped from the override before merging.
 *
 * Throws on invalid JSON or a non-object value: silently generating without
 * the user's params reads as "the feature doesn't work", and a scalar/array
 * override would replace the entire request body via deepMerge.
 */
export function applyRawOverride(target, rawJson, protectedKeys = PROTECTED_RAW_OVERRIDE_KEYS) {
    if (!rawJson || !rawJson.trim())
        return target;
    let override;
    try {
        override = JSON.parse(rawJson);
    }
    catch (err) {
        throw new Error(`Raw Request Override is not valid JSON (${err instanceof Error ? err.message : "parse error"}). Fix or clear the field and retry.`);
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
        throw new Error('Raw Request Override must be a JSON object of request fields, e.g. {"steps": 30}');
    }
    const blocked = new Set(protectedKeys);
    for (const key of Object.keys(override)) {
        if (blocked.has(key))
            delete override[key];
    }
    return deepMerge(target, override);
}
function isUnsafeMergeKey(key) {
    // `__proto__` assignment on the plain-object result would rewrite its
    // prototype (instance-level pollution that also hides protected raw
    // override keys from subsequent lookups). constructor/prototype are kept
    // out for the same reason.
    return key === "__proto__" || key === "constructor" || key === "prototype";
}
function deepMerge(target, source) {
    if (source === null || source === undefined)
        return target;
    if (typeof source !== "object" || Array.isArray(source))
        return source;
    if (typeof target !== "object" || Array.isArray(target))
        return source;
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (isUnsafeMergeKey(key))
            continue;
        if (typeof result[key] === "object" &&
            result[key] !== null &&
            !Array.isArray(result[key]) &&
            typeof source[key] === "object" &&
            source[key] !== null &&
            !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key], source[key]);
        }
        else {
            result[key] = source[key];
        }
    }
    return result;
}
