import { providerRegistry, } from "../spindle/provider-registry";
import { emitProviderRegistryChanged } from "../ws/bus";
const providers = new Map();
const CONSUMER_PROVIDER_SCOPE = "frontend";
const ttsConsumerRevisions = new Map();
const REGISTRY_TTS_CAPABILITIES = {
    parameters: {},
    apiKeyRequired: false,
    voiceListStyle: "static",
    staticVoices: [],
    modelListStyle: "static",
    staticModels: [],
    supportsStreaming: false,
    supportedFormats: ["mp3"],
    defaultUrl: "",
    defaultFormat: "mp3",
};
export function registerTtsProvider(provider) {
    providers.set(provider.name, provider);
}
function ttsDisplayName(record) {
    const description = record.descriptor.description;
    if (description && typeof description === "object" && !Array.isArray(description)) {
        const name = description.name;
        if (typeof name === "string" && name.trim())
            return name.trim();
    }
    return record.key.id;
}
function ttsDenied(record) {
    const description = record.descriptor.description;
    if (!description || typeof description !== "object" || Array.isArray(description))
        return false;
    const rec = description;
    return rec.denied === true || rec.visible === false || rec.status === "denied";
}
function visibleTtsRecords(userId) {
    // Absent userId resolves SYSTEM-scope providers ONLY — never an all-scopes
    // sweep across other users' records. Every production caller passes the
    // authenticated user id explicitly; tests may pass "system" semantics.
    const scopes = userId
        ? [`user:${userId}`, "system"]
        : ["system"];
    const records = providerRegistry.listVisible(scopes);
    const extra = [];
    try {
        for (const record of records) {
            try {
                if (record.key.kind !== "tts")
                    continue;
                if (ttsDenied(record))
                    continue;
                extra.push(record);
            }
            catch {
                // Isolated: a broken descriptor cannot hide other engines.
            }
        }
    }
    catch {
        return [];
    }
    return extra;
}
class RegistryTtsAdapter {
    record;
    callerUserId;
    name;
    displayName;
    capabilities = REGISTRY_TTS_CAPABILITIES;
    constructor(record, callerUserId) {
        this.record = record;
        this.callerUserId = callerUserId;
        this.name = record.key.id;
        this.displayName = ttsDisplayName(record);
    }
    async synthesize(_apiKey, _apiUrl, request) {
        try {
            // The caller's real scope, never the provider's own scope: passing the
            // record's effectiveScope here would let any caller slip past the
            // registry's cross-scope isolation check.
            const result = await providerRegistry.invoke(this.record.key, request, {
                callerScope: this.callerScope(),
            });
            if (result && typeof result === "object" && result instanceof ArrayBuffer) {
                return {
                    audioData: result,
                    contentType: "audio/mpeg",
                    model: request.model,
                    provider: this.name,
                };
            }
            throw new Error("registry tts returned no audio");
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`tts provider ${this.name} failed: ${message}`);
        }
    }
    callerScope() {
        return this.callerUserId ? `user:${this.callerUserId}` : "system";
    }
    async *synthesizeStream() {
        throw new Error(`tts provider ${this.name} does not support streaming`);
    }
    async validateKey() {
        return true;
    }
    async listModels() {
        return [];
    }
    async listVoices() {
        return [];
    }
}
function registryTtsAdapter(record, callerUserId) {
    return new RegistryTtsAdapter(record, callerUserId ?? null);
}
export function getTtsProvider(name, userId) {
    const builtin = providers.get(name);
    if (builtin)
        return builtin;
    const record = visibleTtsRecords(userId).find((entry) => entry.key.id === name);
    return record ? registryTtsAdapter(record, userId) : undefined;
}
export function listTtsProviders(userId) {
    return getTtsProviderList(userId).map((provider) => provider.name);
}
export function getTtsProviderList(userId) {
    const extras = [];
    for (const record of visibleTtsRecords(userId)) {
        try {
            extras.push(registryTtsAdapter(record, userId));
        }
        catch {
            // Isolated adapter construction.
        }
    }
    return [...providers.values(), ...extras];
}
function nextTtsRevision(userId) {
    const revision = (ttsConsumerRevisions.get(userId) ?? 0) + 1;
    ttsConsumerRevisions.set(userId, revision);
    return { generation: 1, revision };
}
export function publishTtsProviderRegistryChanged(args) {
    const clock = nextTtsRevision(args.userId);
    emitProviderRegistryChanged({
        userId: args.userId,
        scope: CONSUMER_PROVIDER_SCOPE,
        action: args.action,
        generation: clock.generation,
        revision: clock.revision,
        payload: args.payload,
    });
}
export function commitTtsRegistryProvider(descriptor, host, userId) {
    const record = providerRegistry.register(descriptor, host);
    publishTtsProviderRegistryChanged({
        userId,
        action: "add",
        payload: {
            id: record.key.id,
            kind: record.key.kind,
            name: ttsDisplayName(record),
            installationId: record.key.installationId,
        },
    });
    return record;
}
export function revokeTtsRegistryProvider(ref, host, userId) {
    const removed = providerRegistry.unregister(ref, host);
    if (removed) {
        publishTtsProviderRegistryChanged({
            userId,
            action: "remove",
            payload: { id: ref.id, kind: ref.kind },
        });
    }
    return removed;
}
function hostScopeFromTtsEngine(engine) {
    const installationId = typeof engine.installationId === "string" && engine.installationId.trim()
        ? engine.installationId.trim()
        : "host";
    const installScope = engine.installScope === "user" || engine.installScope === "operator" || engine.installScope === "system"
        ? engine.installScope
        : "system";
    return {
        installationId,
        installScope,
        installedByUserId: engine.installedByUserId,
        authenticatedSubject: engine.authenticatedSubject,
    };
}
export function registerTtsEngine(id, engine) {
    const host = hostScopeFromTtsEngine(engine);
    providerRegistry.register({
        kind: "tts",
        id,
        description: engine.description ?? engine,
        broker: engine.broker,
        generation: engine.generation,
        revision: engine.revision,
        owner: engine.owner,
    }, host);
    let disposed = false;
    return () => {
        if (disposed)
            return;
        disposed = true;
        providerRegistry.unregister({ kind: "tts", id }, host);
    };
}
