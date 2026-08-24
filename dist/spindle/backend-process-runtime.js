"use strict";
let activeProcess = null;
function post(message) {
    if (typeof process.send === "function") {
        process.send(message);
        return;
    }
    self.postMessage(message);
}
function shutdown(kind, error) {
    const processState = activeProcess;
    if (processState?.terminal)
        return;
    if (processState) {
        processState.terminal = true;
        try {
            processState.cleanup?.();
        }
        catch (err) {
            console.error("[Spindle backend process] Cleanup failed:", err);
        }
        processState.messageHandlers.clear();
        processState.stopHandlers.clear();
        activeProcess = null;
    }
    if (kind === "fail") {
        post({ type: "fail", error: error?.trim() || "Backend process failed" });
        process.exit(1);
        return;
    }
    post({ type: kind });
    process.exit(0);
}
async function handleInit(msg) {
    try {
        const mod = await import(msg.process.entryPath);
        const handler = typeof mod.default === "function"
            ? mod.default
            : typeof mod.run === "function"
                ? mod.run
                : null;
        if (!handler) {
            shutdown("fail", `Backend process entry \"${msg.process.entry}\" must export a default function or named \"run\" function`);
            return;
        }
        const processState = {
            processId: msg.process.processId,
            terminal: false,
            readySent: false,
            messageHandlers: new Set(),
            stopHandlers: new Set(),
        };
        activeProcess = processState;
        const ctx = {
            processId: msg.process.processId,
            entry: msg.process.entry,
            kind: msg.process.kind,
            ...(msg.process.key ? { key: msg.process.key } : {}),
            payload: msg.process.payload,
            ...(msg.process.metadata ? { metadata: msg.process.metadata } : {}),
            ...(msg.process.userId ? { userId: msg.process.userId } : {}),
            ready() {
                if (!activeProcess || activeProcess.terminal || activeProcess.readySent)
                    return;
                activeProcess.readySent = true;
                post({ type: "ready" });
            },
            heartbeat() {
                if (!activeProcess || activeProcess.terminal)
                    return;
                post({ type: "heartbeat" });
            },
            send(payload) {
                if (!activeProcess || activeProcess.terminal)
                    return;
                post({ type: "message", payload });
            },
            onMessage(handler) {
                activeProcess?.messageHandlers.add(handler);
                return () => {
                    activeProcess?.messageHandlers.delete(handler);
                };
            },
            complete(_result) {
                shutdown("complete");
            },
            fail(error) {
                shutdown("fail", error);
            },
            onStop(handler) {
                activeProcess?.stopHandlers.add(handler);
                return () => {
                    activeProcess?.stopHandlers.delete(handler);
                };
            },
        };
        const cleanup = await handler(ctx);
        if (typeof cleanup === "function" && activeProcess) {
            activeProcess.cleanup = cleanup;
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        shutdown("fail", message);
    }
}
function handleStop(reason) {
    const processState = activeProcess;
    if (!processState || processState.terminal)
        return;
    if (processState.stopHandlers.size === 0) {
        shutdown("stopped");
        return;
    }
    for (const handler of processState.stopHandlers) {
        try {
            handler({ reason });
        }
        catch (err) {
            console.error("[Spindle backend process] Stop handler failed:", err);
        }
    }
}
function handleMessage(payload) {
    const processState = activeProcess;
    if (!processState || processState.terminal)
        return;
    for (const handler of processState.messageHandlers) {
        try {
            handler(payload);
        }
        catch (err) {
            console.error("[Spindle backend process] Message handler failed:", err);
        }
    }
}
function onHostMessage(message) {
    switch (message.type) {
        case "init":
            void handleInit(message);
            break;
        case "stop":
            handleStop(message.reason);
            break;
        case "message":
            handleMessage(message.payload);
            break;
    }
}
if (typeof process.send === "function") {
    process.on("message", (message) => {
        onHostMessage(message);
    });
}
else {
    self.onmessage = (event) => {
        onHostMessage(event.data);
    };
}
