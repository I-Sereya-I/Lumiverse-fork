import { projectActivationProvenance, } from "../spindle/activation-provenance";
import { WorldInfoMatcher, makeScanState, } from "./world-info-matcher.service";
export const DEFAULT_WORLD_INFO_SETTINGS = {
    forceCaseSensitive: false,
    forceMatchWholeWords: false,
    globalScanDepth: null,
    maxRecursionPasses: 3,
    maxActivatedEntries: 0,
    maxTokenBudget: 0,
    minPriority: 0,
};
function nonNegativeInteger(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
export function normalizeWorldInfoSettings(settingsInput) {
    const input = settingsInput ?? {};
    const defaultScanDepth = DEFAULT_WORLD_INFO_SETTINGS.globalScanDepth;
    const rawScanDepth = input.globalScanDepth;
    const globalScanDepth = typeof rawScanDepth === "number" && Number.isFinite(rawScanDepth) && rawScanDepth > 0
        ? Math.floor(rawScanDepth)
        : defaultScanDepth;
    return {
        forceCaseSensitive: input.forceCaseSensitive === true,
        forceMatchWholeWords: input.forceMatchWholeWords === true,
        globalScanDepth,
        maxRecursionPasses: nonNegativeInteger(input.maxRecursionPasses, DEFAULT_WORLD_INFO_SETTINGS.maxRecursionPasses),
        maxActivatedEntries: nonNegativeInteger(input.maxActivatedEntries, DEFAULT_WORLD_INFO_SETTINGS.maxActivatedEntries),
        maxTokenBudget: nonNegativeInteger(input.maxTokenBudget, DEFAULT_WORLD_INFO_SETTINGS.maxTokenBudget),
        minPriority: nonNegativeInteger(input.minPriority, DEFAULT_WORLD_INFO_SETTINGS.minPriority),
    };
}
export function createWorldInfoActivationScanCache() {
    return { baseStates: new Map() };
}
export function primeWorldInfoActivationScanCache(cache, entryViews, settingsInput) {
    cache.messages = undefined;
    cache.messageSignature = undefined;
    cache.baseStates.clear();
    const settings = normalizeWorldInfoSettings(settingsInput);
    const views = entryViews.map((entries) => conditionalEntriesForScan(entries, settings));
    const union = new Map();
    const signatures = new Map();
    for (const entries of views) {
        for (const entry of entries) {
            const signature = scanEntrySignature(entry);
            const existing = signatures.get(entry.uid);
            if (existing !== undefined && existing !== signature) {
                cache.plan = undefined;
                return;
            }
            signatures.set(entry.uid, signature);
            if (!union.has(entry.uid))
                union.set(entry.uid, entry);
        }
    }
    cache.plan = { views, unionEntries: [...union.values()], settings };
}
// ─── Activation cache (short-TTL for rapid dry-run optimization) ───
const WI_ACTIVATION_CACHE_TTL_MS = 30_000;
const WI_ACTIVATION_CACHE_MAX_ENTRIES = 256;
const wiActivationCache = new Map();
/** Drop cloned activation results without affecting prompt-local scan state. */
export function clearWorldInfoActivationCache() {
    wiActivationCache.clear();
}
function cloneActivationProvenance(value) {
    const clone = projectActivationProvenance(value);
    if (!clone)
        throw new Error("Invalid activation provenance in cache");
    return clone;
}
function cloneActivationProvenanceMap(source) {
    return new Map([...source].map(([id, provenance]) => [id, cloneActivationProvenance(provenance)]));
}
function pruneWiActivationCache(now = Date.now()) {
    for (const [key, cached] of wiActivationCache) {
        if (now - cached.cachedAt > WI_ACTIVATION_CACHE_TTL_MS) {
            wiActivationCache.delete(key);
        }
    }
    while (wiActivationCache.size >= WI_ACTIVATION_CACHE_MAX_ENTRIES) {
        const oldest = wiActivationCache.keys().next();
        if (oldest.done)
            break;
        wiActivationCache.delete(oldest.value);
    }
}
function conditionalEntriesForScan(entries, settings) {
    return entries.filter((entry) => !entry.disabled && !entry.constant &&
        (settings.minPriority === 0 || entry.priority >= settings.minPriority));
}
function computeMessageSignature(messages) {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const message of messages) {
        hasher.update(JSON.stringify({ id: message.id, content: message.content }));
        hasher.update("\0");
    }
    return hasher.digest("hex");
}
function computeWiActivationCacheKey(input) {
    const entries = input.entries;
    const messages = input.messages;
    const wiState = input.wiState;
    const settings = normalizeWorldInfoSettings(input.settings);
    const entrySig = entries
        .map((e) => JSON.stringify({
        id: e.id,
        uid: e.uid,
        world_book_id: e.world_book_id,
        key: e.key,
        keysecondary: e.keysecondary,
        content: e.content,
        position: e.position,
        depth: e.depth,
        role: e.role,
        order_value: e.order_value,
        selective: e.selective,
        constant: e.constant,
        disabled: e.disabled,
        group_name: e.group_name,
        group_override: e.group_override,
        group_weight: e.group_weight,
        probability: e.probability,
        scan_depth: e.scan_depth,
        case_sensitive: e.case_sensitive,
        match_whole_words: e.match_whole_words,
        use_regex: e.use_regex,
        prevent_recursion: e.prevent_recursion,
        exclude_recursion: e.exclude_recursion,
        delay_until_recursion: e.delay_until_recursion,
        priority: e.priority,
        sticky: e.sticky,
        cooldown: e.cooldown,
        delay: e.delay,
        selective_logic: e.selective_logic,
        use_probability: e.use_probability,
        vectorized: e.vectorized,
    }))
        .join("|");
    const readsMessages = conditionalEntriesForScan(entries, settings).some((entry) => entry.key.length > 0);
    let msgSig = "";
    if (readsMessages) {
        msgSig = input.scanCache?.messageSignature ?? "";
        if (!msgSig) {
            msgSig = computeMessageSignature(messages);
            if (input.scanCache)
                input.scanCache.messageSignature = msgSig;
        }
    }
    const stateSig = JSON.stringify(wiState);
    const settingsSig = JSON.stringify(settings);
    const selectionSig = JSON.stringify([...input.selectionContentByEntryId ?? []]);
    return `${entrySig}::${msgSig}::${stateSig}::${settingsSig}::${selectionSig}`;
}
function bindWorldInfoActivationScanCache(cache, messages) {
    if (cache.messages === messages)
        return;
    if (cache.messages !== undefined) {
        cache.messageSignature = undefined;
        cache.baseStates.clear();
        cache.plan = undefined;
    }
    cache.messages = messages;
}
function deepCloneWiState(state) {
    return JSON.parse(JSON.stringify(state));
}
function getCachedActivationResult(cacheKey) {
    const cached = wiActivationCache.get(cacheKey);
    if (!cached)
        return null;
    if (Date.now() - cached.cachedAt > WI_ACTIVATION_CACHE_TTL_MS) {
        wiActivationCache.delete(cacheKey);
        return null;
    }
    return {
        ...cached.result,
        wiState: deepCloneWiState(cached.result.wiState),
        activationProvenanceById: cloneActivationProvenanceMap(cached.result.activationProvenanceById),
        firstTriggeredForBookById: new Map(cached.result.firstTriggeredForBookById),
    };
}
function setCachedActivationResult(cacheKey, result) {
    pruneWiActivationCache();
    wiActivationCache.set(cacheKey, {
        result: {
            ...result,
            wiState: deepCloneWiState(result.wiState),
            activationProvenanceById: cloneActivationProvenanceMap(result.activationProvenanceById),
            firstTriggeredForBookById: new Map(result.firstTriggeredForBookById),
        },
        cachedAt: Date.now(),
    });
}
/**
 * Run full World Info activation pipeline.
 *
 * Order: filter disabled → filter minPriority → separate constants →
 * keyword match (with global scan depth fallback) → selective logic →
 * probability → sticky/cooldown/delay → group logic → sort →
 * budget enforcement → bucket by position.
 */
