function normalizePlacement(value) {
    if (!value || typeof value !== "object")
        return null;
    const candidate = value;
    if (candidate.type !== "chat_depth" ||
        (candidate.role !== "system" &&
            candidate.role !== "user" &&
            candidate.role !== "assistant") ||
        (candidate.direction !== "from_start" &&
            candidate.direction !== "from_end") ||
        typeof candidate.depth !== "number" ||
        !Number.isFinite(candidate.depth) ||
        !Number.isInteger(candidate.depth) ||
        candidate.depth < 0) {
        return null;
    }
    return {
        type: "chat_depth",
        role: candidate.role,
        depth: candidate.depth,
        direction: candidate.direction,
    };
}
export class WorldInfoInterceptorChain {
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
    async run(entries, ctx, userId, bookSourceMap) {
        if (this.handlers.length === 0) {
            return {
                entries: [...entries],
                captureRequests: new Map(),
                activationOverrides: {},
                selectionContentByEntryId: new Map(),
                placementByEntryId: new Map(),
            };
        }
        const placementByEntryId = new Map();
        const buildDto = (src) => src.map((e) => ({
            id: e.id,
            world_book_id: e.world_book_id,
            comment: e.comment,
            disabled: e.disabled,
            constant: e.constant,
            extensions: e.extensions ?? {},
            key: e.key,
            keysecondary: e.keysecondary,
            position: e.position,
            depth: e.depth,
            role: e.role,
            priority: e.priority,
            probability: e.probability,
            use_probability: e.use_probability,
            content: e.content,
            automation_id: e.automation_id,
            selective: e.selective,
            selective_logic: e.selective_logic,
            group_name: e.group_name,
            group_override: e.group_override,
            group_weight: e.group_weight,
            match_whole_words: e.match_whole_words,
            case_sensitive: e.case_sensitive,
            use_regex: e.use_regex,
            prevent_recursion: e.prevent_recursion,
            exclude_recursion: e.exclude_recursion,
            delay_until_recursion: e.delay_until_recursion,
            exclude_greeting: e.exclude_greeting,
            scan_depth: e.scan_depth,
            order_value: e.order_value,
            sticky: e.sticky,
            cooldown: e.cooldown,
            delay: e.delay,
            ...(placementByEntryId.has(e.id)
                ? { placement: placementByEntryId.get(e.id) }
                : {}),
            book_source: bookSourceMap?.get(e.world_book_id),
        }));
        const disabledByChain = new Set();
        const enabledByChain = new Set();
        const forcedByChain = new Set();
        const contentOverrides = new Map();
        const captureRequests = new Map();
        const candidateIds = new Set(entries.map((entry) => entry.id));
        const selectionContentByEntryId = new Map();
        let disableRecursion = false;
        let working = [...entries];
        const rebuildWorking = () => entries.map((e) => {
            const isDisabled = disabledByChain.has(e.id);
            const wantsEnable = !isDisabled && enabledByChain.has(e.id) && e.disabled;
            const wantsForce = !isDisabled && forcedByChain.has(e.id);
            const newContent = contentOverrides.get(e.id);
            if (!isDisabled && !wantsEnable && !wantsForce && newContent === undefined) {
                return e;
            }
            return {
                ...e,
                ...(isDisabled ? { disabled: true } : {}),
                ...(wantsEnable ? { disabled: false } : {}),
                ...(wantsForce ? { constant: true } : {}),
                ...(newContent !== undefined ? { content: newContent } : {}),
            };
        });
        for (const handler of this.handlers) {
            if (handler.userId && handler.userId !== userId)
                continue;
            try {
                const result = await handler.handler({
                    ...ctx,
                    entries: buildDto(working),
                    activationSettings: {
                        globalScanDepth: ctx.activationSettings.globalScanDepth,
                        maxRecursionPasses: disableRecursion
                            ? 0
                            : ctx.activationSettings.maxRecursionPasses,
                    },
                });
                const disabledList = result?.disabled ?? [];
                const enabledList = result?.enabled ?? [];
                const forcedList = result?.forced ?? [];
                const mutatedList = result?.mutated ?? [];
                const capturedList = result?.captured;
                if (capturedList !== undefined) {
                    const requested = captureRequests.get(handler.extensionId) ?? new Set();
                    for (const id of capturedList) {
                        if (candidateIds.has(id))
                            requested.add(id);
                    }
                    captureRequests.set(handler.extensionId, requested);
                }
                const activationOverrides = result?.activationOverrides;
                const disablesRecursion = activationOverrides?.disableRecursion === true;
                if (disabledList.length === 0 &&
                    enabledList.length === 0 &&
                    forcedList.length === 0 &&
                    mutatedList.length === 0 &&
                    !disablesRecursion) {
                    continue;
                }
                for (const id of disabledList)
                    disabledByChain.add(id);
                for (const id of enabledList)
                    enabledByChain.add(id);
                for (const id of forcedList)
                    forcedByChain.add(id);
                for (const m of mutatedList) {
                    if (!candidateIds.has(m.id))
                        continue;
                    if (m.content !== undefined)
                        contentOverrides.set(m.id, m.content);
                    if (m.selectionContent !== undefined) {
                        selectionContentByEntryId.set(m.id, m.selectionContent);
                    }
                    const placement = normalizePlacement(m.placement);
                    if (placement)
                        placementByEntryId.set(m.id, placement);
                }
                disableRecursion ||= disablesRecursion;
                if (disabledList.length > 0 ||
                    enabledList.length > 0 ||
                    forcedList.length > 0 ||
                    mutatedList.length > 0) {
                    working = rebuildWorking();
                }
            }
            catch (err) {
                console.error(`[Spindle] World-info interceptor error from ${handler.extensionId}: ${err instanceof Error ? err.message : String(err)}`);
                if (err instanceof Error && err.stack) {
                    console.error(err.stack);
                }
            }
        }
        return {
            entries: working,
            captureRequests,
            activationOverrides: {
                ...(disableRecursion ? { disableRecursion: true } : {}),
            },
            selectionContentByEntryId,
            placementByEntryId,
        };
    }
    get count() {
        return this.handlers.length;
    }
}
export const worldInfoInterceptorChain = new WorldInfoInterceptorChain();
