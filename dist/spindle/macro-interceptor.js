class MacroInterceptorChain {
    handlers = [];
    register(handler) {
        this.handlers.push(handler);
        this.handlers.sort((a, b) => a.priority - b.priority);
        return () => {
            const idx = this.handlers.indexOf(handler);
            if (idx !== -1)
                this.handlers.splice(idx, 1);
        };
    }
    unregisterByExtension(extensionId) {
        this.handlers = this.handlers.filter((h) => h.extensionId !== extensionId);
    }
    async run(ctx) {
        let template = ctx.template;
        const touchedVars = new Set();
        let volatile = false;
        let opaque = false;
        for (const handler of this.handlers) {
            if (handler.userId && handler.userId !== ctx.userId)
                continue;
            try {
                const next = await handler.handler({ ...ctx, template });
                if (typeof next === "string") {
                    if (next !== template) {
                        template = next;
                        opaque = true;
                    }
                }
                else if (next &&
                    typeof next === "object" &&
                    typeof next.text === "string") {
                    if (next.text !== template)
                        template = next.text;
                    if (next.touchedVars) {
                        for (const v of next.touchedVars)
                            touchedVars.add(v);
                    }
                    if (next.volatile)
                        volatile = true;
                }
            }
            catch (err) {
                console.error(`[Spindle] Macro interceptor error from ${handler.extensionId}: ${err instanceof Error ? err.message : String(err)}`);
                if (err instanceof Error && err.stack) {
                    console.error(err.stack);
                }
            }
        }
        return { text: template, touchedVars: [...touchedVars], volatile, opaque };
    }
    get count() {
        return this.handlers.length;
    }
}
export const macroInterceptorChain = new MacroInterceptorChain();