export function activateWorldInfo(input) {
    if (input.scanCache)
        bindWorldInfoActivationScanCache(input.scanCache, input.messages);
    const cacheKey = input.random ? null : computeWiActivationCacheKey(input);
    const cached = cacheKey ? getCachedActivationResult(cacheKey) : null;
    if (cached)
        return cached;
    const { entries, messages, wiState } = input;
    const settings = normalizeWorldInfoSettings(input.settings);
    // 0. Cleanup wiState: Remove any keys that are no longer in the candidates list.
    // This prevents hidden sticky/active entries from persisting after a lorebook is removed.
    const entryUids = new Set(entries.map(e => e.uid));
    for (const uid in wiState) {
        if (!entryUids.has(uid)) {
            delete wiState[uid];
        }
    }
    // 1. Filter disabled entries
    const enabledEntries = entries.filter(e => !e.disabled);
    // 1b. Filter by minimum priority threshold
    let evictedByMinPriority = 0;
    const candidates = enabledEntries.filter(e => {
        if (settings.minPriority > 0 && e.priority < settings.minPriority && !e.constant) {
            evictedByMinPriority++;
            return false;
        }
        return true;
    });
    // 2. Separate constants (always activate)
    const constants = [];
    const conditional = [];
    for (const e of candidates) {
        if (e.constant)
            constants.push(e);
        else
            conditional.push(e);
    }
    // 3. Evaluate conditional entries
    const activated = [...constants];
    const activationProvenanceById = new Map();
    const firstTriggeredForBookById = new Map();
    const triggeredBooks = new Set();
    for (const entry of constants) {
        activationProvenanceById.set(entry.id, { origin: "constant" });
        firstTriggeredForBookById.set(entry.id, !triggeredBooks.has(entry.world_book_id));
        triggeredBooks.add(entry.world_book_id);
    }
    const blockedByCooldown = new Set();
    const matchedThisTurn = new Set();
    const delayIncremented = new Set();
    for (const entry of conditional) {
        const state = wiState[entry.uid];
        if (!state || state.cooldownLeft <= 0)
            continue;
        state.cooldownLeft--;
        state.active = false;
        blockedByCooldown.add(entry.uid);
    }
    const activatedUids = new Set();
    for (const entry of constants) {
        activatedUids.add(entry.uid);
    }
    const maxPasses = settings.maxRecursionPasses;
    const recursionPassesUsed = runAhoCorasickPasses({
        conditional, constants, messages, settings, wiState,
        activated, activatedUids, blockedByCooldown, matchedThisTurn, delayIncremented,
        maxPasses, activationProvenanceById, firstTriggeredForBookById, triggeredBooks,
        scanCache: input.scanCache, random: input.random ?? Math.random,
    });
    for (const entry of conditional) {
        if (activatedUids.has(entry.uid))
            continue;
        if (blockedByCooldown.has(entry.uid))
            continue;
        if (matchedThisTurn.has(entry.uid))
            continue;
        const state = wiState[entry.uid];
        if (!state)
            continue;
        handleNoMatch(state, entry);
    }
    // Also re-activate sticky entries that are still in their sticky window
    for (const entry of conditional) {
        if (activated.includes(entry))
            continue;
        const state = wiState[entry.uid];
        if (state && state.stickyLeft > 0) {
            state.stickyLeft--;
            state.active = true;
            activated.push(entry);
            activationProvenanceById.set(entry.id, { origin: "sticky" });
            firstTriggeredForBookById.set(entry.id, !triggeredBooks.has(entry.world_book_id));
            triggeredBooks.add(entry.world_book_id);
            // When sticky expires, start cooldown
            if (state.stickyLeft === 0 && entry.cooldown > 0) {
                state.cooldownLeft = entry.cooldown;
            }
        }
    }
    const finalized = finalizeActivatedWorldInfoEntries(activated, settings, {
        random: input.random,
        selectionContentByEntryId: input.selectionContentByEntryId,
    });
    const stats = {
        totalCandidates: candidates.length,
        activatedBeforeBudget: finalized.activatedBeforeBudget,
        activatedAfterBudget: finalized.activatedAfterBudget,
        evictedByBudget: finalized.evictedByBudget,
        evictedByMinPriority,
        estimatedTokens: finalized.estimatedTokens,
        recursionPassesUsed,
        keywordActivated: finalized.activatedEntries.length,
        vectorActivated: 0,
        totalActivated: finalized.activatedEntries.length,
        deduplicated: 0,
        queryPreview: "",
    };
    const survivingIds = new Set(finalized.activatedEntries.map((entry) => entry.id));
    for (const id of [...activationProvenanceById.keys()]) {
        if (!survivingIds.has(id))
            activationProvenanceById.delete(id);
    }
    const finalFirstTriggeredForBookById = new Map();
    const survivingBooks = new Set();
    for (const entry of finalized.activatedEntries) {
        finalFirstTriggeredForBookById.set(entry.id, !survivingBooks.has(entry.world_book_id));
        survivingBooks.add(entry.world_book_id);
    }
    const result = {
        cache: finalized.cache,
        activatedEntries: finalized.activatedEntries,
        wiState,
        stats,
        activationProvenanceById,
        firstTriggeredForBookById: finalFirstTriggeredForBookById,
    };
    if (cacheKey)
        setCachedActivationResult(cacheKey, result);
    return result;
}
export function finalizeActivatedWorldInfoEntries(entries, settingsInput, options = {}) {
    const settings = normalizeWorldInfoSettings(settingsInput);
    const afterGroups = options.skipGroupLogic
        ? [...entries]
        : applyWorldInfoGroupLogic([...entries], options.random);
    const insertableEntries = afterGroups.filter((entry) => hasMeaningfulWorldInfoContent({ content: selectionContentFor(entry, options.selectionContentByEntryId) }));
    if (!options.preserveOrder) {
        insertableEntries.sort((a, b) => {
            const aPriority = options.budgetPriorityById?.get(a.id) ?? a.priority;
            const bPriority = options.budgetPriorityById?.get(b.id) ?? b.priority;
            if (bPriority !== aPriority)
                return bPriority - aPriority;
            return a.order_value - b.order_value;
        });
    }
    const activatedBeforeBudget = insertableEntries.length;
    const activatedEntries = enforceBudget(insertableEntries, settings, options.selectionContentByEntryId);
    const evictedByBudget = activatedBeforeBudget - activatedEntries.length;
    return {
        cache: bucketByPosition(activatedEntries),
        activatedEntries,
        activatedBeforeBudget,
        activatedAfterBudget: activatedEntries.length,
        evictedByBudget,
        estimatedTokens: estimateTokens(activatedEntries, options.selectionContentByEntryId),
    };
}
// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------
/** Rough token estimate: chars / 4 is a reasonable heuristic for English text. */
export function estimateWorldInfoEntryTokens(content) {
    return Math.ceil(content.length / 4);
}
function selectionContentFor(entry, selectionContentByEntryId) {
    return selectionContentByEntryId?.get(entry.id) ?? entry.content;
}
function estimateTokens(entries, selectionContentByEntryId) {
    let total = 0;
    for (const e of entries) {
        const content = selectionContentFor(e, selectionContentByEntryId);
        if (content)
            total += estimateWorldInfoEntryTokens(content);
    }
    return total;
}
/**
 * Enforce global budget limits on activated entries.
 * Entries are already sorted by priority desc, order_value asc.
 * Constants are never evicted — they take priority over conditional entries.
 */
