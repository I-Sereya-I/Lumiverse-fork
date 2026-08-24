/**
 * Worker runtime — runs inside each extension's Bun worker thread.
 * Receives "init" from the host, dynamically imports the extension,
 * and exposes the `spindle` global API.
 */
import { initializeSandbox } from "./worker-runtime-sandbox";
import { deserializeWorkerResponseError } from "./worker-response-error";
import { deriveCharacterOverlay } from "../utils/color-engine";
import { assertValidSharedRpcEndpoint, normalizeOwnedSharedRpcEndpoint, } from "./shared-rpc";
import { AsyncLocalStorage } from "node:async_hooks";
const nativeProcessExit = process.exit.bind(process);
// ─── State ───────────────────────────────────────────────────────────────
let manifest;
let storagePath;
let hostDescriptor = null;
const eventHandlers = new Map();
const pendingResponses = new Map();
const streamingGenerations = new Map();
const streamingImageGenerations = new Map();
const interceptorAbortControllers = new Map();
const providerHandlers = new Map();
const providerAbortControllers = new Map();
const providerChangedHandlers = new Set();
let interceptHandler = null;
let interceptRegistrationId = null;
let contextHandlerFn = null;
let messageContentProcessorFn = null;
let macroInterceptorFn = null;
let worldInfoInterceptorFn = null;
let oauthCallbackHandler = null;
const frontendMessageHandlers = new Set();
const frontendRuntimeCapabilityRefCounts = new Map();
const commandInvokedHandlers = new Set();
const permissionDeniedHandlers = new Set();
const permissionChangedHandlers = new Set();
const frontendProcessLifecycleHandlers = new Set();
const frontendProcessMessageHandlers = new Set();
const backendProcessLifecycleHandlers = new Set();
const backendProcessMessageHandlers = new Set();
const sharedRpcHandlers = new Map();
const grantedPermissions = new Set();
const extensionMacroHandlers = new Map();
const macroInvocationStack = [];
const sharedRpcPermissionScope = new AsyncLocalStorage();
function isLocalRuntimeEvent(event) {
    return event === "PERMISSION_CHANGED";
}
// ─── Messaging ───────────────────────────────────────────────────────────
function post(msg) {
    const scope = sharedRpcPermissionScope.getStore();
    if (scope) {
        msg.rpcPermissionScopeId = scope.id;
    }
    if (typeof process.send === "function") {
        process.send(msg);
        return;
    }
    self.postMessage(msg);
}
function request(msg) {
    return new Promise((resolve, reject) => {
        pendingResponses.set(msg.requestId, { resolve, reject });
        post(msg);
    });
}
function normalizeOwnedRpcPoolEndpoint(endpoint) {
    return normalizeOwnedSharedRpcEndpoint(manifest.identifier, endpoint);
}
function createFrontendProcessHandle(info) {
    return {
        processId: info.processId,
        kind: info.kind,
        ...(info.key ? { key: info.key } : {}),
        info,
        send(payload) {
            post({ type: "frontend_process_send", processId: info.processId, payload });
        },
        async stop(options) {
            const requestId = crypto.randomUUID();
            await request({
                type: "frontend_process_stop",
                requestId,
                processId: info.processId,
                options,
            });
        },
        async refresh() {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "frontend_process_get", requestId, processId: info.processId });
            return result;
        },
    };
}
function createBackendProcessHandle(info) {
    return {
        processId: info.processId,
        entry: info.entry,
        kind: info.kind,
        ...(info.key ? { key: info.key } : {}),
        info,
        send(payload) {
            post({ type: "backend_process_send", processId: info.processId, payload });
        },
        async stop(options) {
            const requestId = crypto.randomUUID();
            await request({
                type: "backend_process_stop",
                requestId,
                processId: info.processId,
                options,
            });
        },
        async refresh() {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "backend_process_get", requestId, processId: info.processId });
            return result;
        },
    };
}
function getActiveMacroInvocation() {
    return macroInvocationStack.length > 0 ? macroInvocationStack[macroInvocationStack.length - 1] : null;
}
function assertMutationAllowed(operation) {
    if (getActiveMacroInvocation()?.commit === false) {
        throw new Error(`${operation} is not allowed during non-committing macro resolution`);
    }
}
/** Build a real AbortError-shaped DOMException so `err.name === "AbortError"` works. */
function makeAbortError(reason) {
    // DOMException is available in Bun workers; fall back to a plain Error-shape.
    const message = typeof reason === "string" ? reason : "Generation aborted";
    if (typeof DOMException === "function") {
        return new DOMException(message, "AbortError");
    }
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}
/**
 * Issue a `request_generation` RPC with optional AbortSignal support.
 *
 * `AbortSignal` can't cross the worker→host boundary (it's not
 * structured-cloneable), so the signal is stripped from `input` before
 * posting and instead we post a `cancel_generation` message when it fires.
 * If the signal is already aborted, we reject synchronously without
 * bothering the host.
 */
