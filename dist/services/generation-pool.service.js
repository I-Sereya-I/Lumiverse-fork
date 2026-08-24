/**
 * Generation Pool Service
 *
 * Maintains an in-memory buffer of accumulated generation content (tokens + reasoning)
 * per active generation. Allows clients that disconnect mid-stream to recover the
 * current state via the GET /generate/status/:chatId endpoint and resume rendering.
 *
 * Entries persist for a configurable TTL after the generation reaches a terminal state
 * (completed/stopped/error) so that reconnecting clients can discover what happened.
 */
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
// ── State ────────────────────────────────────────────────────────────────────
/** Primary index: generationId → pool entry */
const pool = new Map();
/** Secondary index: "userId:chatId" → generationId (most recent) */
const chatIndex = new Map();
/** Terminal statuses that indicate a generation is no longer active */
const TERMINAL_STATUSES = new Set(["completed", "stopped", "error"]);
/** Safety cap: terminal entries are swept after this to prevent memory leaks */
const UNACKNOWLEDGED_MAX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/**
 * Failsafe: a non-terminal entry with no pool activity (no tokens, no status
 * transitions) for this long is force-errored. Without it, a generation that
 * hangs without ever reaching a terminal state leaks its entry and leaves the
 * chat showing "streaming" forever. Generous because slow local models can
 * legitimately sit in prompt processing for many minutes without emitting.
 */
const STALE_ACTIVE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
/** Additional cap so terminal chat-head state cannot grow without bound. */
const MAX_TERMINAL_ENTRIES = 200;
/** Sweep interval */
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds
// ── CRUD ─────────────────────────────────────────────────────────────────────
export function createPoolEntry(opts) {
    const entry = {
        generationId: opts.generationId,
        userId: opts.userId,
        chatId: opts.chatId,
        content: "",
        reasoning: "",
        tokenSeq: 0,
        generationType: opts.generationType,
        targetMessageId: opts.targetMessageId,
        targetSwipeId: opts.targetSwipeId,
        characterName: opts.characterName,
        characterId: opts.characterId,
        model: opts.model,
        startedAt: Date.now(),
        status: "assembling",
        lastActivityAt: Date.now(),
    };
    pool.set(opts.generationId, entry);
    chatIndex.set(`${opts.userId}:${opts.chatId}`, opts.generationId);
}
export function setPoolStatus(generationId, status) {
    const entry = pool.get(generationId);
    if (!entry)
        return;
    entry.status = status;
    entry.lastActivityAt = Date.now();
}
export function markStreamingStarted(generationId) {
    const entry = pool.get(generationId);
    if (entry && !entry.streamingStartedAt) {
        entry.streamingStartedAt = Date.now();
    }
}
/**
 * Append content text and increment tokenSeq.
 * Returns the new tokenSeq value (used for the `seq` field on WS events) and
 * the char offset where this text begins in the cumulative content buffer.
 */
export function appendPoolContent(generationId, text) {
    const entry = pool.get(generationId);
    if (!entry)
        return { seq: 0, offset: 0 };
    const now = Date.now();
    // Finalize reasoning duration on the first content token
    if (entry.reasoningStartedAt && !entry.reasoningDurationMs) {
        entry.reasoningDurationMs = now - entry.reasoningStartedAt;
    }
    if (!entry.firstTokenAt)
        entry.firstTokenAt = now;
    if (!entry.firstContentTokenAt)
        entry.firstContentTokenAt = now;
    if (entry.status === "assembling" || entry.status === "council" || entry.status === "waiting" || entry.status === "reasoning") {
        setPoolStatus(generationId, "streaming");
        eventBus.emit(EventType.GENERATION_PHASE_CHANGED, { generationId, chatId: entry.chatId, phase: "streaming" }, entry.userId);
    }
    const offset = entry.content.length;
    entry.content += text;
    entry.lastActivityAt = now;
    return { seq: ++entry.tokenSeq, offset };
}
/**
 * Append reasoning text and increment tokenSeq.
 * Returns the new tokenSeq value and the char offset where this text begins
 * in the cumulative reasoning buffer.
 */
export function appendPoolReasoning(generationId, text) {
    const entry = pool.get(generationId);
    if (!entry)
        return { seq: 0, offset: 0 };
    const now = Date.now();
    if (!entry.reasoningStartedAt)
        entry.reasoningStartedAt = now;
    if (!entry.firstTokenAt)
        entry.firstTokenAt = now;
    if (entry.status === "assembling" || entry.status === "council" || entry.status === "waiting") {
        setPoolStatus(generationId, "reasoning");
        eventBus.emit(EventType.GENERATION_PHASE_CHANGED, { generationId, chatId: entry.chatId, phase: "reasoning" }, entry.userId);
    }
    const offset = entry.reasoning.length;
    entry.reasoning += text;
    entry.lastActivityAt = now;
    return { seq: ++entry.tokenSeq, offset };
}
export function completePool(generationId, messageId) {
    const entry = pool.get(generationId);
    if (!entry)
        return;
    entry.status = "completed";
    entry.completedMessageId = messageId;
    entry.completedAt = Date.now();
    trimTerminalEntries();
}
export function stopPool(generationId) {
    const entry = pool.get(generationId);
    if (!entry)
        return;
    entry.status = "stopped";
    entry.completedAt = Date.now();
    trimTerminalEntries();
}
export function errorPool(generationId, message) {
    const entry = pool.get(generationId);
    if (!entry)
        return;
    entry.status = "error";
    entry.error = message;
    entry.completedAt = Date.now();
    trimTerminalEntries();
}
// ── Lookups ──────────────────────────────────────────────────────────────────
export function getPoolEntry(generationId) {
    return pool.get(generationId);
}
/**
 * Look up the most recent pool entry for a chat. Returns the entry if it
 * exists and belongs to the given user. Covers both active and recently-
 * completed (within TTL) entries.
 */