function enforceBudget(entries, settings, selectionContentByEntryId) {
    let result = entries;
    // Max activated entries cap
    if (settings.maxActivatedEntries > 0 && result.length > settings.maxActivatedEntries) {
        const constants = [];
        const nonConstants = [];
        for (const e of result) {
            if (e.constant)
                constants.push(e);
            else
                nonConstants.push(e);
        }
        // Allow all constants through, cap the remaining slots for conditional entries
        const remaining = Math.max(0, settings.maxActivatedEntries - constants.length);
        result = [...constants, ...nonConstants.slice(0, remaining)];
    }
    // Token budget cap
    if (settings.maxTokenBudget > 0) {
        let totalTokens = 0;
        const kept = [];
        // Constants first (never evicted)
        for (const e of result) {
            if (e.constant) {
                const content = selectionContentFor(e, selectionContentByEntryId);
                totalTokens += content ? estimateWorldInfoEntryTokens(content) : 0;
                kept.push(e);
            }
        }
        // Non-constants in priority order until budget exhausted
        for (const e of result) {
            if (e.constant)
                continue;
            const content = selectionContentFor(e, selectionContentByEntryId);
            const tokens = content ? estimateWorldInfoEntryTokens(content) : 0;
            if (totalTokens + tokens > settings.maxTokenBudget)
                continue;
            totalTokens += tokens;
            kept.push(e);
        }
        result = kept;
    }
    return result;
}
function keywordProvenance(entry, activationPass, state) {
    const primaryIndexes = state.primaryHits.get(entry.uid) ?? new Set();
    const secondaryIndexes = state.secondaryHits.get(entry.uid) ?? new Set();
    const exactMatches = state.exactMatches.get(entry.uid) ?? [];
    const exact = exactMatches[0];
    const source = exactMatches.length === 1 && exact
        ? exact.source.kind === "message"
            ? {
                kind: "message",
                messageId: exact.source.messageId,
                messageOffset: exact.source.messageOffset,
                start: exact.start,
                end: exact.end,
            }
            : {
                kind: "recursive_entry",
                entryId: exact.source.entryId,
                start: exact.start,
                end: exact.end,
            }
        : { kind: "mixed_or_unavailable" };
    return {
        origin: "keyword",
        activationPass,
        matchedPrimaryKeys: [...primaryIndexes].sort((a, b) => a - b).map((index) => entry.key[index]).filter((key) => typeof key === "string"),
        matchedSecondaryKeys: [...secondaryIndexes].sort((a, b) => a - b).map((index) => entry.keysecondary[index]).filter((key) => typeof key === "string"),
        ...(exact ? { exactMatch: { configuredPattern: exact.configuredPattern, source } } : {}),
    };
}
function cloneScanState(state, include) {
    const selected = (entries) => [...entries].filter(([uid]) => !include || include.has(uid));
    return {
        primaryHits: new Map(selected(state.primaryHits).map(([uid, hits]) => [uid, new Set(hits)])),
        secondaryHits: new Map(selected(state.secondaryHits).map(([uid, hits]) => [uid, new Set(hits)])),
        regexCache: new Map(),
        exactMatches: new Map(selected(state.exactMatches).map(([uid, matches]) => [uid, matches.map((match) => ({ ...match, source: { ...match.source } }))])),
    };
}
function baseScanCacheKey(conditional, settings) {
    return JSON.stringify({
        forceCaseSensitive: settings.forceCaseSensitive,
        forceMatchWholeWords: settings.forceMatchWholeWords,
        globalScanDepth: settings.globalScanDepth,
        entries: conditional.map(scanEntryCacheValue),
    });
}
function scanEntryCacheValue(entry) {
    return {
        uid: entry.uid,
        key: entry.key,
        keysecondary: entry.keysecondary,
        scan_depth: entry.scan_depth,
        case_sensitive: entry.case_sensitive,
        match_whole_words: entry.match_whole_words,
        use_regex: entry.use_regex,
    };
}
function scanEntrySignature(entry) {
    return JSON.stringify(scanEntryCacheValue(entry));
}
function scanBaseState(matcher, conditional, messages, settings) {
    const state = makeScanState();
    const depthBuckets = new Map();
    const depthKey = (depth) => (depth === null ? "all" : String(depth));
    for (const entry of conditional) {
        if (entry.key.length === 0)
            continue;
        const key = depthKey(entry.scan_depth ?? settings.globalScanDepth);
        let scope = depthBuckets.get(key);
        if (!scope) {
            scope = new Set();
            depthBuckets.set(key, scope);
        }
        scope.add(entry.uid);
    }
    for (const [key, scope] of depthBuckets) {
        const depth = key === "all" ? null : Number(key);
        const selectedMessages = depth === null || depth <= 0 || depth >= messages.length
            ? messages : messages.slice(-depth);
        for (const message of selectedMessages) {
            matcher.scanChunk(message.content, state, scope, {
                kind: "message",
                messageId: message.id,
                messageOffset: message.index_in_chat,
            });
        }
    }
    return state;
}
function materializeScanPlan(cache, messages) {
    const plan = cache.plan;
    if (!plan)
        return;
    cache.plan = undefined;
    const matcher = new WorldInfoMatcher(plan.unionEntries, {
        forceCaseSensitive: plan.settings.forceCaseSensitive,
        forceMatchWholeWords: plan.settings.forceMatchWholeWords,
    });
    const unionState = scanBaseState(matcher, plan.unionEntries, messages, plan.settings);
    for (const entries of plan.views) {
        cache.baseStates.set(baseScanCacheKey(entries, plan.settings), cloneScanState(unionState, new Set(entries.map((entry) => entry.uid))));
    }
}
function runAhoCorasickPasses(args) {
    const { conditional, constants, messages, settings, wiState, activated, activatedUids, blockedByCooldown, matchedThisTurn, delayIncremented, maxPasses, activationProvenanceById, firstTriggeredForBookById, triggeredBooks, scanCache, random } = args;
    const matcher = new WorldInfoMatcher(conditional, {
        forceCaseSensitive: settings.forceCaseSensitive,
        forceMatchWholeWords: settings.forceMatchWholeWords,
    });
    if (scanCache?.plan)
        materializeScanPlan(scanCache, messages);
    const scanKey = scanCache ? baseScanCacheKey(conditional, settings) : null;
    const cachedBaseState = scanKey === null ? undefined : scanCache?.baseStates.get(scanKey);
    const state = cachedBaseState
        ? cloneScanState(cachedBaseState)
        : scanBaseState(matcher, conditional, messages, settings);
    if (!cachedBaseState && scanKey !== null)
        scanCache?.baseStates.set(scanKey, cloneScanState(state));
    let recursionPassesUsed = 0;
    let newContent = constants
        .filter((entry) => entry.content && !entry.prevent_recursion && !entry.vectorized)
        .map((entry) => ({ entryId: entry.id, content: entry.content }));
    for (let pass = 0; pass <= maxPasses; pass++) {
        if (pass > 0) {
            if (newContent.length === 0)
                break;
            for (const chunk of newContent) {
                matcher.scanChunk(chunk.content, state, undefined, {
                    kind: "recursive_entry",
                    entryId: chunk.entryId,
                });
            }
            newContent = [];
        }
        let activatedThisPass = false;
        for (const entry of conditional) {
            if (activatedUids.has(entry.uid))
                continue;
            if (blockedByCooldown.has(entry.uid))
                continue;
            if (pass === 0 && entry.delay_until_recursion)
                continue;
            // "Non-recursable" — exclude_recursion means the entry cannot be
            // activated by a recursion pass (pass > 0). It can still activate on
            // pass 0 from the raw chat messages.
            if (pass > 0 && entry.exclude_recursion)
                continue;
            if (pass > 0 && entry.vectorized)
                continue;
            if (entry.key.length === 0)
                continue;
            if (!matcher.shouldActivate(entry, state))
                continue;
            const entryState = getOrInitState(wiState, entry);
            matchedThisTurn.add(entry.uid);
            if (entry.delay > 0 && !delayIncremented.has(entry.uid)) {
                entryState.delayCount++;
                delayIncremented.add(entry.uid);
            }
            if (entry.delay > 0 && entryState.delayCount < entry.delay)
                continue;
            if (entry.use_probability && entry.probability < 100) {
                if (random() * 100 >= entry.probability)
                    continue;
            }
            entryState.active = true;
            entryState.delayCount = 0;
            if (entry.sticky > 0)
                entryState.stickyLeft = entry.sticky;
            activated.push(entry);
            activatedUids.add(entry.uid);
            activationProvenanceById.set(entry.id, keywordProvenance(entry, pass, state));
            firstTriggeredForBookById.set(entry.id, !triggeredBooks.has(entry.world_book_id));
            triggeredBooks.add(entry.world_book_id);
            activatedThisPass = true;
            // "Prevent Further Recursion" — activated entry's content is not fed
            // back into the scanner for subsequent recursion passes.
            if (entry.content && !entry.prevent_recursion && !entry.vectorized) {
                newContent.push({ entryId: entry.id, content: entry.content });
            }
        }
        if (activatedThisPass && pass > 0)
            recursionPassesUsed = pass;
        if (!activatedThisPass && (pass > 0 || newContent.length === 0 || pass >= maxPasses))
            break;
    }
    return recursionPassesUsed;
}
function getOrInitState(wiState, entry) {
    if (!wiState[entry.uid]) {
        wiState[entry.uid] = { stickyLeft: 0, cooldownLeft: 0, delayCount: 0, active: false };
    }
    return wiState[entry.uid];
}
function handleNoMatch(state, entry) {
    // If was previously active with sticky, let sticky handler deal with it
    if (state.active && state.stickyLeft <= 0) {
        state.active = false;
        state.delayCount = 0;
    }
    // Reset delay count on non-match (must be consecutive)
    if (entry.delay > 0) {
        state.delayCount = 0;
    }
}
/**
 * Apply group logic: entries with the same group_name compete.
 * - group_override: highest priority entry wins
 * - Otherwise: weighted random selection by group_weight
 */