function requestGeneration(input) {
    const signal = input?.signal;
    const { signal: _omit, ...payload } = input ?? {};
    void _omit;
    if (signal?.aborted) {
        return Promise.reject(makeAbortError(signal.reason?.message));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            // Tell the host to tear down the upstream LLM request. The host will
            // still respond with an `AbortError`-prefixed error which the
            // `response` handler converts into a DOMException when rejecting.
            post({ type: "cancel_generation", requestId });
        };
        pendingResponses.set(requestId, {
            resolve: (value) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(value);
            },
            reject: (reason) => {
                signal?.removeEventListener("abort", onAbort);
                reject(reason);
            },
        });
        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }
        post({ type: "request_generation", requestId, input: payload });
    });
}
/** Assembly uses the generation cancellation channel but never invokes a provider. */
function requestAssembly(input, userId) {
    const signal = input?.signal;
    const { signal: _omit, ...payload } = input ?? {};
    void _omit;
    if (signal?.aborted) {
        return Promise.reject(makeAbortError(signal.reason?.message ?? "Assembly aborted"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const onAbort = () => post({ type: "cancel_generation", requestId });
        pendingResponses.set(requestId, {
            resolve: (value) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(value);
            },
            reject: (reason) => {
                signal?.removeEventListener("abort", onAbort);
                reject(reason);
            },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        post({ type: "assemble_prompt", requestId, input: payload, userId });
    });
}
/** Issue an RPC whose authority is bound to the currently active interceptor. */
function requestBoundGeneration(type, input) {
    const signal = input.signal;
    const { signal: _omit, ...payload } = input;
    void _omit;
    if (signal?.aborted) {
        return Promise.reject(makeAbortError(signal.reason?.message));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const onAbort = () => post({ type: "cancel_generation", requestId });
        pendingResponses.set(requestId, {
            resolve: (value) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(value);
            },
            reject: (reason) => {
                signal?.removeEventListener("abort", onAbort);
                reject(reason);
            },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        post({ type, requestId, input: payload });
    });
}
/**
 * Issue a `request_generation_stream` RPC and return an `AsyncGenerator`
 * that yields `StreamChunkDTO` values as the host forwards them. The
 * generator throws on `generation_stream_error` (with `AbortError` shape
 * preserved) and returns after the terminal `done` chunk.
 *
 * If the consumer breaks out of the `for await` loop early, the generator's
 * `finally` posts a `cancel_generation` message so the host can tear down
 * the upstream LLM request — this mirrors the explicit `AbortSignal` path.
 */
function requestGenerationStream(input) {
    const signal = input?.signal;
    const { signal: _omit, ...payload } = input ?? {};
    void _omit;
    if (signal?.aborted) {
        const err = makeAbortError(signal.reason?.message);
        return (async function* () {
            throw err;
        })();
    }
    const requestId = crypto.randomUUID();
    const queue = [];
    let waiter = null;
    let terminated = false;
    const push = (chunk) => {
        if (terminated)
            return;
        if (chunk.type === "done")
            terminated = true;
        if (waiter) {
            const w = waiter;
            waiter = null;
            w({ kind: "chunk", chunk });
        }
        else {
            queue.push({ kind: "chunk", chunk });
        }
    };
    const fail = (err) => {
        if (terminated)
            return;
        terminated = true;
        if (waiter) {
            const w = waiter;
            waiter = null;
            w({ kind: "error", error: err });
        }
        else {
            queue.push({ kind: "error", error: err });
        }
    };
    streamingGenerations.set(requestId, { push, fail });
    const onAbort = () => {
        post({ type: "cancel_generation", requestId });
    };
    if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
    }
    post({ type: "request_generation_stream", requestId, input: payload });
    return (async function* () {
        try {
            while (true) {
                const item = queue.length > 0
                    ? queue.shift()
                    : await new Promise((resolve) => { waiter = resolve; });
                if (item.kind === "error")
                    throw item.error;
                yield item.chunk;
                if (item.chunk.type === "done")
                    return;
            }
        }
        finally {
            streamingGenerations.delete(requestId);
            signal?.removeEventListener("abort", onAbort);
            // If the consumer broke out before the terminal `done`/error chunk,
            // tell the host to abort the upstream LLM request.
            if (!terminated) {
                post({ type: "cancel_generation", requestId });
            }
        }
    })();
}
/**
 * Start an image generation that exposes its provider WebSocket status and
 * preview frames. The host rejects providers that did not opt into this
 * capability, so extensions never receive a misleading partial stream.
 */
function requestImageGenStream(input) {
    const signal = input?.signal;
    const { signal: _omit, ...payload } = input ?? {};
    void _omit;
    if (signal?.aborted) {
        const err = makeAbortError(signal.reason?.message);
        return (async function* () {
            throw err;
        })();
    }
    const requestId = crypto.randomUUID();
    const queue = [];
    let waiter = null;
    let terminated = false;
    const push = (event) => {
        if (terminated)
            return;
        if (event.type === "done")
            terminated = true;
        if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve({ kind: "event", event });
        }
        else {
            queue.push({ kind: "event", event });
        }
    };
    const fail = (error) => {
        if (terminated)
            return;
        terminated = true;
        if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve({ kind: "error", error });
        }
        else {
            queue.push({ kind: "error", error });
        }
    };
    streamingImageGenerations.set(requestId, { push, fail });
    const onAbort = () => post({ type: "image_gen_cancel_stream", requestId });
    signal?.addEventListener("abort", onAbort, { once: true });
    post({ type: "image_gen_generate_stream", requestId, input: payload });
    return (async function* () {
        try {
            while (true) {
                const item = queue.length > 0
                    ? queue.shift()
                    : await new Promise((resolve) => { waiter = resolve; });
                if (item.kind === "error")
                    throw item.error;
                yield item.event;
                if (item.event.type === "done")
                    return;
            }
        }
        finally {
            streamingImageGenerations.delete(requestId);
            signal?.removeEventListener("abort", onAbort);
            if (!terminated)
                post({ type: "image_gen_cancel_stream", requestId });
        }
    })();
}
// ─── Spindle API (exposed to extensions as globalThis.spindle) ───────────
const spindleApi = {
    get host() {
        if (!hostDescriptor)
            throw new Error("Spindle host descriptor is not initialized");
        return hostDescriptor;
    },
    frontendCapabilities: {
        declare(capability) {
            assertMutationAllowed("spindle.frontendCapabilities.declare()");
            if (capability !== "message_tag_interceptor") {
                throw new Error(`Unsupported frontend runtime capability: ${String(capability)}`);
            }
            const count = frontendRuntimeCapabilityRefCounts.get(capability) ?? 0;
            frontendRuntimeCapabilityRefCounts.set(capability, count + 1);
            if (count === 0) {
                post({ type: "register_frontend_runtime_capability", capability });
            }
            let active = true;
            return () => {
                if (!active)
                    return;
                active = false;
                const current = frontendRuntimeCapabilityRefCounts.get(capability) ?? 0;
                if (current <= 1) {
                    frontendRuntimeCapabilityRefCounts.delete(capability);
                    post({ type: "unregister_frontend_runtime_capability", capability });
                }
                else {
                    frontendRuntimeCapabilityRefCounts.set(capability, current - 1);
                }
            };
        },
    },
    on(event, handler) {
        if (!eventHandlers.has(event)) {
            eventHandlers.set(event, new Set());
            if (!isLocalRuntimeEvent(event)) {
                post({ type: "subscribe_event", event });
            }
        }
        eventHandlers.get(event).add(handler);
        return () => {
            eventHandlers.get(event)?.delete(handler);
            if (eventHandlers.get(event)?.size === 0) {
                eventHandlers.delete(event);
                if (!isLocalRuntimeEvent(event)) {
                    post({ type: "unsubscribe_event", event });
                }
            }
        };
    },
    registerMacro(def) {
        assertMutationAllowed("spindle.registerMacro()");
        if (typeof def.handler === "function") {
            // Function handler — store directly, strip before posting (not serializable)
            extensionMacroHandlers.set(def.name.toLowerCase(), def.handler);
        }
        else if (typeof def.handler === "string" && def.handler.trim()) {
            // String handlers used to be compiled via `new Function(...)`, which is
            // equivalent to eval() inside the worker context — every macro string
            // would run with full access to the extension's RPC bridge. That made
            // the handler value itself an arbitrary-code-execution sink. Refuse to
            // load string handlers; extensions must export real functions.
            post({
                type: "log",
                level: "error",
                message: `Macro "${def.name}" was registered with a string handler. ` +
                    `String handlers are no longer supported — return a function from your ` +
                    `module instead. The macro was NOT registered.`,
            });
            return;
        }
        // Strip handler before posting — host creates its own RPC handler;
        // functions can't survive structured cloning anyway
        const { handler: _, ...serializableDef } = def;
        post({
            type: "register_macro",
            definition: {
                ...serializableDef,
                // Always send an empty handler over the wire; the host invokes the
                // worker's resolveMacro() RPC for execution and never trusts the
                // serialized field.
                handler: "",
            },
        });
    },
    unregisterMacro(name) {
        assertMutationAllowed("spindle.unregisterMacro()");
        extensionMacroHandlers.delete(name.toLowerCase());
        post({ type: "unregister_macro", name });
    },
    updateMacroValue(name, value) {
        assertMutationAllowed("spindle.updateMacroValue()");
        post({ type: "update_macro_value", name, value: String(value ?? "") });
    },
    registerInterceptor(handler, priorityOrOptions, options) {
        assertMutationAllowed("spindle.registerInterceptor()");
        const registrationId = crypto.randomUUID();
        const priority = typeof priorityOrOptions === "number"
            ? priorityOrOptions
            : priorityOrOptions?.priority;
        const match = typeof priorityOrOptions === "number"
            ? options?.match
            : priorityOrOptions?.match;
        interceptHandler = handler;
        interceptRegistrationId = registrationId;
        post({ type: "register_interceptor", registrationId, priority, ...(match ? { match } : {}) });
        return () => {
            if (interceptRegistrationId !== registrationId)
                return;
            interceptHandler = null;
            interceptRegistrationId = null;
            post({ type: "unregister_interceptor", registrationId });
        };
    },
    assemble(input, userId) {
        return requestAssembly(input, userId);
    },
    async batch(ops, options) {
        assertMutationAllowed("spindle.batch()");
        const requestId = crypto.randomUUID();
        const { userId, ...batchOptions } = options || {};
        const result = await request({ type: "spindle_batch", requestId, ops, options: batchOptions, userId });
        return result;
    },
    registerTool(tool) {
        assertMutationAllowed("spindle.registerTool()");
        post({ type: "register_tool", tool });
    },
    unregisterTool(name) {
        assertMutationAllowed("spindle.unregisterTool()");
        post({ type: "unregister_tool", name });
    },
    providers: {
        register(input) {
            assertMutationAllowed("spindle.providers.register()");
            post({
                type: "provider_register",
                phase: "register",
                kind: input.kind,
                id: input.id,
                description: input.description,
                broker: input.broker,
                generation: input.generation,
                revision: input.revision,
            });
        },
        unregister(kind, id) {
            assertMutationAllowed("spindle.providers.unregister()");
            post({ type: "provider_unregister", phase: "unregister", kind, id });
        },
        handle(kind, id, handler) {
            const key = `${kind}\0${id}`;
            providerHandlers.set(key, handler);
            return () => {
                if (providerHandlers.get(key) === handler)
                    providerHandlers.delete(key);
            };
        },
        onChanged(handler) {
            providerChangedHandlers.add(handler);
            return () => {
                providerChangedHandlers.delete(handler);
            };
        },
    },
    generate: {
        assemble(input) {
            return requestBoundGeneration("generate_assemble", input);
        },
        quietTracked(input) {
            return requestBoundGeneration("generate_quiet_tracked", input);
        },
        async raw(input) {
            return requestGeneration({ ...input, type: "raw" });
        },
        async quiet(input) {
            return requestGeneration({ ...input, type: "quiet" });
        },
        async batch(input) {
            return requestGeneration({ ...input, type: "batch" });
        },
        rawStream(input) {
            return requestGenerationStream({ ...input, type: "raw" });
        },
        quietStream(input) {
            return requestGenerationStream({ ...input, type: "quiet" });
        },
        async dryRun(input, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "generate_dry_run",
                requestId,
                input,
                userId,
            });
            return result;
        },
        observe(chatId) {
            let startHandlers = [];
            let tokenHandlers = [];
            let endHandlers = [];
            let stopHandlers = [];
            let content = "";
            let reasoning = "";
            let activeGenerationId = null;
            const unsubStart = spindleApi.on("GENERATION_STARTED", (payload) => {
                const p = payload;
                if (p.chatId !== chatId)
                    return;
                activeGenerationId = p.generationId;
                content = "";
                reasoning = "";
                for (const h of startHandlers)
                    h(p);
            });
            const unsubToken = spindleApi.on("STREAM_TOKEN_RECEIVED", (payload) => {
                const p = payload;
                if (p.chatId !== chatId)
                    return;
                if (p.type === "reasoning") {
                    reasoning += p.token;
                }
                else {
                    content += p.token;
                }
                for (const h of tokenHandlers)
                    h(p);
            });
            const unsubEnd = spindleApi.on("GENERATION_ENDED", (payload) => {
                const p = payload;
                if (p.chatId !== chatId)
                    return;
                activeGenerationId = null;
                for (const h of endHandlers)
                    h(p);
            });
            const unsubStop = spindleApi.on("GENERATION_STOPPED", (payload) => {
                const p = payload;
                if (p.chatId !== chatId)
                    return;
                activeGenerationId = null;
                for (const h of stopHandlers)
                    h(p);
            });
            return {
                onStart(handler) { startHandlers.push(handler); },
                onToken(handler) { tokenHandlers.push(handler); },
                onEnd(handler) { endHandlers.push(handler); },
                onStop(handler) { stopHandlers.push(handler); },
                get content() { return content; },
                get reasoning() { return reasoning; },
                get generationId() { return activeGenerationId; },
                dispose() {
                    unsubStart();
                    unsubToken();
                    unsubEnd();
                    unsubStop();
                    startHandlers = [];
                    tokenHandlers = [];
                    endHandlers = [];
                    stopHandlers = [];
                },
            };
        },
    },
    storage: {
        async read(path) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "storage_read",
                requestId,
                path,
            });
            return result;
        },
        async write(path, data) {
            assertMutationAllowed("spindle.storage.write()");
            const requestId = crypto.randomUUID();
            await request({ type: "storage_write", requestId, path, data });
        },
        async readBinary(path) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "storage_read_binary",
                requestId,
                path,
            });
            return result;
        },
        async writeBinary(path, data) {
            assertMutationAllowed("spindle.storage.writeBinary()");
            const requestId = crypto.randomUUID();
            await request({ type: "storage_write_binary", requestId, path, data });
        },
        async delete(path) {
            assertMutationAllowed("spindle.storage.delete()");
            const requestId = crypto.randomUUID();
            await request({ type: "storage_delete", requestId, path });
        },
        async list(prefix) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "storage_list",
                requestId,
                prefix,
            });
            return result;
        },
        async exists(path) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "storage_exists", requestId, path });
            return result;
        },
        async mkdir(path) {
            assertMutationAllowed("spindle.storage.mkdir()");
            const requestId = crypto.randomUUID();
            await request({ type: "storage_mkdir", requestId, path });
        },
        async move(from, to) {
            assertMutationAllowed("spindle.storage.move()");
            const requestId = crypto.randomUUID();
            await request({ type: "storage_move", requestId, from, to });
        },
        async stat(path) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "storage_stat", requestId, path });
            return result;
        },
        async getJson(path, options) {
            try {
                const raw = await spindleApi.storage.read(path);
                return JSON.parse(raw);
            }
            catch {
                if (options && "fallback" in options) {
                    return options.fallback;
                }
                throw new Error(`Failed to parse JSON from ${path}`);
            }
        },
        async setJson(path, value, options) {
            assertMutationAllowed("spindle.storage.setJson()");
            const indent = options?.indent ?? 2;
            await spindleApi.storage.write(path, JSON.stringify(value, null, indent));
        },
    },
    userStorage: {
        async read(path, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "user_storage_read",
                requestId,
                path,
                userId,
            });
            return result;
        },
        async write(path, data, userId) {
            assertMutationAllowed("spindle.userStorage.write()");
            const requestId = crypto.randomUUID();
            await request({ type: "user_storage_write", requestId, path, data, userId });
        },
        async readBinary(path, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "user_storage_read_binary",
                requestId,
                path,
                userId,
            });
            return result;
        },
        async writeBinary(path, data, userId) {
            assertMutationAllowed("spindle.userStorage.writeBinary()");
            const requestId = crypto.randomUUID();
            await request({ type: "user_storage_write_binary", requestId, path, data, userId });
        },
        async delete(path, userId) {
            assertMutationAllowed("spindle.userStorage.delete()");
            const requestId = crypto.randomUUID();
            await request({ type: "user_storage_delete", requestId, path, userId });
        },
        async list(prefix, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "user_storage_list",
                requestId,
                prefix,
                userId,
            });
            return result;
        },
        async exists(path, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "user_storage_exists", requestId, path, userId });
            return result;
        },
        async mkdir(path, userId) {
            assertMutationAllowed("spindle.userStorage.mkdir()");
            const requestId = crypto.randomUUID();
            await request({ type: "user_storage_mkdir", requestId, path, userId });
        },
        async move(from, to, userId) {
            assertMutationAllowed("spindle.userStorage.move()");
            const requestId = crypto.randomUUID();
            await request({ type: "user_storage_move", requestId, from, to, userId });
        },
        async stat(path, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "user_storage_stat", requestId, path, userId });
            return result;
        },
        async getJson(path, options) {
            try {
                const raw = await spindleApi.userStorage.read(path, options?.userId);
                return JSON.parse(raw);
            }
            catch {
                if (options && "fallback" in options) {
                    return options.fallback;
                }
                throw new Error(`Failed to parse JSON from ${path}`);
            }
        },
        async setJson(path, value, options) {
            assertMutationAllowed("spindle.userStorage.setJson()");
            const indent = options?.indent ?? 2;
            await spindleApi.userStorage.write(path, JSON.stringify(value, null, indent), options?.userId);
        },
    },
    enclave: {
        async put(key, value, userId) {
            assertMutationAllowed("spindle.enclave.put()");
            const requestId = crypto.randomUUID();
            await request({ type: "enclave_put", requestId, key, value, userId });
        },
        async get(key, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "enclave_get", requestId, key, userId });
            return result;
        },
        async delete(key, userId) {
            assertMutationAllowed("spindle.enclave.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "enclave_delete", requestId, key, userId });
            return result;
        },
        async has(key, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "enclave_has", requestId, key, userId });
            return result;
        },
        async list(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "enclave_list", requestId, userId });
            return result;
        },
    },
    ephemeral: {
        async read(path) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ephemeral_read", requestId, path });
            return result;
        },
        async write(path, data, options) {
            assertMutationAllowed("spindle.ephemeral.write()");
            const requestId = crypto.randomUUID();
            await request({
                type: "ephemeral_write",
                requestId,
                path,
                data,
                ttlMs: options?.ttlMs,
                reservationId: options?.reservationId,
            });
        },
        async readBinary(path) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "ephemeral_read_binary",
                requestId,
                path,
            });
            return result;
        },
        async writeBinary(path, data, options) {
            assertMutationAllowed("spindle.ephemeral.writeBinary()");
            const requestId = crypto.randomUUID();
            await request({
                type: "ephemeral_write_binary",
                requestId,
                path,
                data,
                ttlMs: options?.ttlMs,
                reservationId: options?.reservationId,
            });
        },
        async delete(path) {
            assertMutationAllowed("spindle.ephemeral.delete()");
            const requestId = crypto.randomUUID();
            await request({ type: "ephemeral_delete", requestId, path });
        },
        async list(prefix) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "ephemeral_list",
                requestId,
                prefix,
            });
            return result;
        },
        async stat(path) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ephemeral_stat", requestId, path });
            return result;
        },
        async clearExpired() {
            assertMutationAllowed("spindle.ephemeral.clearExpired()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ephemeral_clear_expired", requestId });
            return result;
        },
        async getPoolStatus() {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ephemeral_pool_status", requestId });
            return result;
        },
        async requestBlock(sizeBytes, options) {
            assertMutationAllowed("spindle.ephemeral.requestBlock()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "ephemeral_request_block",
                requestId,
                sizeBytes,
                ttlMs: options?.ttlMs,
                reason: options?.reason,
            });
            return result;
        },
        async releaseBlock(reservationId) {
            assertMutationAllowed("spindle.ephemeral.releaseBlock()");
            const requestId = crypto.randomUUID();
            await request({
                type: "ephemeral_release_block",
                requestId,
                reservationId,
            });
        },
    },
    chat: {
        async getMessages(chatId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "chat_get_messages", requestId, chatId });
            return result;
        },
        async appendMessage(chatId, message, options) {
            assertMutationAllowed("spindle.chat.appendMessage()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "chat_append_message",
                requestId,
                chatId,
                message,
                options,
            });
            return result;
        },
        async updateMessage(chatId, messageId, patch) {
            assertMutationAllowed("spindle.chat.updateMessage()");
            const requestId = crypto.randomUUID();
            await request({
                type: "chat_update_message",
                requestId,
                chatId,
                messageId,
                patch,
            });
        },
        async deleteMessage(chatId, messageId) {
            assertMutationAllowed("spindle.chat.deleteMessage()");
            const requestId = crypto.randomUUID();
            await request({
                type: "chat_delete_message",
                requestId,
                chatId,
                messageId,
            });
        },
        async setMessageHidden(chatId, messageId, hidden) {
            assertMutationAllowed("spindle.chat.setMessageHidden()");
            const requestId = crypto.randomUUID();
            await request({
                type: "chat_set_message_hidden",
                requestId,
                chatId,
                messageId,
                hidden,
            });
        },
        async setMessagesHidden(chatId, messageIds, hidden) {
            assertMutationAllowed("spindle.chat.setMessagesHidden()");
            const requestId = crypto.randomUUID();
            await request({
                type: "chat_set_messages_hidden",
                requestId,
                chatId,
                messageIds,
                hidden,
            });
        },
        async isMessageHidden(chatId, messageId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "chat_is_message_hidden",
                requestId,
                chatId,
                messageId,
            });
            return result;
        },
        async setStyleMode(chatId, mode, userId) {
            assertMutationAllowed("spindle.chat.setStyleMode()");
            const requestId = crypto.randomUUID();
            await request({
                type: "chat_set_style_mode",
                requestId,
                chatId,
                mode,
                userId,
            });
        },
    },
    events: {
        async track(eventName, payload, options) {
            assertMutationAllowed("spindle.events.track()");
            const requestId = crypto.randomUUID();
            await request({
                type: "events_track",
                requestId,
                eventName,
                payload,
                options,
            });
        },
        async query(filter) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "events_query", requestId, filter });
            return result;
        },
        async replay(filter) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "events_replay", requestId, filter });
            return result;
        },
        async getLatestState(keys) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "events_get_latest_state",
                requestId,
                keys,
            });
            return result;
        },
    },
    connections: {
        async list(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "connections_list", requestId, userId });
            return result;
        },
        async get(connectionId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "connections_get", requestId, connectionId, userId });
            return result;
        },
        async resolveDispatch(connectionId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "connections_resolve_dispatch", requestId, connectionId });
            return result;
        },
    },
    uploads: {
        async get(uploadId, userId) {
            const requestId = crypto.randomUUID();
            return (await request({ type: "uploads_get", requestId, uploadId, userId }));
        },
        async readChunk(uploadId, offset, userId) {
            const requestId = crypto.randomUUID();
            return (await request({ type: "uploads_read_chunk", requestId, uploadId, offset, userId }));
        },
        async delete(uploadId, userId) {
            const requestId = crypto.randomUUID();
            return (await request({ type: "uploads_delete", requestId, uploadId, userId }));
        },
    },
    tokens: {
        async countText(text, options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "tokens_count_text",
                requestId,
                text,
                model: options?.model,
                modelSource: options?.modelSource,
                userId: options?.userId,
            });
            return result;
        },
        async countTextBatch(texts, options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "tokens_count_text_batch",
                requestId,
                texts,
                model: options?.model,
                modelSource: options?.modelSource,
                userId: options?.userId,
            });
            return result;
        },
        async countMessages(messages, options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "tokens_count_messages",
                requestId,
                messages,
                model: options?.model,
                modelSource: options?.modelSource,
                userId: options?.userId,
            });
            return result;
        },
        async countChat(chatId, options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "tokens_count_chat",
                requestId,
                chatId,
                model: options?.model,
                modelSource: options?.modelSource,
                userId: options?.userId,
            });
            return result;
        },
    },
    imageGen: {
        async generate(input) {
            const requestId = crypto.randomUUID();
            return request({ type: "image_gen_generate", requestId, input });
        },
        generateStream(input) {
            return requestImageGenStream(input);
        },
        async getProviders(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "image_gen_providers", requestId, userId });
            return result;
        },
        async listConnections(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "image_gen_connections_list", requestId, userId });
            return result;
        },
        async getConnection(connectionId, userId) {
            const requestId = crypto.randomUUID();
            return request({ type: "image_gen_connections_get", requestId, connectionId, userId });
        },
        async getModels(connectionId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "image_gen_models", requestId, connectionId, userId });
            return result;
        },
    },
    theme: {
        async apply(overrides, userId) {
            assertMutationAllowed("spindle.theme.apply()");
            const requestId = crypto.randomUUID();
            await request({ type: "theme_apply", requestId, overrides, userId });
        },
        async applyPalette(palette, userId) {
            assertMutationAllowed("spindle.theme.applyPalette()");
            const requestId = crypto.randomUUID();
            await request({ type: "theme_apply_palette", requestId, palette, userId });
        },
        async clear(userId) {
            assertMutationAllowed("spindle.theme.clear()");
            const requestId = crypto.randomUUID();
            await request({ type: "theme_clear", requestId, userId });
        },
        async getCurrent(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "theme_get_current", requestId, userId });
            return result;
        },
        async extractColors(imageId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "color_extract", requestId, imageId, userId });
            return result;
        },
        async deriveOverlay(palette) {
            // Pure computation: derive the character-aware overlay locally without a
            // host round-trip. This keeps palette → overlay fast for extensions.
            return deriveCharacterOverlay(palette.palette, palette.ui);
        },
        async generateVariables(config) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "theme_generate_variables", requestId, config });
            return result;
        },
    },
    images: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "images_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                specificity: options?.specificity,
                onlyOwned: options?.onlyOwned,
                characterId: options?.characterId,
                chatId: options?.chatId,
                userId: options?.userId,
            });
            return result;
        },
        async get(imageId, optionsOrUserId) {
            const options = typeof optionsOrUserId === "string"
                ? { userId: optionsOrUserId }
                : optionsOrUserId;
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "images_get",
                requestId,
                imageId,
                specificity: options?.specificity,
                onlyOwned: options?.onlyOwned,
                characterId: options?.characterId,
                chatId: options?.chatId,
                userId: options?.userId,
            });
            return result;
        },
        async upload(input, userId) {
            assertMutationAllowed("spindle.images.upload()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "images_upload", requestId, input, userId });
            return result;
        },
        async uploadMany(items, options) {
            assertMutationAllowed("spindle.images.uploadMany()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "images_upload_many",
                requestId,
                items,
                userId: options?.userId,
                concurrency: options?.concurrency,
            });
            return result;
        },
        async uploadFromDataUrl(dataUrl, originalFilenameOrOptions, userId) {
            assertMutationAllowed("spindle.images.uploadFromDataUrl()");
            const options = (typeof originalFilenameOrOptions === "string" || typeof originalFilenameOrOptions === "undefined"
                ? {
                    originalFilename: originalFilenameOrOptions,
                    userId,
                }
                : originalFilenameOrOptions);
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "images_upload_from_data_url",
                requestId,
                dataUrl,
                originalFilename: options?.originalFilename,
                owner_character_id: options?.owner_character_id,
                owner_chat_id: options?.owner_chat_id,
                skip_thumbnail_processing: options?.skip_thumbnail_processing,
                userId: options?.userId,
            });
            return result;
        },
        async delete(imageId, userId) {
            assertMutationAllowed("spindle.images.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "images_delete", requestId, imageId, userId });
            return result;
        },
        async deleteMany(imageIds, options) {
            assertMutationAllowed("spindle.images.deleteMany()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "images_delete_many",
                requestId,
                imageIds,
                userId: options?.userId,
            });
            return result;
        },
    },
    media: {
        async convertAudio(input) {
            assertMutationAllowed("spindle.media.convertAudio()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_audio_convert", requestId, input });
            return result;
        },
        async convertVideo(input) {
            assertMutationAllowed("spindle.media.convertVideo()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_video_convert", requestId, input });
            return result;
        },
        async transcodeVideo(input) {
            assertMutationAllowed("spindle.media.transcodeVideo()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_video_transcode", requestId, input });
            return result;
        },
        async removeAudioFromVideo(input) {
            assertMutationAllowed("spindle.media.removeAudioFromVideo()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_video_remove_audio", requestId, input });
            return result;
        },
        async addAudioToVideo(input) {
            assertMutationAllowed("spindle.media.addAudioToVideo()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_video_add_audio", requestId, input });
            return result;
        },
        async createVideoFromImageAndAudio(input) {
            assertMutationAllowed("spindle.media.createVideoFromImageAndAudio()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "media_video_from_image_audio", requestId, input });
            return result;
        },
    },
    variables: {
        local: {
            async get(chatId, key) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_get_local", requestId, chatId, key });
                return result;
            },
            async set(chatId, key, value) {
                assertMutationAllowed("spindle.variables.local.set()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_set_local", requestId, chatId, key, value });
            },
            async delete(chatId, key) {
                assertMutationAllowed("spindle.variables.local.delete()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_delete_local", requestId, chatId, key });
            },
            async list(chatId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_list_local", requestId, chatId });
                return result;
            },
            async has(chatId, key) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_has_local", requestId, chatId, key });
                return result;
            },
        },
        global: {
            async get(key, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_get_global", requestId, key, userId });
                return result;
            },
            async set(key, value, userId) {
                assertMutationAllowed("spindle.variables.global.set()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_set_global", requestId, key, value, userId });
            },
            async delete(key, userId) {
                assertMutationAllowed("spindle.variables.global.delete()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_delete_global", requestId, key, userId });
            },
            async list(userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_list_global", requestId, userId });
                return result;
            },
            async has(key, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_has_global", requestId, key, userId });
                return result;
            },
        },
        chat: {
            async get(chatId, key) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_get_chat", requestId, chatId, key });
                return result;
            },
            async set(chatId, key, value) {
                assertMutationAllowed("spindle.variables.chat.set()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_set_chat", requestId, chatId, key, value });
            },
            async delete(chatId, key) {
                assertMutationAllowed("spindle.variables.chat.delete()");
                const requestId = crypto.randomUUID();
                await request({ type: "vars_delete_chat", requestId, chatId, key });
            },
            async list(chatId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_list_chat", requestId, chatId });
                return result;
            },
            async has(chatId, key) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "vars_has_chat", requestId, chatId, key });
                return result;
            },
        },
    },
    presets: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "presets_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(presetId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "presets_get", requestId, presetId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.presets.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "presets_create", requestId, input, userId });
            return result;
        },
        async update(presetId, input, userId) {
            assertMutationAllowed("spindle.presets.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "presets_update", requestId, presetId, input, userId });
            return result;
        },
        async delete(presetId, userId) {
            assertMutationAllowed("spindle.presets.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "presets_delete", requestId, presetId, userId });
            return result;
        },
        blocks: {
            async list(presetId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "preset_blocks_list", requestId, presetId, userId });
                return result;
            },
            async get(presetId, blockId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "preset_blocks_get", requestId, presetId, blockId, userId });
                return result;
            },
            async create(presetId, input, options) {
                assertMutationAllowed("spindle.presets.blocks.create()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "preset_blocks_create",
                    requestId,
                    presetId,
                    input,
                    index: options?.index,
                    userId: options?.userId,
                });
                return result;
            },
            async update(presetId, blockId, input, userId) {
                assertMutationAllowed("spindle.presets.blocks.update()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "preset_blocks_update", requestId, presetId, blockId, input, userId });
                return result;
            },
            async delete(presetId, blockId, userId) {
                assertMutationAllowed("spindle.presets.blocks.delete()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "preset_blocks_delete", requestId, presetId, blockId, userId });
                return result;
            },
        },
        categories: {
            async list(presetId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "preset_categories_list", requestId, presetId, userId });
                return result;
            },
        },
    },
    characters: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "characters_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(characterId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "characters_get", requestId, characterId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.characters.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "characters_create", requestId, input, userId });
            return result;
        },
        async setAvatar(characterId, avatar, userId) {
            assertMutationAllowed("spindle.characters.setAvatar()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "characters_set_avatar", requestId, characterId, avatar, userId });
            return result;
        },
        async update(characterId, input, userId) {
            assertMutationAllowed("spindle.characters.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "characters_update", requestId, characterId, input, userId });
            return result;
        },
        async delete(characterId, userId) {
            assertMutationAllowed("spindle.characters.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "characters_delete", requestId, characterId, userId });
            return result;
        },
    },
    chats: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "chats_list",
                requestId,
                characterId: options?.characterId,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(chatId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "chats_get", requestId, chatId, userId });
            return result;
        },
        async getActive(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "chats_get_active", requestId, userId });
            return result;
        },
        async update(chatId, input, userId) {
            assertMutationAllowed("spindle.chats.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "chats_update", requestId, chatId, input, userId });
            return result;
        },
        async delete(chatId, userId) {
            assertMutationAllowed("spindle.chats.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "chats_delete", requestId, chatId, userId });
            return result;
        },
        async getMemories(chatId, options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "chats_get_memories",
                requestId,
                chatId,
                topK: options?.topK,
                userId: options?.userId,
            });
            return result;
        },
    },
    world_books: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "world_books_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(worldBookId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_get", requestId, worldBookId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.world_books.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_create", requestId, input, userId });
            return result;
        },
        async update(worldBookId, input, userId) {
            assertMutationAllowed("spindle.world_books.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_update", requestId, worldBookId, input, userId });
            return result;
        },
        async delete(worldBookId, userId) {
            assertMutationAllowed("spindle.world_books.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_delete", requestId, worldBookId, userId });
            return result;
        },
        entries: {
            async list(worldBookId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "world_book_entries_list",
                    requestId,
                    worldBookId,
                    limit: options?.limit,
                    offset: options?.offset,
                    userId: options?.userId,
                });
                return result;
            },
            async get(entryId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "world_book_entries_get", requestId, entryId, userId });
                return result;
            },
            async create(worldBookId, input, userId) {
                assertMutationAllowed("spindle.world_books.entries.create()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "world_book_entries_create", requestId, worldBookId, input, userId });
                return result;
            },
            async update(entryId, input, userId) {
                assertMutationAllowed("spindle.world_books.entries.update()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "world_book_entries_update", requestId, entryId, input, userId });
                return result;
            },
            async setExtension(entryId, namespace, value, userId) {
                assertMutationAllowed("spindle.world_books.entries.setExtension()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "world_books_entry_set_extension",
                    requestId,
                    entity: "world_book_entry",
                    entityId: entryId,
                    namespace,
                    value,
                    userId,
                });
                return result;
            },
            async delete(entryId, userId) {
                assertMutationAllowed("spindle.world_books.entries.delete()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "world_book_entries_delete", requestId, entryId, userId });
                return result;
            },
        },
        async getActivated(chatId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "world_books_get_activated",
                requestId,
                chatId,
                userId,
            });
            return result;
        },
        async getGlobal(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_get_global", requestId, userId });
            return result;
        },
        async setGlobal(worldBookIds, userId) {
            assertMutationAllowed("spindle.world_books.setGlobal()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_set_global", requestId, worldBookIds, userId });
            return result;
        },
        async activateGlobal(worldBookId, userId) {
            assertMutationAllowed("spindle.world_books.activateGlobal()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_activate_global", requestId, worldBookId, userId });
            return result;
        },
        async deactivateGlobal(worldBookId, userId) {
            assertMutationAllowed("spindle.world_books.deactivateGlobal()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "world_books_deactivate_global", requestId, worldBookId, userId });
            return result;
        },
    },
    entityExtensions: {
        async setNamespace(entity, entityId, namespace, value, userId) {
            assertMutationAllowed("spindle.entityExtensions.setNamespace()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "world_books_entry_set_extension",
                requestId,
                entity,
                entityId,
                namespace,
                value,
                userId,
            });
            return result;
        },
    },
    regex_scripts: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "regex_scripts_list",
                requestId,
                scope: options?.scope,
                scopeId: options?.scopeId,
                target: options?.target,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(scriptId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "regex_scripts_get", requestId, scriptId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.regex_scripts.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "regex_scripts_create", requestId, input, userId });
            return result;
        },
        async update(scriptId, input, userId) {
            assertMutationAllowed("spindle.regex_scripts.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "regex_scripts_update", requestId, scriptId, input, userId });
            return result;
        },
        async delete(scriptId, userId) {
            assertMutationAllowed("spindle.regex_scripts.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "regex_scripts_delete", requestId, scriptId, userId });
            return result;
        },
        async getActive(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "regex_scripts_get_active",
                requestId,
                target: options.target,
                characterId: options.characterId,
                chatId: options.chatId,
                userId: options.userId,
            });
            return result;
        },
    },
    databanks: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "databanks_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                scope: options?.scope,
                scopeId: options?.scopeId,
                userId: options?.userId,
            });
            return result;
        },
        async get(databankId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "databanks_get", requestId, databankId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.databanks.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "databanks_create", requestId, input, userId });
            return result;
        },
        async update(databankId, input, userId) {
            assertMutationAllowed("spindle.databanks.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "databanks_update", requestId, databankId, input, userId });
            return result;
        },
        async delete(databankId, userId) {
            assertMutationAllowed("spindle.databanks.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "databanks_delete", requestId, databankId, userId });
            return result;
        },
        documents: {
            async list(databankId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "databank_documents_list",
                    requestId,
                    databankId,
                    limit: options?.limit,
                    offset: options?.offset,
                    userId: options?.userId,
                });
                return result;
            },
            async get(documentId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_get", requestId, documentId, userId });
                return result;
            },
            async create(databankId, input, userId) {
                assertMutationAllowed("spindle.databanks.documents.create()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_create", requestId, databankId, input, userId });
                return result;
            },
            async update(documentId, input, userId) {
                assertMutationAllowed("spindle.databanks.documents.update()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_update", requestId, documentId, input, userId });
                return result;
            },
            async delete(documentId, userId) {
                assertMutationAllowed("spindle.databanks.documents.delete()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_delete", requestId, documentId, userId });
                return result;
            },
            async getContent(documentId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_get_content", requestId, documentId, userId });
                return result;
            },
            async reprocess(documentId, userId) {
                assertMutationAllowed("spindle.databanks.documents.reprocess()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "databank_documents_reprocess", requestId, documentId, userId });
                return result;
            },
        },
    },
    memories: {
        cortex: {
            async getConfig(userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_config_get", requestId, userId });
                return result;
            },
            async putConfig(patch, userId) {
                assertMutationAllowed("spindle.memories.cortex.putConfig()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_config_put", requestId, patch, userId });
                return result;
            },
            async query(query) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_query_cortex", requestId, query });
                return result;
            },
            async getCached(chatId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_get_cached", requestId, chatId });
                return result;
            },
            async queryLinked(chatId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_query_linked",
                    requestId,
                    chatId,
                    queryText: options?.queryText,
                    userId: options?.userId,
                });
                return result;
            },
            async getCachedLinked(chatId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_get_cached_linked", requestId, chatId });
                return result;
            },
            async invalidateCache(chatId) {
                assertMutationAllowed("spindle.memories.cortex.invalidateCache()");
                const requestId = crypto.randomUUID();
                await request({ type: "memories_invalidate_cache", requestId, chatId });
            },
            async invalidateLinkedCache(chatId) {
                assertMutationAllowed("spindle.memories.cortex.invalidateLinkedCache()");
                const requestId = crypto.randomUUID();
                await request({ type: "memories_invalidate_linked_cache", requestId, chatId });
            },
        },
        entities: {
            async list(chatId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_list",
                    requestId,
                    chatId,
                    activeOnly: options?.activeOnly,
                    limit: options?.limit,
                    userId: options?.userId,
                });
                return result;
            },
            async get(entityId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_entities_get", requestId, entityId, userId });
                return result;
            },
            async findByName(chatId, name, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_find_by_name",
                    requestId,
                    chatId,
                    name,
                    userId,
                });
                return result;
            },
            async upsert(chatId, entity, options) {
                assertMutationAllowed("spindle.memories.entities.upsert()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_upsert",
                    requestId,
                    chatId,
                    entity,
                    chunkId: options?.chunkId ?? null,
                    createdAt: options?.createdAt,
                    userId: options?.userId,
                });
                return result;
            },
            async updateStatus(entityId, patch, userId) {
                assertMutationAllowed("spindle.memories.entities.updateStatus()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_update_status",
                    requestId,
                    entityId,
                    patch,
                    userId,
                });
                return result;
            },
            async addFacts(entityId, facts, userId) {
                assertMutationAllowed("spindle.memories.entities.addFacts()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_add_facts",
                    requestId,
                    entityId,
                    facts,
                    userId,
                });
                return result;
            },
            async getFacts(entityId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_entities_get_facts", requestId, entityId, userId });
                return result;
            },
            async updateEmotionalValence(entityId, valence, userId) {
                assertMutationAllowed("spindle.memories.entities.updateEmotionalValence()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_entities_update_emotional_valence",
                    requestId,
                    entityId,
                    valence,
                    userId,
                });
                return result;
            },
        },
        relations: {
            async list(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_relations_list", requestId, chatId, userId });
                return result;
            },
            async listAll(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_relations_list_all", requestId, chatId, userId });
                return result;
            },
            async forEntity(chatId, entityId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_relations_for_entity",
                    requestId,
                    chatId,
                    entityId,
                    userId,
                });
                return result;
            },
            async forEntities(chatId, entityIds, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_relations_for_entities",
                    requestId,
                    chatId,
                    entityIds,
                    limit: options?.limit,
                    userId: options?.userId,
                });
                return result;
            },
            async upsert(chatId, relation, options) {
                assertMutationAllowed("spindle.memories.relations.upsert()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_relations_upsert",
                    requestId,
                    chatId,
                    relation,
                    chunkId: options?.chunkId ?? null,
                    userId: options?.userId,
                });
                return result;
            },
        },
        consolidations: {
            async list(chatId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_consolidations_list",
                    requestId,
                    chatId,
                    tier: options?.tier,
                    userId: options?.userId,
                });
                return result;
            },
            async latestArc(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_consolidations_latest_arc",
                    requestId,
                    chatId,
                    userId,
                });
                return result;
            },
            async run(chatId, userId) {
                assertMutationAllowed("spindle.memories.consolidations.run()");
                const requestId = crypto.randomUUID();
                await request({ type: "memories_consolidations_run", requestId, chatId, userId });
            },
        },
        salience: {
            async list(chatId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_salience_get",
                    requestId,
                    chatId,
                    limit: options?.limit,
                    offset: options?.offset,
                    userId: options?.userId,
                });
                return result;
            },
        },
        vaults: {
            async list(userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_list", requestId, userId });
                return result;
            },
            async get(vaultId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_get", requestId, vaultId, userId });
                return result;
            },
            async getChunks(vaultId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_get_chunks", requestId, vaultId, userId });
                return result;
            },
            async create(input, userId) {
                assertMutationAllowed("spindle.memories.vaults.create()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_create", requestId, input, userId });
                return result;
            },
            async rename(vaultId, name, userId) {
                assertMutationAllowed("spindle.memories.vaults.rename()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_rename", requestId, vaultId, name, userId });
                return result;
            },
            async delete(vaultId, userId) {
                assertMutationAllowed("spindle.memories.vaults.delete()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_delete", requestId, vaultId, userId });
                return result;
            },
            async reindex(vaultId, userId) {
                assertMutationAllowed("spindle.memories.vaults.reindex()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_vaults_reindex", requestId, vaultId, userId });
                return result;
            },
        },
        links: {
            async list(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_links_list", requestId, chatId, userId });
                return result;
            },
            async attach(input, userId) {
                assertMutationAllowed("spindle.memories.links.attach()");
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_links_attach", requestId, input, userId });
                return result;
            },
            async remove(chatId, linkId, userId) {
                assertMutationAllowed("spindle.memories.links.remove()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_links_remove",
                    requestId,
                    chatId,
                    linkId,
                    userId,
                });
                return result;
            },
            async toggle(chatId, linkId, enabled, userId) {
                assertMutationAllowed("spindle.memories.links.toggle()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_links_toggle",
                    requestId,
                    chatId,
                    linkId,
                    enabled,
                    userId,
                });
                return result;
            },
        },
        chatMemory: {
            async listChunks(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_chat_chunks_list", requestId, chatId, userId });
                return result;
            },
            async get(chatId, options) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_chat_memory_get",
                    requestId,
                    chatId,
                    topK: options?.topK,
                    userId: options?.userId,
                });
                return result;
            },
            async warm(chatId, options) {
                assertMutationAllowed("spindle.memories.chatMemory.warm()");
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_chat_memory_warm",
                    requestId,
                    chatId,
                    force: options?.force,
                    userId: options?.userId,
                });
                return result;
            },
            async invalidate(chatId, userId) {
                assertMutationAllowed("spindle.memories.chatMemory.invalidate()");
                const requestId = crypto.randomUUID();
                await request({ type: "memories_chat_memory_invalidate", requestId, chatId, userId });
            },
        },
        stats: {
            async usage(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({ type: "memories_stats_usage", requestId, chatId, userId });
                return result;
            },
            async ingestionStatus(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_stats_ingestion_status",
                    requestId,
                    chatId,
                    userId,
                });
                return result;
            },
            async ingestionTelemetry(chatId, userId) {
                const requestId = crypto.randomUUID();
                const result = await request({
                    type: "memories_stats_ingestion_telemetry",
                    requestId,
                    chatId,
                    userId,
                });
                return result;
            },
        },
    },
    personas: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "personas_list",
                requestId,
                limit: options?.limit,
                offset: options?.offset,
                userId: options?.userId,
            });
            return result;
        },
        async get(personaId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_get", requestId, personaId, userId });
            return result;
        },
        async getDefault(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_get_default", requestId, userId });
            return result;
        },
        async getActive(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_get_active", requestId, userId });
            return result;
        },
        async create(input, userId) {
            assertMutationAllowed("spindle.personas.create()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_create", requestId, input, userId });
            return result;
        },
        async update(personaId, input, userId) {
            assertMutationAllowed("spindle.personas.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_update", requestId, personaId, input, userId });
            return result;
        },
        async delete(personaId, userId) {
            assertMutationAllowed("spindle.personas.delete()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_delete", requestId, personaId, userId });
            return result;
        },
        async switchActive(personaId, userId) {
            assertMutationAllowed("spindle.personas.switchActive()");
            const requestId = crypto.randomUUID();
            await request({ type: "personas_switch", requestId, personaId, userId });
        },
        async getWorldBook(personaId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "personas_get_world_book", requestId, personaId, userId });
            return result;
        },
    },
    global_addons: {
        async list(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "global_addons_list", requestId, limit: options?.limit, offset: options?.offset, userId: options?.userId });
            return result;
        },
        async get(addonId, userId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "global_addons_get", requestId, addonId, userId });
            return result;
        },
        async update(addonId, input, userId) {
            assertMutationAllowed("spindle.global_addons.update()");
            const requestId = crypto.randomUUID();
            const result = await request({ type: "global_addons_update", requestId, addonId, input, userId });
            return result;
        },
    },
    council: {
        async getSettings(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "council_get_settings", requestId, userId: options?.userId });
            return result;
        },
        async getMembers(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "council_get_members", requestId, userId: options?.userId });
            return result;
        },
        async getAvailableLumiaItems(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "council_get_available_lumia_items", requestId, userId: options?.userId });
            return result;
        },
    },
    dlc: {
        async getCatalog(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "dlc_get_catalog", requestId, userId: options?.userId });
            return result;
        },
    },
    permissions: {
        async getGranted() {
            const scope = sharedRpcPermissionScope.getStore();
            if (scope)
                return [...scope.effectivePermissions];
            const requestId = crypto.randomUUID();
            const result = await request({ type: "permissions_get_granted", requestId });
            // Sync local cache with authoritative host response
            const perms = result;
            grantedPermissions.clear();
            for (const p of perms)
                grantedPermissions.add(p);
            return perms;
        },
        has(permission) {
            const scope = sharedRpcPermissionScope.getStore();
            if (scope)
                return scope.effectivePermissions.includes(permission);
            return grantedPermissions.has(permission);
        },
        onDenied(handler) {
            permissionDeniedHandlers.add(handler);
            return () => {
                permissionDeniedHandlers.delete(handler);
            };
        },
        onChanged(handler) {
            permissionChangedHandlers.add(handler);
            return () => {
                permissionChangedHandlers.delete(handler);
            };
        },
    },
    rpcPool: {
        sync(endpoint, value, policy) {
            assertMutationAllowed("spindle.rpcPool.sync()");
            const normalized = normalizeOwnedRpcPoolEndpoint(endpoint);
            post({ type: "rpc_pool_sync", endpoint: normalized, value, policy });
            return normalized;
        },
        handle(endpoint, handler, policy) {
            assertMutationAllowed("spindle.rpcPool.handle()");
            const normalized = normalizeOwnedRpcPoolEndpoint(endpoint);
            sharedRpcHandlers.set(normalized, handler);
            post({ type: "rpc_pool_register_handler", endpoint: normalized, policy });
            return normalized;
        },
        async read(endpoint) {
            const normalized = assertValidSharedRpcEndpoint(endpoint);
            const requestId = crypto.randomUUID();
            const result = await request({ type: "rpc_pool_read", requestId, endpoint: normalized });
            return result;
        },
        unregister(endpoint) {
            assertMutationAllowed("spindle.rpcPool.unregister()");
            const normalized = normalizeOwnedRpcPoolEndpoint(endpoint);
            sharedRpcHandlers.delete(normalized);
            post({ type: "rpc_pool_unregister", endpoint: normalized });
        },
    },
    push: {
        async send(input, userId) {
            assertMutationAllowed("spindle.push.send()");
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "push_send",
                requestId,
                title: input.title,
                body: input.body,
                tag: input.tag,
                url: input.url,
                icon: input.icon,
                rawTitle: input.rawTitle,
                image: input.image,
                userId,
            });
            return result;
        },
        async getStatus(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "push_get_status",
                requestId,
                userId,
            });
            return result;
        },
    },
    webSearch: {
        async query(input) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "web_search_query",
                requestId,
                query: input.query,
                count: input.count,
                scrape: input.scrape,
                userId: input.userId,
            });
            return result;
        },
        async getSettings(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "web_search_get_settings",
                requestId,
                userId,
            });
            return result;
        },
    },
    textEditor: {
        async open(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "text_editor_open",
                requestId,
                title: options?.title,
                value: options?.value,
                placeholder: options?.placeholder,
                userId: options?.userId,
            });
            return result;
        },
        async close(_editorRequestId, _userId) {
            // The current host transport only exposes user-settled editor results;
            // unknown close identities are intentionally accepted as no-ops.
        },
    },
    macros: {
        async resolve(template, options) {
            const requestId = crypto.randomUUID();
            const commit = options?.commit ?? getActiveMacroInvocation()?.commit ?? true;
            const result = await request({
                type: "macros_resolve",
                requestId,
                template,
                chatId: options?.chatId,
                characterId: options?.characterId,
                userId: options?.userId,
                commit,
            });
            return result;
        },
    },
    users: {
        async isVisible(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "user_is_visible",
                requestId,
                userId,
            });
            return result;
        },
        async getRole(userId) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "user_get_role",
                requestId,
                userId,
            });
            return result;
        },
    },
    oauth: {
        onCallback(handler) {
            oauthCallbackHandler = handler;
            return () => {
                oauthCallbackHandler = null;
            };
        },
        getCallbackUrl() {
            return `/api/spindle-oauth/${manifest.identifier}/callback`;
        },
        async createState() {
            const requestId = crypto.randomUUID();
            return request({
                type: "create_oauth_state",
                requestId,
            });
        },
    },
    async cors(url, options) {
        const requestId = crypto.randomUUID();
        return request({
            type: "cors_request",
            requestId,
            url,
            options: options || {},
        });
    },
    contracts: Object.freeze({
        preAssemblyGenerationContext: 1,
        worldInfoActivationCapture: 1,
        worldInfoRuntimePlacement: 1,
    }),
    registerContextHandler(handler, priority, opts) {
        assertMutationAllowed("spindle.registerContextHandler()");
        contextHandlerFn = handler;
        post({ type: "register_context_handler", priority, timeoutMs: opts?.timeoutMs });
    },
    registerMessageContentProcessor(handler, priority) {
        assertMutationAllowed("spindle.registerMessageContentProcessor()");
        messageContentProcessorFn = handler;
        post({ type: "register_message_content_processor", priority });
    },
    registerMacroInterceptor(handler, priority) {
        assertMutationAllowed("spindle.registerMacroInterceptor()");
        macroInterceptorFn = handler;
        post({ type: "register_macro_interceptor", priority });
    },
    registerWorldInfoInterceptor(handler, priority) {
        assertMutationAllowed("spindle.registerWorldInfoInterceptor()");
        worldInfoInterceptorFn = handler;
        post({ type: "register_world_info_interceptor", priority });
    },
    sendToFrontend(payload, userId) {
        post({ type: "frontend_message", payload, userId });
    },
    onFrontendMessage(handler) {
        frontendMessageHandlers.add(handler);
        return () => {
            frontendMessageHandlers.delete(handler);
        };
    },
    frontendProcesses: {
        async spawn(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "frontend_process_spawn",
                requestId,
                options,
            });
            return createFrontendProcessHandle(result);
        },
        async list(filter) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "frontend_process_list",
                requestId,
                filter,
            });
            return result;
        },
        async get(processId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "frontend_process_get", requestId, processId });
            return result;
        },
        send(processId, payload, userId) {
            post({ type: "frontend_process_send", processId, payload, userId });
        },
        async stop(processId, options) {
            const requestId = crypto.randomUUID();
            await request({
                type: "frontend_process_stop",
                requestId,
                processId,
                options,
            });
        },
        onLifecycle(handler) {
            frontendProcessLifecycleHandlers.add(handler);
            return () => {
                frontendProcessLifecycleHandlers.delete(handler);
            };
        },
        onMessage(handler) {
            frontendProcessMessageHandlers.add(handler);
            return () => {
                frontendProcessMessageHandlers.delete(handler);
            };
        },
    },
    backendProcesses: {
        async spawn(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "backend_process_spawn",
                requestId,
                options,
            });
            return createBackendProcessHandle(result);
        },
        async list(filter) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "backend_process_list",
                requestId,
                filter,
            });
            return result;
        },
        async get(processId) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "backend_process_get", requestId, processId });
            return result;
        },
        send(processId, payload, userId) {
            post({ type: "backend_process_send", processId, payload, userId });
        },
        async stop(processId, options) {
            const requestId = crypto.randomUUID();
            await request({
                type: "backend_process_stop",
                requestId,
                processId,
                options,
            });
        },
        onLifecycle(handler) {
            backendProcessLifecycleHandlers.add(handler);
            return () => {
                backendProcessLifecycleHandlers.delete(handler);
            };
        },
        onMessage(handler) {
            backendProcessMessageHandlers.add(handler);
            return () => {
                backendProcessMessageHandlers.delete(handler);
            };
        },
    },
    log: {
        info(msg) {
            post({ type: "log", level: "info", message: msg });
        },
        warn(msg) {
            post({ type: "log", level: "warn", message: msg });
        },
        error(msg) {
            post({ type: "log", level: "error", message: msg });
        },
    },
    promptRegex: {
        setOwnedChats(chatIds) {
            post({ type: "prompt_regex_set_owned", chatIds: chatIds.map(String) });
        },
    },
    ui: {
        async getDrawerTabs(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ui_get_drawer_tabs", requestId, userId: options?.userId });
            return result;
        },
        async getSettingsTabs(options) {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "ui_get_settings_tabs", requestId, userId: options?.userId });
            return result;
        },
        async openDrawerTab(tabId, options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "open_drawer_tab", tabId, userId: options?.userId });
        },
        async closeDrawer(options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "close_drawer", userId: options?.userId });
        },
        async openSettings(viewId, options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "open_settings", viewId, userId: options?.userId });
        },
        async closeSettings(options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "close_settings", userId: options?.userId });
        },
        async openCommandPalette(options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "open_command_palette", userId: options?.userId });
        },
        async closeCommandPalette(options) {
            const requestId = crypto.randomUUID();
            await request({ type: "ui_navigate", requestId, action: "close_command_palette", userId: options?.userId });
        },
    },
    toast: {
        success(message, options) {
            post({ type: "toast_show", toastType: "success", message, title: options?.title, duration: options?.duration, userId: options?.userId });
        },
        warning(message, options) {
            post({ type: "toast_show", toastType: "warning", message, title: options?.title, duration: options?.duration, userId: options?.userId });
        },
        error(message, options) {
            post({ type: "toast_show", toastType: "error", message, title: options?.title, duration: options?.duration, userId: options?.userId });
        },
        info(message, options) {
            post({ type: "toast_show", toastType: "info", message, title: options?.title, duration: options?.duration, userId: options?.userId });
        },
    },
    modal: {
        async open(options) {
            const requestId = crypto.randomUUID();
            const modalRequestId = options.modalRequestId ?? requestId;
            const result = await request({
                type: "modal_open",
                requestId,
                modalRequestId,
                title: options.title,
                items: options.items,
                width: options.width,
                maxHeight: options.maxHeight,
                persistent: options.persistent,
                userId: options.userId,
            });
            return { openRequestId: modalRequestId, ...result };
        },
        async close(openRequestId, userId) {
            const requestId = crypto.randomUUID();
            await request({
                type: "modal_close",
                requestId,
                openRequestId,
                userId,
            });
        },
        async confirm(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "confirm_open",
                requestId,
                title: options.title,
                message: options.message,
                variant: options.variant,
                confirmLabel: options.confirmLabel,
                cancelLabel: options.cancelLabel,
                userId: options.userId,
            });
            return result;
        },
    },
    prompt: {
        async input(options) {
            const requestId = crypto.randomUUID();
            const result = await request({
                type: "input_prompt_open",
                requestId,
                title: options.title,
                message: options.message,
                placeholder: options.placeholder,
                defaultValue: options.defaultValue,
                submitLabel: options.submitLabel,
                cancelLabel: options.cancelLabel,
                multiline: options.multiline,
                userId: options.userId,
            });
            return result;
        },
    },
    commands: {
        register(commands) {
            assertMutationAllowed("spindle.commands.register()");
            post({ type: "commands_register", commands });
        },
        unregister(commandIds) {
            assertMutationAllowed("spindle.commands.unregister()");
            post({ type: "commands_unregister", commandIds: commandIds ?? [] });
        },
        onInvoked(handler) {
            commandInvokedHandlers.add(handler);
            return () => {
                commandInvokedHandlers.delete(handler);
            };
        },
    },
    version: {
        async getBackend() {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "version_get_backend", requestId });
            return result;
        },
        async getFrontend() {
            const requestId = crypto.randomUUID();
            const result = await request({ type: "version_get_frontend", requestId });
            return result;
        },
    },
    get manifest() {
        return manifest;
    },
};
// ─── Message handler (host → worker) ─────────────────────────────────────
async function handleHostMessage(msg) {
    switch (msg.type) {
        case "init": {
            manifest = msg.manifest;
            storagePath = msg.storagePath;
            hostDescriptor = msg.host;
            // Expose the API globally
            globalThis.spindle = spindleApi;
            // Seed the permission cache so has() works immediately
            try {
                const perms = await spindleApi.permissions.getGranted();
                grantedPermissions.clear();
                for (const p of perms)
                    grantedPermissions.add(p);
            }
            catch {
                // Non-fatal — cache starts empty, host still enforces
            }
            // Initialize runtime sandbox before loading untrusted extension code.
            // This patches eval, the Function constructor, and sensitive Bun/process
            // APIs (real property overrides that take effect). It CANNOT block the
            // native `import()` operator or `node:` builtins — those resolve through
            // Bun internals that neither a global override nor a loader plugin can
            // intercept. Dangerous module access is therefore enforced upstream by
            // the static scan (detectDangerousBackendCapabilities, run before this
            // entry is loaded) and, when enabled, by the OS-level sandbox (sandbox
            // mode). The sandbox here is a cooperative speed bump, not the boundary.
            initializeSandbox();
            // Dynamically import the extension's backend entry
            try {
                const entryPath = manifest.entry_backend || "dist/backend.js";
                await import(entryPath);
            }
            catch (err) {
                post({
                    type: "log",
                    level: "error",
                    message: `Failed to load extension: ${err.message}`,
                });
            }
            // Signal that the extension has finished loading and all
            // synchronous registrations (macros, interceptors, etc.) are queued
            post({ type: "log", level: "info", message: "__worker_ready__" });
            break;
        }
        case "event": {
            if (msg.event === "__macro_invoke__") {
                const payload = (msg.payload ?? {});
                const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
                const name = typeof payload.name === "string" ? payload.name.toLowerCase() : "";
                const handler = extensionMacroHandlers.get(name);
                if (!requestId)
                    break;
                if (!handler) {
                    post({
                        type: "macro_result",
                        requestId,
                        result: "",
                    });
                    break;
                }
                try {
                    macroInvocationStack.push({ commit: payload.context?.commit !== false });
                    const value = await Promise.resolve(handler(payload.context ?? {}));
                    post({
                        type: "macro_result",
                        requestId,
                        result: value == null ? "" : String(value),
                    });
                }
                catch (err) {
                    post({
                        type: "macro_result",
                        requestId,
                        error: err?.message || "Macro execution failed",
                    });
                }
                finally {
                    macroInvocationStack.pop();
                }
                break;
            }
            const handlers = eventHandlers.get(msg.event);
            if (handlers) {
                for (const handler of handlers) {
                    try {
                        handler(msg.payload, msg.userId);
                    }
                    catch (err) {
                        post({
                            type: "log",
                            level: "error",
                            message: `Event handler error for ${msg.event}: ${err.message}`,
                        });
                    }
                }
            }
            break;
        }
        case "intercept_request": {
            if (interceptHandler && interceptRegistrationId === msg.registrationId) {
                const abortController = new AbortController();
                interceptorAbortControllers.set(msg.requestId, abortController);
                try {
                    const result = await interceptHandler(msg.messages, {
                        ...msg.context,
                        signal: abortController.signal,
                    });
                    // Normalize: handler may return LlmMessageDTO[] or { messages, parameters? }
                    const normalized = Array.isArray(result)
                        ? { messages: result }
                        : result;
                    post({
                        type: "intercept_result",
                        requestId: msg.requestId,
                        registrationId: msg.registrationId,
                        messages: normalized.messages,
                        ...(normalized.parameters ? { parameters: normalized.parameters } : {}),
                        ...(normalized.breakdown ? { breakdown: normalized.breakdown } : {}),
                        ...(normalized.deferredGuidance ? { deferredGuidance: normalized.deferredGuidance } : {}),
                        ...(normalized.finalResponse ? { finalResponse: normalized.finalResponse } : {}),
                    });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Interceptor error: ${err.message}`,
                    });
                    // Return original messages on error
                    post({
                        type: "intercept_result",
                        requestId: msg.requestId,
                        registrationId: msg.registrationId,
                        messages: msg.messages,
                    });
                }
                finally {
                    interceptorAbortControllers.delete(msg.requestId);
                }
            }
            break;
        }
        case "intercept_abort": {
            if (interceptRegistrationId === msg.registrationId) {
                interceptorAbortControllers.get(msg.requestId)?.abort(msg.reason);
            }
            break;
        }
        case "tool_invocation": {
            const handlers = eventHandlers.get("TOOL_INVOCATION");
            if (!handlers || handlers.size === 0) {
                post({
                    type: "tool_invocation_result",
                    requestId: msg.requestId,
                    error: "No TOOL_INVOCATION handler registered",
                });
                break;
            }
            try {
                const payload = {
                    toolName: msg.toolName,
                    args: msg.args,
                    requestId: msg.requestId,
                    ...(msg.councilMember ? { councilMember: msg.councilMember } : {}),
                    ...(msg.contextMessages ? { contextMessages: msg.contextMessages } : {}),
                };
                let result;
                for (const handler of handlers) {
                    const val = await Promise.resolve(handler(payload));
                    if (val !== undefined && val !== null && result === undefined) {
                        result = String(val);
                    }
                }
                post({
                    type: "tool_invocation_result",
                    requestId: msg.requestId,
                    result: result ?? "",
                });
            }
            catch (err) {
                post({
                    type: "tool_invocation_result",
                    requestId: msg.requestId,
                    error: err?.message || "Tool invocation failed",
                });
            }
            break;
        }
        case "context_handler_request": {
            if (contextHandlerFn) {
                try {
                    const result = await contextHandlerFn(msg.context);
                    post({
                        type: "context_handler_result",
                        requestId: msg.requestId,
                        context: result,
                    });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Context handler error: ${err.message}`,
                    });
                    post({
                        type: "context_handler_result",
                        requestId: msg.requestId,
                        context: msg.context,
                    });
                }
            }
            else {
                post({
                    type: "context_handler_result",
                    requestId: msg.requestId,
                    context: msg.context,
                });
            }
            break;
        }
        case "message_content_processor_request": {
            if (messageContentProcessorFn) {
                try {
                    const result = await messageContentProcessorFn(msg.ctx);
                    post({
                        type: "message_content_processor_result",
                        requestId: msg.requestId,
                        result,
                    });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Message content processor error: ${err.message}`,
                    });
                    post({
                        type: "message_content_processor_result",
                        requestId: msg.requestId,
                        result: undefined,
                    });
                }
            }
            break;
        }
        case "macro_interceptor_request": {
            if (macroInterceptorFn) {
                try {
                    const result = await macroInterceptorFn(msg.ctx);
                    post({
                        type: "macro_interceptor_result",
                        requestId: msg.requestId,
                        result,
                    });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Macro interceptor error: ${err.message}`,
                    });
                    post({
                        type: "macro_interceptor_result",
                        requestId: msg.requestId,
                        result: undefined,
                    });
                }
            }
            break;
        }
        case "world_info_interceptor_request": {
            if (worldInfoInterceptorFn) {
                try {
                    const result = await worldInfoInterceptorFn(msg.ctx);
                    post({
                        type: "world_info_interceptor_result",
                        requestId: msg.requestId,
                        result,
                    });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `World-info interceptor error: ${err.message}`,
                    });
                    post({
                        type: "world_info_interceptor_result",
                        requestId: msg.requestId,
                        result: undefined,
                    });
                }
            }
            break;
        }
        case "generation_stream_chunk": {
            const stream = streamingGenerations.get(msg.requestId);
            if (stream)
                stream.push(msg.chunk);
            break;
        }
        case "generation_stream_error": {
            const stream = streamingGenerations.get(msg.requestId);
            if (stream) {
                if (msg.error.startsWith("AbortError:")) {
                    stream.fail(makeAbortError(msg.error.slice("AbortError:".length).trim()));
                }
                else {
                    stream.fail(new Error(msg.error));
                }
            }
            break;
        }
        case "image_gen_stream_chunk": {
            streamingImageGenerations.get(msg.requestId)?.push(msg.event);
            break;
        }
        case "image_gen_stream_error": {
            const stream = streamingImageGenerations.get(msg.requestId);
            if (stream) {
                stream.fail(msg.error.startsWith("AbortError:")
                    ? makeAbortError(msg.error.slice("AbortError:".length).trim())
                    : new Error(msg.error));
            }
            break;
        }
        case "response": {
            const pending = pendingResponses.get(msg.requestId);
            if (pending) {
                pendingResponses.delete(msg.requestId);
                if (msg.error) {
                    // Convert host-side abort errors back into a real DOMException so
                    // extensions can do `err.name === "AbortError"` the usual way.
                    const responseError = msg.error;
                    if (typeof responseError === "string" && responseError.startsWith("AbortError:")) {
                        pending.reject(makeAbortError(responseError.slice("AbortError:".length).trim()));
                    }
                    else {
                        pending.reject(deserializeWorkerResponseError(responseError));
                    }
                }
                else {
                    pending.resolve(msg.result);
                }
            }
            break;
        }
        case "permission_denied": {
            for (const handler of permissionDeniedHandlers) {
                try {
                    handler({ permission: msg.permission, operation: msg.operation });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Permission denied handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "permission_changed": {
            // Update local cache
            if (msg.granted) {
                grantedPermissions.add(msg.permission);
            }
            else {
                grantedPermissions.delete(msg.permission);
            }
            // Sync full set from host (authoritative)
            grantedPermissions.clear();
            for (const p of msg.allGranted)
                grantedPermissions.add(p);
            const detail = {
                extensionId: ("extensionId" in msg ? msg.extensionId : undefined) ?? manifest.identifier,
                permission: msg.permission,
                granted: msg.granted,
                allGranted: msg.allGranted,
            };
            for (const handler of permissionChangedHandlers) {
                try {
                    handler(detail);
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Permission changed handler error: ${err.message}`,
                    });
                }
            }
            // Also fire as an event for extensions using spindle.on()
            const eventSet = eventHandlers.get("PERMISSION_CHANGED");
            if (eventSet) {
                for (const handler of eventSet) {
                    try {
                        handler(detail);
                    }
                    catch (err) {
                        post({
                            type: "log",
                            level: "error",
                            message: `PERMISSION_CHANGED event handler error: ${err.message}`,
                        });
                    }
                }
            }
            break;
        }
        case "rpc_pool_request": {
            const handler = sharedRpcHandlers.get(msg.endpoint);
            if (!handler) {
                post({
                    type: "rpc_pool_handler_result",
                    requestId: msg.requestId,
                    error: `Shared RPC endpoint \"${msg.endpoint}\" is not registered for on-request reads`,
                });
                break;
            }
            const scope = {
                id: msg.rpcPermissionScopeId,
                effectivePermissions: Array.isArray(msg.effectivePermissions)
                    ? msg.effectivePermissions
                    : [],
            };
            sharedRpcPermissionScope.run(scope, () => {
                Promise.resolve(handler({
                    endpoint: msg.endpoint,
                    requesterExtensionId: msg.requesterExtensionId,
                    effectivePermissions: scope.effectivePermissions,
                })).then((result) => {
                    post({ type: "rpc_pool_handler_result", requestId: msg.requestId, result });
                }, (err) => {
                    post({
                        type: "rpc_pool_handler_result",
                        requestId: msg.requestId,
                        error: err?.message || String(err),
                    });
                });
            });
            break;
        }
        case "frontend_message": {
            // Built-in CORS proxy bridge for sandboxed widgets
            if (typeof msg.payload === "object" &&
                msg.payload !== null &&
                msg.payload.type === "__cors_proxy_request") {
                const p = msg.payload;
                spindleApi.cors(p.url, { ...(p.options || {}), responseType: "arraybuffer" }).then((result) => {
                    spindleApi.sendToFrontend({
                        type: "__cors_proxy_response",
                        requestId: p.requestId,
                        result,
                    }, msg.userId);
                }, (err) => {
                    spindleApi.sendToFrontend({
                        type: "__cors_proxy_response",
                        requestId: p.requestId,
                        error: err?.message || "CORS proxy request failed",
                    }, msg.userId);
                });
                break;
            }
            for (const handler of frontendMessageHandlers) {
                try {
                    handler(msg.payload, msg.userId);
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Frontend message handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "frontend_process_lifecycle": {
            for (const handler of frontendProcessLifecycleHandlers) {
                try {
                    handler(msg.event);
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Frontend process lifecycle handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "frontend_process_message": {
            for (const handler of frontendProcessMessageHandlers) {
                try {
                    handler({ processId: msg.processId, payload: msg.payload, userId: msg.userId });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Frontend process message handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "backend_process_lifecycle": {
            for (const handler of backendProcessLifecycleHandlers) {
                try {
                    handler(msg.event);
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Backend process lifecycle handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "backend_process_message": {
            for (const handler of backendProcessMessageHandlers) {
                try {
                    handler({ processId: msg.processId, payload: msg.payload, userId: msg.userId });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Backend process message handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "oauth_callback": {
            if (oauthCallbackHandler) {
                try {
                    const result = await oauthCallbackHandler(msg.params);
                    post({
                        type: "oauth_callback_result",
                        requestId: msg.requestId,
                        html: result?.html,
                    });
                }
                catch (err) {
                    post({
                        type: "oauth_callback_result",
                        requestId: msg.requestId,
                        error: err?.message || "OAuth callback handler failed",
                    });
                }
            }
            else {
                post({
                    type: "oauth_callback_result",
                    requestId: msg.requestId,
                    error: "No OAuth callback handler registered",
                });
            }
            break;
        }
        case "command_invoked": {
            for (const handler of commandInvokedHandlers) {
                try {
                    handler(msg.commandId, msg.context);
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Command handler error (${msg.commandId}): ${err?.message ?? err}`,
                    });
                }
            }
            break;
        }
        case "provider_invoke": {
            const handlerKey = `${msg.key.kind}\0${msg.key.id}`;
            const handler = providerHandlers.get(handlerKey);
            const abortController = new AbortController();
            providerAbortControllers.set(msg.correlationId, abortController);
            if (!handler) {
                post({
                    type: "provider_result",
                    phase: "result",
                    correlationId: msg.correlationId,
                    round: msg.round,
                    error: `No provider handler registered for ${msg.key.kind}/${msg.key.id}`,
                });
                providerAbortControllers.delete(msg.correlationId);
                break;
            }
            try {
                const result = await Promise.resolve(handler({
                    correlationId: msg.correlationId,
                    round: msg.round,
                    key: msg.key,
                    request: msg.request,
                    signal: abortController.signal,
                }));
                if (abortController.signal.aborted)
                    break;
                post({
                    type: "provider_result",
                    phase: "result",
                    correlationId: msg.correlationId,
                    round: msg.round,
                    result,
                });
            }
            catch (err) {
                if (abortController.signal.aborted)
                    break;
                post({
                    type: "provider_result",
                    phase: "result",
                    correlationId: msg.correlationId,
                    round: msg.round,
                    error: err?.message || "Provider invocation failed",
                });
            }
            finally {
                providerAbortControllers.delete(msg.correlationId);
            }
            break;
        }
        case "provider_abort": {
            providerAbortControllers.get(msg.correlationId)?.abort(msg.reason);
            providerAbortControllers.delete(msg.correlationId);
            break;
        }
        case "provider_changed": {
            for (const handler of providerChangedHandlers) {
                try {
                    handler({ action: msg.action, key: msg.key });
                }
                catch (err) {
                    post({
                        type: "log",
                        level: "error",
                        message: `Provider changed handler error: ${err.message}`,
                    });
                }
            }
            break;
        }
        case "shutdown": {
            // Signal the host so it doesn't have to wait for the 5s fallback
            // timeout in WorkerHost.stop(). Posting via the existing log channel
            // matches the __worker_ready__ pattern and avoids touching the
            // shared WorkerToHost union type.
            try {
                post({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
            }
            catch {
                // If posting fails, the host's 5s fallback terminates us anyway.
            }
            // Allow extension to clean up
            nativeProcessExit(0);
            break;
        }
    }
}
if (typeof process.send === "function") {
    process.on("message", (message) => {
        void handleHostMessage(message);
    });
}
else {
    self.onmessage = (event) => {
        void handleHostMessage(event.data);
    };
}
