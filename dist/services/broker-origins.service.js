import { getFirstUserId } from "../auth/seed";
import { getSetting, putSetting } from "./settings.service";
export const APPROVED_BROKER_ORIGINS_SETTING_KEY = "approvedBrokerOrigins";
export class InvalidBrokerOriginError extends Error {
    status = 400;
    constructor(message) { super(message); }
}
const MAX_APPROVED_BROKER_ORIGINS = 32;
// ─── Normalization / validation ─────────────────────────────────────────────
/**
 * Accepts user-entered origins like "https://broker.example.com:8443".
 * Returns the lowercase `URL.origin` so stored values are byte-compatible
 * with the `parsed.origin` comparison in provider-registry's
 * assertBrokerSpec (default-port elision matches exactly). Rejects bare
 * hostnames, non-http(s) schemes, embedded credentials, and wildcards.
 */
export function normalizeOrigin(input) {
    if (typeof input !== "string") {
        throw new InvalidBrokerOriginError("Broker origin must be a string");
    }
    const trimmed = input.trim();
    if (!trimmed)
        throw new InvalidBrokerOriginError("Broker origin cannot be empty");
    if (trimmed.includes("*") || trimmed.includes("?")) {
        throw new InvalidBrokerOriginError("Wildcards are not allowed — list each origin explicitly");
    }
    if (!/^https?:\/\//i.test(trimmed)) {
        throw new InvalidBrokerOriginError(`Broker origin must include an http:// or https:// scheme: ${input}`);
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new InvalidBrokerOriginError(`Invalid URL: ${input}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new InvalidBrokerOriginError(`Broker origin must use http or https: ${input}`);
    }
    if (parsed.username || parsed.password) {
        throw new InvalidBrokerOriginError(`Credentials are not allowed in broker origins: ${input}`);
    }
    if (!parsed.hostname) {
        throw new InvalidBrokerOriginError(`Invalid hostname: ${input}`);
    }
    return parsed.origin.toLowerCase();
}
// ─── State ──────────────────────────────────────────────────────────────────
let configuredOrigins = [];
let loaded = false;
// ─── Public API ─────────────────────────────────────────────────────────────
export function load() {
    const ownerId = getFirstUserId();
    configuredOrigins = [];
    if (ownerId) {
        try {
            const row = getSetting(ownerId, APPROVED_BROKER_ORIGINS_SETTING_KEY);
            const raw = row?.value;
            const list = Array.isArray(raw) ? raw : [];
            const seen = new Set();
            for (const entry of list) {
                try {
                    const normalized = normalizeOrigin(entry);
                    if (seen.has(normalized))
                        continue;
                    seen.add(normalized);
                    configuredOrigins.push(normalized);
                }
                catch {
                    // Skip malformed persisted entries rather than crashing startup.
                }
            }
            if (configuredOrigins.length > MAX_APPROVED_BROKER_ORIGINS) {
                configuredOrigins = configuredOrigins.slice(0, MAX_APPROVED_BROKER_ORIGINS);
            }
        }
        catch (err) {
            console.warn("[broker-origins] Failed to read setting:", err);
        }
    }
    loaded = true;
}
function ensureLoaded() {
    if (!loaded)
        load();
}
/**
 * Returns the operator-approved broker origins. An empty allowlist is
 * permissive: provider registration accepts any http(s) broker origin.
 */
export function getApprovedBrokerOrigins() {
    ensureLoaded();
    return [...configuredOrigins];
}
export function setApprovedBrokerOrigins(origins) {
    if (!Array.isArray(origins)) {
        throw new InvalidBrokerOriginError("Payload must be { origins: string[] }");
    }
    if (origins.length > MAX_APPROVED_BROKER_ORIGINS) {
        throw new InvalidBrokerOriginError(`Too many approved broker origins (max ${MAX_APPROVED_BROKER_ORIGINS})`);
    }
    // Persist against the server owner's settings row so that `load()` (which
    // also resolves via `getFirstUserId()`) sees the same value on restart.
    const ownerId = getFirstUserId();
    if (!ownerId) {
        throw new InvalidBrokerOriginError("Server owner is not initialized yet");
    }
    const seen = new Set();
    const normalized = [];
    for (const raw of origins) {
        const origin = normalizeOrigin(raw);
        if (seen.has(origin))
            continue;
        seen.add(origin);
        normalized.push(origin);
    }
    putSetting(ownerId, APPROVED_BROKER_ORIGINS_SETTING_KEY, normalized);
    configuredOrigins = normalized;
    loaded = true;
    return [...configuredOrigins];
}
// ─── Test support ───────────────────────────────────────────────────────────
/** @internal Only intended for unit tests — resets in-memory state. */
export function _resetForTests() {
    configuredOrigins = [];
    loaded = false;
}
/** @internal Only intended for unit tests — bypasses owner-backed persistence. */
export function _setApprovedBrokerOriginsForTests(origins) {
    configuredOrigins = [];
    const seen = new Set();
    for (const raw of origins) {
        const origin = normalizeOrigin(raw);
        if (seen.has(origin))
            continue;
        seen.add(origin);
        configuredOrigins.push(origin);
    }
    loaded = true;
}
