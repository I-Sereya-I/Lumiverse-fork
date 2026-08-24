import { getProvider } from "../llm/registry";
import { OpenRouterProvider } from "../llm/providers/openrouter";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
/** In-memory store for pending OAuth sessions. Keyed by session_token. TTL: 5 minutes. */
const pendingOAuth = new Map();
const OAUTH_TTL_MS = 5 * 60 * 1000;
/**
 * Hard cap so an attacker can't keep calling /openrouter/auth and pin entries
 * indefinitely. cleanupExpiredSessions is also called from initiate, so the
 * common case is bounded; this is a backstop for adversarial loops.
 */
const MAX_PENDING_OAUTH = 10_000;
/** Periodically clean up expired sessions. */
function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of pendingOAuth) {
        if (now - session.createdAt > OAUTH_TTL_MS) {
            pendingOAuth.delete(token);
        }
    }
    // FIFO eviction if the map is still over the cap after expiry sweep.
    while (pendingOAuth.size >= MAX_PENDING_OAUTH) {
        const oldest = pendingOAuth.keys().next();
        if (oldest.done)
            break;
        pendingOAuth.delete(oldest.value);
    }
}
/** Generate a random code verifier for PKCE (43–128 chars, URL-safe). */
function generateCodeVerifier() {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString("base64url");
}
/** Compute S256 code challenge from verifier. */
async function computeCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Buffer.from(hash).toString("base64url");
}
/**
 * Initiate the PKCE OAuth flow. Generates code_verifier/challenge,
 * stores verifier server-side, returns the authorization URL + session token.
 *
 * Either `connectionId` (existing profile) or `connectionName` (auto-create on
 * callback) must be provided.
 */
export async function initiateOAuthAsync(callbackUrl, opts) {
    cleanupExpiredSessions();
    const codeVerifier = generateCodeVerifier();
    const sessionToken = crypto.randomUUID();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    pendingOAuth.set(sessionToken, {
        connectionId: opts.connectionId,
        connectionName: opts.connectionName,
        codeVerifier,
        callbackUrl,
        createdAt: Date.now(),
    });
    const params = new URLSearchParams({
        callback_url: callbackUrl,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
    });
    return {
        auth_url: `https://openrouter.ai/auth?${params.toString()}`,
        session_token: sessionToken,
    };
}
/**
 * Complete the PKCE OAuth flow: exchange the authorization code for an API key,
 * then store it as the connection's encrypted API key.
 *
 * If the session was initiated without an existing connection (creation flow),
 * the connection is auto-created here so orphaned profiles are avoided when the
 * user cancels the popup.
 */
export async function completeOAuth(userId, sessionToken, code) {
    const session = pendingOAuth.get(sessionToken);
    if (!session)
        throw new Error("Invalid or expired session token");
    // Check TTL
    if (Date.now() - session.createdAt > OAUTH_TTL_MS) {
        pendingOAuth.delete(sessionToken);
        throw new Error("OAuth session has expired");
    }
    let connectionId = session.connectionId;
    let created = false;
    if (connectionId) {
        // Existing connection — verify it belongs to this user
        const conn = connSvc.getConnection(userId, connectionId);
        if (!conn)
            throw new Error("Connection not found");
        if (conn.provider !== "openrouter")
            throw new Error("Connection is not an OpenRouter profile");
    }
    // Exchange code for API key
    const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            code,
            code_verifier: session.codeVerifier,
            code_challenge_method: "S256",
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        pendingOAuth.delete(sessionToken);
        throw new Error(`OpenRouter key exchange failed (${res.status}): ${err}`);
    }
    const data = (await res.json());
    if (!data.key) {
        pendingOAuth.delete(sessionToken);
        throw new Error("OpenRouter did not return an API key");
    }
    // Auto-create connection if this was a creation-time OAuth flow
    if (!connectionId) {
        const profile = await connSvc.createConnection(userId, {
            name: session.connectionName || "OpenRouter",
            provider: "openrouter",
        });
        connectionId = profile.id;
        created = true;
    }
    // Store the key as the connection's API key
    await connSvc.setConnectionApiKey(userId, connectionId, data.key);
    // Clean up
    pendingOAuth.delete(sessionToken);
    const profile = connSvc.getConnection(userId, connectionId);
    return { success: true, connection_id: connectionId, created, profile };
}
// ── Credits & Usage ──────────────────────────────────────────────────────────
function getOpenRouterProvider() {
    const provider = getProvider("openrouter");
    if (!provider || !(provider instanceof OpenRouterProvider)) {
        throw new Error("OpenRouter provider not registered");
    }
    return provider;
}
export async function fetchCredits(userId, connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "openrouter")
        return null;
    const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
    if (!apiKey)
        return null;
    const provider = getOpenRouterProvider();
    return provider.fetchCredits(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}
// ── Model Metadata ───────────────────────────────────────────────────────────
export async function fetchModelsWithMetadata(userId, connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "openrouter")
        return null;
    const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
    if (!apiKey)
        return null;
    const provider = getOpenRouterProvider();
    return provider.fetchModelsWithMetadata(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}
// ── Generation Stats ─────────────────────────────────────────────────────────
export async function fetchGenerationStats(userId, connectionId, generationId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "openrouter")
        return null;
    const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
    if (!apiKey)
        return null;
    const provider = getOpenRouterProvider();
    return provider.fetchGenerationStats(apiKey, connSvc.resolveEffectiveApiUrl(conn), generationId);
}
// ── Provider List ────────────────────────────────────────────────────────────
export async function fetchProviderList(userId, connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "openrouter")
        return null;
    const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
    if (!apiKey)
        return null;
    const provider = getOpenRouterProvider();
    return provider.fetchProviderList(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}