export function applyWorldInfoGroupLogic(entries, random = Math.random) {
    const grouped = new Map();
    const ungrouped = [];
    for (const entry of entries) {
        if (entry.group_name) {
            const list = grouped.get(entry.group_name) || [];
            list.push(entry);
            grouped.set(entry.group_name, list);
        }
        else {
            ungrouped.push(entry);
        }
    }
    const result = [...ungrouped];
    for (const [, group] of grouped) {
        if (group.length === 1) {
            result.push(group[0]);
            continue;
        }
        // Check for override entries
        const overrides = group.filter(e => e.group_override);
        if (overrides.length > 0) {
            // Highest priority override wins
            overrides.sort((a, b) => b.priority - a.priority);
            result.push(overrides[0]);
            continue;
        }
        // Weighted random selection
        const totalWeight = group.reduce((sum, e) => sum + (e.group_weight || 1), 0);
        if (totalWeight <= 0) {
            result.push(group[0]);
            continue;
        }
        let roll = random() * totalWeight;
        for (const entry of group) {
            roll -= entry.group_weight || 1;
            if (roll <= 0) {
                result.push(entry);
                break;
            }
        }
    }
    return result;
}
/**
 * Bucket activated entries into WorldInfoCache positions:
 *  0 = before, 1 = after, 2 = AN before, 3 = AN after,
 *  4 = depth-based, 5 = EM before, 6 = EM after, 7 = at-marker,
 *  8 = outlet-only (excluded from all position buckets; surfaces only via {{outlet::name}})
 */
