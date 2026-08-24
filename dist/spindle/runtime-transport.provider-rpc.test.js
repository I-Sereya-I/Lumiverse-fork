import { afterEach, describe, expect, test } from "bun:test";
import { ProviderRegistry, PROVIDER_ENVELOPE_MAX_BYTES, envelopeContainsSecrets, measureJsonBytes, redactForWorker, } from "./provider-registry";
function wrapTransport() {
    const posted = [];
    return {
        posted,
        postMessage(message) {
            if (message &&
                typeof message === "object" &&
                String(message.type ?? "").startsWith("provider_")) {
                if (envelopeContainsSecrets(message)) {
                    throw new Error("provider RPC envelope contained secrets");
                }
                if (measureJsonBytes(message) > PROVIDER_ENVELOPE_MAX_BYTES) {
                    throw new Error("provider RPC envelope exceeds 1MiB");
                }
            }
            posted.push(message);
        },
    };
}
afterEach(() => undefined);
describe("runtime transport provider RPC", () => {
    test("forwards the six phase-tagged provider discriminators", () => {
        const transport = wrapTransport();
        const workerToHost = [
            { type: "provider_register", phase: "register", kind: "embedding", id: "foo" },
            { type: "provider_unregister", phase: "unregister", kind: "embedding", id: "foo" },
            { type: "provider_result", phase: "result", correlationId: "c1", round: 1, result: { ok: true } },
        ];
        const hostToWorker = [
            {
                type: "provider_invoke",
                phase: "invoke",
                correlationId: "c1",
                round: 1,
                key: { effectiveScope: "user:alice", installationId: "inst-a", kind: "embedding", id: "foo" },
                request: { text: "hi" },
            },
            { type: "provider_abort", phase: "abort", correlationId: "c1", round: 1, reason: "cancel" },
            {
                type: "provider_changed",
                phase: "changed",
                action: "registered",
                key: { effectiveScope: "user:alice", installationId: "inst-a", kind: "embedding", id: "foo" },
            },
        ];
        for (const message of [...workerToHost, ...hostToWorker]) {
            transport.postMessage(message);
        }
        expect(transport.posted.map((message) => message.type)).toEqual([
            "provider_register",
            "provider_unregister",
            "provider_result",
            "provider_invoke",
            "provider_abort",
            "provider_changed",
        ]);
        expect(transport.posted.map((message) => message.phase)).toEqual([
            "register",
            "unregister",
            "result",
            "invoke",
            "abort",
            "changed",
        ]);
    });
    test("redacts secrets and preserves binary payloads", () => {
        const transport = wrapTransport();
        const binary = new Uint8Array([1, 2, 3, 4]);
        const redacted = redactForWorker({
            type: "provider_invoke",
            phase: "invoke",
            authorization: "Bearer leaked",
            secretKey: "sk-host",
            headers: { Authorization: "Bearer leaked", Accept: "application/octet-stream" },
            request: { body: binary, apiKey: "nope" },
        });
        transport.postMessage(redacted);
        const posted = transport.posted[0];
        expect(posted.authorization).toBeUndefined();
        expect(posted.secretKey).toBeUndefined();
        expect(posted.headers.Accept).toBe("application/octet-stream");
        expect(posted.headers.Authorization).toBeUndefined();
        expect(posted.request.body).toEqual(binary);
        expect(posted.request.apiKey).toBeUndefined();
    });
    test("suppresses stale-round provider_result envelopes", () => {
        const registry = new ProviderRegistry({ timeoutMs: 30_000 });
        const transport = wrapTransport();
        registry.attachWorker("inst-a", (message) => transport.postMessage(message));
        registry.register({ kind: "embedding", id: "foo" }, { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" });
        const pending = registry.invoke({ effectiveScope: "user:alice", installationId: "inst-a", kind: "embedding", id: "foo" }, { text: "hi" }, { callerScope: "user:alice", correlationId: "round-1", round: 2 });
        expect(registry.handleProviderResult({
            type: "provider_result",
            phase: "result",
            correlationId: "round-1",
            round: 1,
            result: { stale: true },
        }, { installationId: "inst-a", installScope: "user", installedByUserId: "alice" })).toBe(false);
        expect(registry.handleProviderResult({
            type: "provider_result",
            phase: "result",
            correlationId: "round-1",
            round: 2,
            result: { audio: new Uint8Array([9, 8, 7]) },
        }, { installationId: "inst-a", installScope: "user", installedByUserId: "alice" })).toBe(true);
        return expect(pending).resolves.toEqual({ audio: new Uint8Array([9, 8, 7]) });
    });
});
