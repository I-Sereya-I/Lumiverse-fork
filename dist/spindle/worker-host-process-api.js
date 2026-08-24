import * as managerSvc from "./manager.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { createRuntimeTransport } from "./runtime-transport";
import { join, resolve, sep } from "path";
const MAX_BACKEND_PROCESSES = 16;
/** Owns all managed frontend/backend process records, timers, and runtime handles. */
export class WorkerHostProcessApi {
    context;
    frontendProcesses = new Map();
    frontendProcessKeyIndex = new Map();
    backendProcesses = new Map();
    backendProcessKeyIndex = new Map();
    constructor(context) {
        this.context = context;
    }
    get extensionId() { return this.context.extensionId; }
    get manifest() { return this.context.manifest; }
    get installScope() { return this.context.installScope; }
    get installedByUserId() { return this.context.installedByUserId; }
    postToWorker(message) { this.context.post(message); }
    resolveRequest(requestId, result) { this.context.resolve(requestId, result); }
    rejectRequest(requestId, error) { this.context.reject(requestId, error); }
    getStorageRootPath(_identifier) { return this.context.storageRootPath(); }
    sendFrontendProcessEvent(userId, payload) {
        eventBus.emit(EventType.SPINDLE_FRONTEND_PROCESS, { extensionId: this.extensionId, identifier: this.manifest.identifier, ...payload }, userId);
    }
    resolveFrontendProcessUserId(userId) {
        if (this.installScope === "user") {
            if (!this.installedByUserId) {
                throw new Error("Extension owner is not set");
            }
            return this.installedByUserId;
        }
        if (typeof userId !== "string" || !userId.trim()) {
            throw new Error("userId is required when spawning a managed process");
        }
        return userId.trim();
    }
    buildFrontendProcessKey(userId, kind, key) {
        return `${userId}:${kind}:${key}`;
    }
    snapshotFrontendProcess(record) {
        return {
            processId: record.processId,
            kind: record.kind,
            ...(record.key ? { key: record.key } : {}),
            state: record.state,
            ...(record.userId ? { userId: record.userId } : {}),
            ...(record.metadata ? { metadata: record.metadata } : {}),
            startedAt: record.startedAt,
            ...(record.readyAt ? { readyAt: record.readyAt } : {}),
            ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
            ...(record.endedAt ? { endedAt: record.endedAt } : {}),
            ...(record.exitReason ? { exitReason: record.exitReason } : {}),
            ...(record.error ? { error: record.error } : {}),
        };
    }
    clearFrontendProcessTimers(record) {
        if (record.startupTimer) {
            clearTimeout(record.startupTimer);
            record.startupTimer = null;
        }
        if (record.heartbeatTimer) {
            clearTimeout(record.heartbeatTimer);
            record.heartbeatTimer = null;
        }
    }
    emitFrontendProcessLifecycle(record, previousState) {
        this.postToWorker({
            type: "frontend_process_lifecycle",
            event: {
                processId: record.processId,
                kind: record.kind,
                ...(record.key ? { key: record.key } : {}),
                ...(record.userId ? { userId: record.userId } : {}),
                state: record.state,
                ...(previousState ? { previousState } : {}),
                at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
                ...(record.exitReason ? { exitReason: record.exitReason } : {}),
                ...(record.error ? { error: record.error } : {}),
                ...(record.metadata ? { metadata: record.metadata } : {}),
            },
        });
    }
    armFrontendHeartbeatTimer(record) {
        if (record.heartbeatTimeoutMs <= 0)
            return;
        if (record.heartbeatTimer)
            clearTimeout(record.heartbeatTimer);
        record.heartbeatTimer = setTimeout(() => {
            const latest = this.frontendProcesses.get(record.processId);
            if (!latest)
                return;
            this.requestFrontendProcessStop(latest, "timed_out");
            this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process heartbeat timed out");
        }, record.heartbeatTimeoutMs);
    }
    requestFrontendProcessStop(record, reason) {
        eventBus.emit(EventType.SPINDLE_FRONTEND_PROCESS, {
            extensionId: this.extensionId,
            identifier: this.manifest.identifier,
            action: "stop",
            processId: record.processId,
            ...(reason ? { reason } : {}),
        }, record.userId);
    }
    transitionFrontendProcess(record, nextState, extras) {
        if (record.state === nextState && !extras)
            return;
        const previousState = record.state;
        record.state = nextState;
        if (extras?.readyAt)
            record.readyAt = extras.readyAt;
        if (extras?.lastHeartbeatAt)
            record.lastHeartbeatAt = extras.lastHeartbeatAt;
        if (extras?.endedAt)
            record.endedAt = extras.endedAt;
        if (extras?.exitReason)
            record.exitReason = extras.exitReason;
        if (extras && "error" in extras) {
            record.error = extras.error;
        }
        this.emitFrontendProcessLifecycle(record, previousState);
    }
    finalizeFrontendProcess(record, state, exitReason, error) {
        this.clearFrontendProcessTimers(record);
        this.transitionFrontendProcess(record, state, {
            endedAt: new Date().toISOString(),
            exitReason,
            ...(error ? { error } : { error: undefined }),
        });
        this.frontendProcesses.delete(record.processId);
        if (record.key) {
            this.frontendProcessKeyIndex.delete(this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key));
        }
    }
    getFrontendProcessRecord(processId) {
        return this.frontendProcesses.get(processId) ?? null;
    }
    getFrontendProcessForUser(processId, userId) {
        const record = this.frontendProcesses.get(processId);
        if (!record)
            return null;
        if (record.userId && record.userId !== userId)
            return null;
        return record;
    }
    stopAllFrontendProcesses(exitReason) {
        for (const record of Array.from(this.frontendProcesses.values())) {
            this.requestFrontendProcessStop(record, exitReason);
            this.clearFrontendProcessTimers(record);
            this.frontendProcesses.delete(record.processId);
            if (record.key) {
                this.frontendProcessKeyIndex.delete(this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key));
            }
        }
    }
    getBackendProcessRuntimeMode() {
        const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_MODE?.trim().toLowerCase();
        return raw === "sandbox" ? "sandbox" : "process";
    }
    buildBackendProcessKey(userId, kind, key) {
        return `${userId}:${kind}:${key}`;
    }
    snapshotBackendProcess(record) {
        return {
            processId: record.processId,
            entry: record.entry,
            kind: record.kind,
            ...(record.key ? { key: record.key } : {}),
            state: record.state,
            ...(record.userId ? { userId: record.userId } : {}),
            ...(record.metadata ? { metadata: record.metadata } : {}),
            startedAt: record.startedAt,
            ...(record.readyAt ? { readyAt: record.readyAt } : {}),
            ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
            ...(record.endedAt ? { endedAt: record.endedAt } : {}),
            ...(record.exitReason ? { exitReason: record.exitReason } : {}),
            ...(record.error ? { error: record.error } : {}),
        };
    }
    clearBackendProcessTimers(record) {
        if (record.startupTimer) {
            clearTimeout(record.startupTimer);
            record.startupTimer = null;
        }
        if (record.heartbeatTimer) {
            clearTimeout(record.heartbeatTimer);
            record.heartbeatTimer = null;
        }
        if (record.stopTimer) {
            clearTimeout(record.stopTimer);
            record.stopTimer = null;
        }
    }
    emitBackendProcessLifecycle(record, previousState) {
        this.postToWorker({
            type: "backend_process_lifecycle",
            event: {
                processId: record.processId,
                entry: record.entry,
                kind: record.kind,
                ...(record.key ? { key: record.key } : {}),
                ...(record.userId ? { userId: record.userId } : {}),
                state: record.state,
                ...(previousState ? { previousState } : {}),
                at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
                ...(record.exitReason ? { exitReason: record.exitReason } : {}),
                ...(record.error ? { error: record.error } : {}),
                ...(record.metadata ? { metadata: record.metadata } : {}),
            },
        });
    }
    armBackendHeartbeatTimer(record) {
        if (record.heartbeatTimeoutMs <= 0)
            return;
        if (record.heartbeatTimer)
            clearTimeout(record.heartbeatTimer);
        record.heartbeatTimer = setTimeout(() => {
            const latest = this.backendProcesses.get(record.processId);
            if (!latest)
                return;
            try {
                latest.runtime.terminate(true);
            }
            catch {
                // ignore
            }
            this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process heartbeat timed out");
        }, record.heartbeatTimeoutMs);
    }
    armBackendStopTimer(record) {
        if (record.stopTimer)
            clearTimeout(record.stopTimer);
        record.stopTimer = setTimeout(() => {
            const latest = this.backendProcesses.get(record.processId);
            if (!latest)
                return;
            try {
                latest.runtime.terminate(true);
            }
            catch {
                // ignore
            }
            this.finalizeBackendProcess(latest, "stopped", "stopped", "Backend process force-stopped after stop timeout");
        }, 5_000);
    }
    transitionBackendProcess(record, nextState, extras) {
        if (record.state === nextState && !extras)
            return;
        const previousState = record.state;
        record.state = nextState;
        if (extras?.readyAt)
            record.readyAt = extras.readyAt;
        if (extras?.lastHeartbeatAt)
            record.lastHeartbeatAt = extras.lastHeartbeatAt;
        if (extras?.endedAt)
            record.endedAt = extras.endedAt;
        if (extras?.exitReason)
            record.exitReason = extras.exitReason;
        if (extras && "error" in extras) {
            record.error = extras.error;
        }
        this.emitBackendProcessLifecycle(record, previousState);
    }
    finalizeBackendProcess(record, state, exitReason, error) {
        this.clearBackendProcessTimers(record);
        this.transitionBackendProcess(record, state, {
            endedAt: new Date().toISOString(),
            exitReason,
            ...(error ? { error } : { error: undefined }),
        });
        this.backendProcesses.delete(record.processId);
        if (record.key) {
            this.backendProcessKeyIndex.delete(this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key));
        }
    }
    getBackendProcessRecord(processId) {
        return this.backendProcesses.get(processId) ?? null;
    }
    async resolveBackendProcessEntryPath(entry) {
        const normalized = typeof entry === "string" ? entry.trim().replace(/\\/g, "/") : "";
        if (!normalized)
            throw new Error("entry is required");
        if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
            throw new Error("entry must be a relative path inside the extension repo");
        }
        if (!normalized.startsWith("dist/")) {
            throw new Error("backend process entries must live under dist/");
        }
        if (!/\.(?:cjs|mjs|js)$/.test(normalized)) {
            throw new Error("backend process entry must be a built JavaScript file");
        }
        const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
        const repoAbs = resolve(repoPath);
        const entryPath = resolve(repoAbs, normalized);
        const insideRepo = entryPath === repoAbs || entryPath.startsWith(`${repoAbs}${sep}`);
        if (!insideRepo) {
            throw new Error(`Path traversal detected in backend process entry: ${entry}`);
        }
        if (!(await Bun.file(entryPath).exists())) {
            throw new Error(`Backend process entry not found: ${normalized}`);
        }
        const blocked = managerSvc.detectDangerousBackendCapabilities(await Bun.file(entryPath).text(), managerSvc.declaredCapabilitiesFromManifest(this.manifest));
        if (blocked.length > 0) {
            throw new Error(`Backend process entry \"${normalized}\" uses blocked backend capabilities: ${blocked.join(", ")}`);
        }
        return entryPath;
    }
    handleBackendProcessRuntimeMessage(processId, message) {
        const record = this.backendProcesses.get(processId);
        if (!record)
            return;
        switch (message.type) {
            case "ready": {
                if (record.state !== "starting")
                    return;
                if (record.startupTimer) {
                    clearTimeout(record.startupTimer);
                    record.startupTimer = null;
                }
                const now = new Date().toISOString();
                this.transitionBackendProcess(record, "running", {
                    readyAt: now,
                    lastHeartbeatAt: now,
                });
                this.armBackendHeartbeatTimer(record);
                this.postToWorker({
                    type: "response",
                    requestId: record.requestId,
                    result: this.snapshotBackendProcess(record),
                });
                return;
            }
            case "heartbeat": {
                if (record.state !== "running")
                    return;
                const now = new Date().toISOString();
                this.transitionBackendProcess(record, "running", { lastHeartbeatAt: now });
                this.armBackendHeartbeatTimer(record);
                return;
            }
            case "message": {
                this.postToWorker({
                    type: "backend_process_message",
                    processId: record.processId,
                    payload: message.payload,
                    userId: record.userId ?? "",
                });
                return;
            }
            case "complete": {
                if (record.state === "starting") {
                    this.rejectRequest(record.requestId, new Error("Backend process completed before it became ready"));
                }
                this.finalizeBackendProcess(record, "completed", "completed");
                return;
            }
            case "fail": {
                const error = message.error?.trim() || "Backend process failed";
                if (record.state === "starting") {
                    this.rejectRequest(record.requestId, new Error(error));
                }
                this.finalizeBackendProcess(record, "failed", "failed", error);
                return;
            }
            case "stopped": {
                if (record.state === "starting") {
                    this.rejectRequest(record.requestId, new Error("Backend process stopped before it became ready"));
                }
                this.finalizeBackendProcess(record, "stopped", "stopped");
                return;
            }
        }
    }
    handleBackendProcessRuntimeExit(processId, exitCode, signalCode, error) {
        const record = this.backendProcesses.get(processId);
        if (!record)
            return;
        const details = error?.message || `Backend process exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
        if (record.state === "starting") {
            this.rejectRequest(record.requestId, new Error(details));
            this.finalizeBackendProcess(record, "failed", "failed", details);
            return;
        }
        if (record.state === "stopping") {
            this.finalizeBackendProcess(record, "stopped", "stopped");
            return;
        }
        this.finalizeBackendProcess(record, "failed", "failed", details);
    }
    stopAllBackendProcesses(exitReason) {
        for (const record of Array.from(this.backendProcesses.values())) {
            this.clearBackendProcessTimers(record);
            try {
                record.runtime.terminate(true);
            }
            catch {
                // ignore
            }
            this.transitionBackendProcess(record, "stopped", {
                endedAt: new Date().toISOString(),
                exitReason,
            });
            this.backendProcesses.delete(record.processId);
            if (record.key) {
                this.backendProcessKeyIndex.delete(this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key));
            }
        }
    }
    handleFrontendProcessEvent(processId, userId, event, error) {
        const record = this.getFrontendProcessForUser(processId, userId);
        if (!record)
            return;
        switch (event) {
            case "ready": {
                if (record.state !== "starting")
                    return;
                const now = new Date().toISOString();
                if (record.startupTimer) {
                    clearTimeout(record.startupTimer);
                    record.startupTimer = null;
                }
                this.transitionFrontendProcess(record, "running", {
                    readyAt: now,
                    lastHeartbeatAt: now,
                    error: undefined,
                });
                this.armFrontendHeartbeatTimer(record);
                this.resolveRequest(record.requestId, this.snapshotFrontendProcess(record));
                break;
            }
            case "heartbeat": {
                if (record.state !== "running" && record.state !== "stopping")
                    return;
                const now = new Date().toISOString();
                record.lastHeartbeatAt = now;
                this.armFrontendHeartbeatTimer(record);
                break;
            }
            case "complete": {
                if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
                    return;
                }
                this.finalizeFrontendProcess(record, record.state === "stopping" ? "stopped" : "completed", record.state === "stopping" ? "stopped" : "completed");
                break;
            }
            case "fail": {
                if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
                    return;
                }
                const message = error?.trim() || "Frontend process failed";
                if (record.state === "starting") {
                    this.clearFrontendProcessTimers(record);
                    this.finalizeFrontendProcess(record, "failed", "failed", message);
                    this.rejectRequest(processId, new Error(message));
                }
                else {
                    this.finalizeFrontendProcess(record, "failed", "failed", message);
                }
                break;
            }
            case "frontend_unloaded": {
                if (record.state === "starting") {
                    const message = "Frontend extension unloaded before the process became ready";
                    this.clearFrontendProcessTimers(record);
                    this.finalizeFrontendProcess(record, "failed", "frontend_unloaded", message);
                    this.rejectRequest(processId, new Error(message));
                    return;
                }
                this.finalizeFrontendProcess(record, "stopped", "frontend_unloaded", error);
                break;
            }
        }
    }
    handleFrontendProcessMessage(processId, userId, payload) {
        const record = this.getFrontendProcessForUser(processId, userId);
        if (!record)
            return;
        this.postToWorker({ type: "frontend_process_message", processId, payload, userId });
    }
    handleFrontendProcessSpawn(requestId, options) {
        try {
            const kind = typeof options?.kind === "string" ? options.kind.trim() : "";
            if (!kind)
                throw new Error("kind is required");
            const userId = this.resolveFrontendProcessUserId(options?.userId);
            const processId = crypto.randomUUID();
            const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
            const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
            const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));
            if (key) {
                const dedupeKey = this.buildFrontendProcessKey(userId, kind, key);
                const existingId = this.frontendProcessKeyIndex.get(dedupeKey);
                if (existingId) {
                    const existing = this.frontendProcesses.get(existingId);
                    if (existing) {
                        if (!options?.replaceExisting) {
                            throw new Error(`Frontend process already exists for kind \"${kind}\" and key \"${key}\"`);
                        }
                        this.requestFrontendProcessStop(existing, "replaced");
                        if (existing.state === "starting") {
                            this.rejectRequest(existing.requestId, new Error("Frontend process was replaced before it became ready"));
                        }
                        this.finalizeFrontendProcess(existing, "stopped", "replaced");
                    }
                }
            }
            const record = {
                requestId,
                processId,
                kind,
                ...(key ? { key } : {}),
                state: "starting",
                userId,
                ...(options?.metadata ? { metadata: options.metadata } : {}),
                startedAt: new Date().toISOString(),
                startupTimer: null,
                heartbeatTimer: null,
                startupTimeoutMs,
                heartbeatTimeoutMs,
            };
            this.frontendProcesses.set(processId, record);
            if (key) {
                this.frontendProcessKeyIndex.set(this.buildFrontendProcessKey(userId, kind, key), processId);
            }
            this.emitFrontendProcessLifecycle(record);
            record.startupTimer = setTimeout(() => {
                const latest = this.frontendProcesses.get(processId);
                if (!latest || latest.state !== "starting")
                    return;
                this.requestFrontendProcessStop(latest, "timed_out");
                this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process startup timed out");
                this.rejectRequest(requestId, new Error("Frontend process startup timed out"));
            }, startupTimeoutMs);
            this.sendFrontendProcessEvent(userId, {
                action: "spawn",
                processId,
                kind,
                ...(key ? { key } : {}),
                payload: options?.payload,
                ...(options?.metadata ? { metadata: options.metadata } : {}),
            });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleFrontendProcessList(requestId, filter) {
        try {
            const userId = this.installScope === "user"
                ? this.installedByUserId ?? undefined
                : typeof filter?.userId === "string" && filter.userId.trim()
                    ? filter.userId.trim()
                    : undefined;
            const items = Array.from(this.frontendProcesses.values())
                .filter((record) => {
                if (userId && record.userId !== userId)
                    return false;
                if (filter?.kind && record.kind !== filter.kind)
                    return false;
                if (filter?.key && record.key !== filter.key)
                    return false;
                if (filter?.state && record.state !== filter.state)
                    return false;
                return true;
            })
                .map((record) => this.snapshotFrontendProcess(record));
            this.postToWorker({ type: "response", requestId, result: items });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleFrontendProcessGet(requestId, processId) {
        try {
            const record = this.getFrontendProcessRecord(processId);
            this.postToWorker({
                type: "response",
                requestId,
                result: record ? this.snapshotFrontendProcess(record) : null,
            });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleFrontendProcessStop(requestId, processId, options) {
        try {
            const record = this.getFrontendProcessRecord(processId);
            if (!record) {
                this.postToWorker({ type: "response", requestId, result: undefined });
                return;
            }
            const resolvedUserId = this.installScope === "user"
                ? this.installedByUserId ?? undefined
                : typeof options?.userId === "string" && options.userId.trim()
                    ? options.userId.trim()
                    : undefined;
            if (resolvedUserId && record.userId !== resolvedUserId) {
                throw new Error("processId does not belong to the requested userId");
            }
            if (record.state === "starting" || record.state === "running") {
                record.stopReason = options?.reason;
                if (record.startupTimer) {
                    clearTimeout(record.startupTimer);
                    record.startupTimer = null;
                }
                this.transitionFrontendProcess(record, "stopping");
            }
            this.requestFrontendProcessStop(record, options?.reason ?? "stopped");
            this.postToWorker({ type: "response", requestId, result: undefined });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleFrontendProcessSend(processId, payload, userId) {
        const record = this.getFrontendProcessRecord(processId);
        if (!record)
            return;
        if (this.installScope === "operator" && userId && record.userId !== userId)
            return;
        this.sendFrontendProcessEvent(record.userId ?? this.resolveFrontendProcessUserId(userId), {
            action: "message",
            processId,
            payload,
        });
    }
    async handleBackendProcessSpawn(requestId, options) {
        try {
            const entryPath = await this.resolveBackendProcessEntryPath(options?.entry ?? "");
            const entry = typeof options?.entry === "string" ? options.entry.trim().replace(/\\/g, "/") : "";
            const kind = typeof options?.kind === "string" && options.kind.trim() ? options.kind.trim() : entry;
            const userId = this.resolveFrontendProcessUserId(options?.userId);
            const processId = crypto.randomUUID();
            const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
            const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
            const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));
            if (key) {
                const dedupeKey = this.buildBackendProcessKey(userId, kind, key);
                const existingId = this.backendProcessKeyIndex.get(dedupeKey);
                if (existingId) {
                    const existing = this.backendProcesses.get(existingId);
                    if (existing) {
                        if (!options?.replaceExisting) {
                            throw new Error(`Backend process already exists for kind \"${kind}\" and key \"${key}\"`);
                        }
                        if (existing.state === "starting") {
                            this.rejectRequest(existing.requestId, new Error("Backend process was replaced before it became ready"));
                        }
                        this.clearBackendProcessTimers(existing);
                        try {
                            existing.runtime.terminate(true);
                        }
                        catch {
                            // ignore
                        }
                        this.finalizeBackendProcess(existing, "stopped", "replaced");
                    }
                }
            }
            if (this.backendProcesses.size >= MAX_BACKEND_PROCESSES) {
                throw new Error(`Backend process limit reached (${MAX_BACKEND_PROCESSES})`);
            }
            const runtimePath = join(import.meta.dir, "backend-process-runtime.ts");
            const storagePath = this.getStorageRootPath(this.manifest.identifier);
            const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
            const runtime = createRuntimeTransport({
                runtimePath,
                extensionIdentifier: this.manifest.identifier,
                repoPath,
                storagePath,
                mode: this.getBackendProcessRuntimeMode(),
                onMessage: (message) => {
                    this.handleBackendProcessRuntimeMessage(processId, message);
                },
                onError: (message) => {
                    const record = this.backendProcesses.get(processId);
                    if (!record)
                        return;
                    this.finalizeBackendProcess(record, "failed", "failed", message);
                },
                onExit: (exitCode, signalCode, error) => {
                    this.handleBackendProcessRuntimeExit(processId, exitCode, signalCode, error);
                },
            });
            const record = {
                requestId,
                runtime,
                processId,
                entry,
                kind,
                ...(key ? { key } : {}),
                state: "starting",
                userId,
                ...(options?.metadata ? { metadata: options.metadata } : {}),
                startedAt: new Date().toISOString(),
                startupTimer: null,
                heartbeatTimer: null,
                stopTimer: null,
                startupTimeoutMs,
                heartbeatTimeoutMs,
            };
            this.backendProcesses.set(processId, record);
            if (key) {
                this.backendProcessKeyIndex.set(this.buildBackendProcessKey(userId, kind, key), processId);
            }
            this.emitBackendProcessLifecycle(record);
            record.startupTimer = setTimeout(() => {
                const latest = this.backendProcesses.get(processId);
                if (!latest || latest.state !== "starting")
                    return;
                try {
                    latest.runtime.terminate(true);
                }
                catch {
                    // ignore
                }
                this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process startup timed out");
                this.rejectRequest(requestId, new Error("Backend process startup timed out"));
            }, startupTimeoutMs);
            runtime.postMessage({
                type: "init",
                process: {
                    processId,
                    entry,
                    entryPath,
                    kind,
                    ...(key ? { key } : {}),
                    payload: options?.payload,
                    ...(options?.metadata ? { metadata: options.metadata } : {}),
                    ...(userId ? { userId } : {}),
                },
            });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleBackendProcessList(requestId, filter) {
        try {
            const userId = this.installScope === "user"
                ? this.installedByUserId ?? undefined
                : typeof filter?.userId === "string" && filter.userId.trim()
                    ? filter.userId.trim()
                    : undefined;
            const items = Array.from(this.backendProcesses.values())
                .filter((record) => {
                if (userId && record.userId !== userId)
                    return false;
                if (filter?.kind && record.kind !== filter.kind)
                    return false;
                if (filter?.key && record.key !== filter.key)
                    return false;
                if (filter?.state && record.state !== filter.state)
                    return false;
                return true;
            })
                .map((record) => this.snapshotBackendProcess(record));
            this.postToWorker({ type: "response", requestId, result: items });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleBackendProcessGet(requestId, processId) {
        try {
            const record = this.getBackendProcessRecord(processId);
            this.postToWorker({
                type: "response",
                requestId,
                result: record ? this.snapshotBackendProcess(record) : null,
            });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleBackendProcessStop(requestId, processId, options) {
        try {
            const record = this.getBackendProcessRecord(processId);
            if (!record) {
                this.postToWorker({ type: "response", requestId, result: undefined });
                return;
            }
            const resolvedUserId = this.installScope === "user"
                ? this.installedByUserId ?? undefined
                : typeof options?.userId === "string" && options.userId.trim()
                    ? options.userId.trim()
                    : undefined;
            if (resolvedUserId && record.userId !== resolvedUserId) {
                throw new Error("processId does not belong to the requested userId");
            }
            if (record.state === "starting" || record.state === "running") {
                record.stopReason = options?.reason;
                if (record.startupTimer) {
                    clearTimeout(record.startupTimer);
                    record.startupTimer = null;
                }
                this.transitionBackendProcess(record, "stopping");
                this.armBackendStopTimer(record);
            }
            record.runtime.postMessage({
                type: "stop",
                ...(options?.reason ? { reason: options.reason } : {}),
            });
            this.postToWorker({ type: "response", requestId, result: undefined });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleBackendProcessSend(processId, payload, userId) {
        const record = this.getBackendProcessRecord(processId);
        if (!record)
            return;
        if (this.installScope === "operator" && userId && record.userId !== userId)
            return;
        record.runtime.postMessage({ type: "message", payload });
    }
}