function bucketByPosition(entries) {
    const cache = {
        before: [],
        after: [],
        anBefore: [],
        anAfter: [],
        depth: [],
        emBefore: [],
        emAfter: [],
        atMarker: [],
        pinnedMarkers: [],
    };
    for (const entry of entries) {
        const content = entry.content;
        if (!hasMeaningfulWorldInfoContent(entry))
            continue;
        const role = normalizeRole(entry.role);
        const entryLabel = getWorldInfoEntryLabel(entry);
        switch (entry.position) {
            case 0:
                cache.before.push({ content, role, entryLabel });
                break;
            case 1:
                cache.after.push({ content, role, entryLabel });
                break;
            case 2:
                cache.anBefore.push({ content, role, entryLabel });
                break;
            case 3:
                cache.anAfter.push({ content, role, entryLabel });
                break;
            case 4:
                cache.depth.push({
                    content,
                    depth: entry.depth,
                    role,
                    entryLabel,
                });
                break;
            case 5:
                cache.emBefore.push({ content, role, entryLabel });
                break;
            case 6:
                cache.emAfter.push({ content, role, entryLabel });
                break;
            case 7:
                if (typeof entry.wi_marker === "string" && entry.wi_marker.length > 0) {
                    // Marker-pinned: splice adjacent to the loom block whose marker
                    // matches, instead of joining the legacy {{wi_marker}} pool.
                    cache.pinnedMarkers.push({
                        content,
                        role,
                        entryLabel,
                        marker: entry.wi_marker,
                        side: entry.wi_marker_side === "before" ? "before" : "after",
                    });
                }
                else {
                    // Legacy: position-7 entries without a pin join the {{wi_marker}} pool.
                    cache.atMarker.push({ content, role, entryLabel });
                }
                break;
            case 8:
                // Outlet-only: not injected at any position; resolved solely via the
                // {{outlet::name}} macro from `activatedEntries`.
                break;
            default:
                // Unknown position — treat as "before"
                cache.before.push({ content, role, entryLabel });
                break;
        }
    }
    return cache;
}
/** Materialize an already-selected entry list into prompt insertion buckets. */
export function materializeWorldInfoCache(entries) {
    return bucketByPosition(entries);
}
function hasMeaningfulWorldInfoContent(entry) {
    return typeof entry.content === "string" && entry.content.trim().length > 0;
}
function getWorldInfoEntryLabel(entry) {
    const comment = entry.comment?.trim();
    if (comment)
        return comment;
    const primaryKeys = entry.key?.map((key) => key.trim()).filter(Boolean) ?? [];
    if (primaryKeys.length > 0)
        return primaryKeys.join(", ");
    const secondaryKeys = entry.keysecondary?.map((key) => key.trim()).filter(Boolean) ?? [];
    if (secondaryKeys.length > 0)
        return secondaryKeys.join(", ");
    return `(unnamed entry ${entry.id.slice(0, 8)})`;
}
function normalizeRole(role) {
    if (role === "user" || role === "assistant")
        return role;
    return "system";
}