export function getPoolForChat(userId, chatId) {
    const chatKey = `${userId}:${chatId}`;
    const generationId = chatIndex.get(chatKey);
    if (!generationId)
        return undefined;
    const entry = pool.get(generationId);
    if (!entry || entry.userId !== userId)
        return undefined;
    return entry;
}
/**
 * Return all active (non-terminal) pool entries for a user.
 * Used by the chat heads overlay to show in-progress generations across chats.
 */
export function getActivePoolsForUser(userId) {
    const results = [];
    for (const entry of pool.values()) {
        if (entry.userId === userId && !TERMINAL_STATUSES.has(entry.status)) {
            results.push(entry);
        }
    }
    return results;
}
/**
 * Return the latest pooled entry per chat that the user should see as a chat
 * head. Older generations for the same chat are intentionally hidden.
 */
export function getChatHeadPoolsForUser(userId) {
    const results = [];
    for (const generationId of chatIndex.values()) {
        const entry = pool.get(generationId);
        if (!entry || entry.userId !== userId)
            continue;
        results.push(entry);
    }
    return results;
}
/**
 * Clear terminal chat-head state for a chat once a user actually opens it.
 * Active generations are preserved so streaming recovery still works.
 */
export function acknowledgeChat(userId, chatId) {
    const currentGenerationId = chatIndex.get(`${userId}:${chatId}`);
    if (currentGenerationId) {
        const currentEntry = pool.get(currentGenerationId);
        if (currentEntry && !TERMINAL_STATUSES.has(currentEntry.status)) {
            return [];
        }
    }
    const removed = [];
    for (const [generationId, entry] of pool) {
        if (entry.userId !== userId || entry.chatId !== chatId)
            continue;
        if (!TERMINAL_STATUSES.has(entry.status))
            continue;
        removed.push(generationId);
    }
    for (const generationId of removed) {
        removePoolEntry(generationId);
    }
    return removed;
}
export function clearAllPoolEntries() {
    pool.clear();
    chatIndex.clear();
}
export function removePoolEntry(generationId) {
    const entry = pool.get(generationId);
    if (entry) {
        const chatKey = `${entry.userId}:${entry.chatId}`;
        // Only clear the chat index if it still points to this generation
        if (chatIndex.get(chatKey) === generationId) {
            chatIndex.delete(chatKey);
        }
    }
    pool.delete(generationId);
}
/**
 * Remove all pool entries for a given chat. Called when a chat is deleted
 * so that stale entries don't linger as phantom chat heads.
 */
export function removePoolEntriesForChat(userId, chatId) {
    const chatKey = `${userId}:${chatId}`;
    for (const [id, entry] of pool) {
        if (entry.userId === userId && entry.chatId === chatId) {
            pool.delete(id);
        }
    }
    chatIndex.delete(chatKey);
}
// ── Sweep ────────────────────────────────────────────────────────────────────
function sweep() {
    const now = Date.now();
    // Failsafe: force-error non-terminal entries with no activity for far longer
    // than any legitimate generation gap. The entry transitions to a terminal
    // state (reclaimed by the TTL pass below) and connected clients receive the
    // error so their streaming UI unsticks. If the underlying generation task is
    // somehow still alive and later completes, completePool() simply overwrites
    // this status — the failsafe is self-healing.
    for (const entry of pool.values()) {
        if (TERMINAL_STATUSES.has(entry.status))
            continue;
        if (now - entry.lastActivityAt <= STALE_ACTIVE_TIMEOUT_MS)
            continue;
        const message = "Generation timed out: no activity for 60 minutes";
        const priorStatus = entry.status;
        errorPool(entry.generationId, message);
        eventBus.emit(EventType.GENERATION_ENDED, { generationId: entry.generationId, chatId: entry.chatId, error: message }, entry.userId);
        console.warn(`[GenerationPool] Force-errored stale generation ${entry.generationId} (chat ${entry.chatId}, status was ${priorStatus})`);
    }
    for (const [id, entry] of pool) {
        if (!TERMINAL_STATUSES.has(entry.status) || !entry.completedAt)
            continue;
        const age = now - entry.completedAt;
        const ttl = UNACKNOWLEDGED_MAX_TTL_MS;
        if (age > ttl) {
            removePoolEntry(id);
        }
    }
    trimTerminalEntries();
}
function trimTerminalEntries() {
    const terminalEntries = [...pool.entries()]
        .filter(([, entry]) => TERMINAL_STATUSES.has(entry.status) && entry.completedAt)
        .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
    while (terminalEntries.length > MAX_TERMINAL_ENTRIES) {
        const [generationId] = terminalEntries.shift();
        removePoolEntry(generationId);
    }
}
/** Run one sweep pass immediately (stale failsafe + terminal TTL/trim). */
export function sweepPoolNow() {
    sweep();
}
let sweepTimer = null;
export function startPoolSweep() {
    if (!sweepTimer) {
        sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    }
}
export function stopPoolSweep() {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}
// Auto-start sweep on module load
startPoolSweep();
