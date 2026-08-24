import { getDb } from "../db/connection";
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;
/** Slack (seconds) absorbing clock skew between outbox (ms) and
 *  messages.created_at (unixepoch seconds) during crash verification. */
const RECOVERY_TIMESTAMP_SLACK_SECONDS = 5;
const INSTANCE_ID = `eas-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let startGenerationFn = null;
let stopGenerationFn = null;
let isGenerationActiveFn = null;
export function setEditAndSendStartGeneration(fn) {
    startGenerationFn = fn;
}
export function setEditAndSendStopGeneration(fn) {
    stopGenerationFn = fn;
}
export function setEditAndSendGenerationActiveCheck(fn) {
    isGenerationActiveFn = fn;
}
export function resetEditAndSendDispatcherForTests() {
    startGenerationFn = null;
    stopGenerationFn = null;
    isGenerationActiveFn = null;
}
function nowMs() {
    return Date.now();
}
function backoffMs(attemptCount) {
    return Math.min(60_000, 1000 * (2 ** Math.max(0, attemptCount - 1)));
}
function withImmediateTransaction(fn) {
    const db = getDb();
    const txn = db.transaction(fn);
    if (typeof txn.immediate === "function")
        return txn.immediate();
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    }
    catch (err) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* already rolled back */ }
        throw err;
    }
}
function rowToOutbox(row) {
    return {
        id: row.id,
        request_id: row.request_id,
        user_id: row.user_id,
        chat_id: row.chat_id,
        branch_chat_id: row.branch_chat_id,
        edited_message_id: row.edited_message_id,
        target_message_id: row.target_message_id ?? null,
        target_swipe_index: typeof row.target_swipe_index === "number" ? row.target_swipe_index : null,
        expected_version: row.expected_version,
        generation_id: row.generation_id,
        mode: row.mode,
        status: row.status,
        lease_owner: row.lease_owner ?? null,
        lease_expires_at: row.lease_expires_at ?? null,
        attempt_count: row.attempt_count ?? 0,
        next_attempt_at: row.next_attempt_at ?? null,
        last_error_code: row.last_error_code ?? null,
        terminal_reason: row.terminal_reason ?? null,
        dispatched_at: row.dispatched_at ?? null,
        completed_at: row.completed_at ?? null,
        cancelled_at: row.cancelled_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
export function getGenerationOutboxByRequest(userId, chatId, requestId) {
    const row = getDb()
        .query(`SELECT * FROM generation_outbox
       WHERE user_id = ? AND chat_id = ? AND request_id = ?`)
        .get(userId, chatId, requestId);
    return row ? rowToOutbox(row) : null;
}
export function getGenerationOutboxById(id) {
    const row = getDb().query("SELECT * FROM generation_outbox WHERE id = ?").get(id);
    return row ? rowToOutbox(row) : null;
}
export function getGenerationOutboxByGenerationId(generationId) {
    const row = getDb()
        .query("SELECT * FROM generation_outbox WHERE generation_id = ?")
        .get(generationId);
    return row ? rowToOutbox(row) : null;
}
function isClaimable(row, now) {
    // Rows whose attempts are exhausted are terminal-in-waiting: re-claiming
    // them would retry forever, so only reconcile/failure paths may close them.
    if (row.attempt_count >= MAX_ATTEMPTS)
        return false;
    if (row.status === "pending") {
        return row.next_attempt_at == null || row.next_attempt_at <= now;
    }
    if (row.status === "claimed" || (row.status === "running" && row.dispatched_at == null)) {
        return row.lease_expires_at != null && row.lease_expires_at < now;
    }
    return false;
}
function claimOutboxRow(id, now) {
    return withImmediateTransaction(() => {
        const current = getGenerationOutboxById(id);
        if (!current || !isClaimable(current, now))
            return null;
        const leaseExpires = now + LEASE_MS;
        const result = getDb().query(`UPDATE generation_outbox
       SET status = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'claimed', 'running')
         AND (status = 'pending' OR (lease_expires_at IS NOT NULL AND lease_expires_at < ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (status != 'running' OR dispatched_at IS NULL)
         AND attempt_count < ?`).run(INSTANCE_ID, leaseExpires, now, id, now, now, MAX_ATTEMPTS);
        if (result.changes !== 1)
            return null;
        return getGenerationOutboxById(id);
    });
}
export function claimNextEditAndSendOutbox(now = nowMs()) {
    return withImmediateTransaction(() => {
        const candidate = getDb().query(`SELECT id FROM generation_outbox
       WHERE attempt_count < ?
         AND (
           (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (
             status IN ('claimed', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?
             AND (status != 'running' OR dispatched_at IS NULL)
           )
         )
        ORDER BY created_at ASC
        LIMIT 1`).get(MAX_ATTEMPTS, now, now);
        if (!candidate)
            return null;
        const leaseExpires = now + LEASE_MS;
        const result = getDb().query(`UPDATE generation_outbox
       SET status = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'claimed', 'running')
         AND (status = 'pending' OR (lease_expires_at IS NOT NULL AND lease_expires_at < ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (status != 'running' OR dispatched_at IS NULL)
         AND attempt_count < ?`).run(INSTANCE_ID, leaseExpires, now, candidate.id, now, now, MAX_ATTEMPTS);
        if (result.changes !== 1)
            return null;
        return getGenerationOutboxById(candidate.id);
    });
}
async function invokeStartGeneration(input) {
    if (startGenerationFn)
        return startGenerationFn(input);
    const { startGeneration } = await import("./generate.service");
    return startGeneration(input);
}
function invokeStopGeneration(userId, generationId) {
    if (stopGenerationFn)
        return stopGenerationFn(userId, generationId);
    return false;
}
function invokeIsGenerationActive(userId, generationId) {
    if (isGenerationActiveFn)
        return isGenerationActiveFn(userId, generationId);
    return false;
}
function markOutbox(id, fields) {
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
        assignments.push(`${key} = ?`);
        values.push(toSqlBinding(value));
    }
    assignments.push("updated_at = ?");
    values.push(nowMs());
    values.push(id);
    getDb().query(`UPDATE generation_outbox SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
}
/** Coerce arbitrary field values into SQLite-bindable primitives. */
function toSqlBinding(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return value;
    }
    if (value instanceof Uint8Array)
        return value;
    return String(value);
}
function markDispatchFailure(row, errorCode) {
    const now = nowMs();
    if (row.attempt_count >= MAX_ATTEMPTS) {
        markOutbox(row.id, {
            status: "failed",
            last_error_code: errorCode,
            terminal_reason: "max_attempts",
            completed_at: now,
            lease_owner: null,
            lease_expires_at: null,
        });
        return;
    }
    markOutbox(row.id, {
        status: "pending",
        last_error_code: errorCode,
        next_attempt_at: now + backoffMs(row.attempt_count),
        // Clear the previous attempt's dispatch marker: a pending row must be
        // fully re-dispatchable (dispatchClaimedEditAndSendOutbox skips rows
        // whose dispatched_at is still set).
        dispatched_at: null,
        lease_owner: null,
        lease_expires_at: null,
    });
}
export async function dispatchClaimedEditAndSendOutbox(row) {
    if (row.status !== "claimed")
        return row;
    const existing = getGenerationOutboxByGenerationId(row.generation_id);
    if (existing && existing.id !== row.id) {
        markOutbox(row.id, {
            status: "failed",
            last_error_code: "duplicate_generation_id",
            terminal_reason: "duplicate_generation_id",
            completed_at: nowMs(),
        });
        return getGenerationOutboxById(row.id);
    }
    if (row.dispatched_at)
        return row;
    const input = {
        userId: row.user_id,
        chat_id: row.branch_chat_id,
        generationId: row.generation_id,
        generation_type: row.mode,
        ...(row.mode === "swipe" && row.target_message_id
            ? { message_id: row.target_message_id }
            : {}),
    };
    try {
        const started = await invokeStartGeneration(input);
        const now = nowMs();
        withImmediateTransaction(() => {
            const current = getGenerationOutboxById(row.id);
            if (!current || current.status === "cancelled")
                return;
            getDb().query(`UPDATE generation_outbox
         SET status = 'running',
             dispatched_at = COALESCE(dispatched_at, ?),
             lease_owner = ?,
             lease_expires_at = ?,
             last_error_code = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND generation_id = ?
           AND dispatched_at IS NULL`).run(now, INSTANCE_ID, now + LEASE_MS, now, row.id, row.generation_id);
        });
        if (started.generationId && started.generationId !== row.generation_id) {
            // startGeneration still mints its own id until the generate.service patch.
            // Keep the committed outbox identity as the durable dispatch key.
        }
        return getGenerationOutboxById(row.id);
    }
    catch (err) {
        const code = err instanceof Error ? err.message.slice(0, 200) : "dispatch_failed";
        markDispatchFailure(row, code || "dispatch_failed");
        return getGenerationOutboxById(row.id);
    }
}
export async function dispatchEditAndSendRequest(userId, chatId, requestId) {
    const existing = getGenerationOutboxByRequest(userId, chatId, requestId);
    if (!existing)
        return null;
    if (existing.status === "completed" || existing.status === "cancelled")
        return existing;
    if (existing.status === "failed")
        return existing;
    if (existing.status === "running" && existing.dispatched_at)
        return existing;
    const claimed = claimOutboxRow(existing.id, nowMs());
    if (!claimed)
        return getGenerationOutboxByRequest(userId, chatId, requestId);
    return dispatchClaimedEditAndSendOutbox(claimed);
}
export async function dispatchPendingEditAndSendOutbox(limit = 16) {
    let dispatched = 0;
    for (let i = 0; i < limit; i++) {
        const claimed = claimNextEditAndSendOutbox();
        if (!claimed)
            break;
        await dispatchClaimedEditAndSendOutbox(claimed);
        dispatched++;
    }
    return dispatched;
}
export function cancelEditAndSendOutbox(userId, opts) {
    const now = nowMs();
    const cancelled = withImmediateTransaction(() => {
        const row = opts.generationId
            ? getGenerationOutboxByGenerationId(opts.generationId)
            : opts.requestId && opts.chatId
                ? getGenerationOutboxByRequest(userId, opts.chatId, opts.requestId)
                : null;
        if (!row || row.user_id !== userId)
            return null;
        if (row.status === "completed" || row.status === "cancelled")
            return row;
        getDb().query(`UPDATE generation_outbox
       SET status = 'cancelled',
           cancelled_at = ?,
           terminal_reason = 'cancelled',
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND status NOT IN ('completed', 'cancelled')`).run(now, now, row.id, userId);
        return getGenerationOutboxById(row.id);
    });
    if (cancelled?.generation_id)
        invokeStopGeneration(userId, cancelled.generation_id);
    return cancelled;
}
export function reconcileEditAndSendOutbox(now = nowMs()) {
    // Zombie sweep: pending rows whose attempts are exhausted are unclaimable
    // (claimNextEditAndSendOutbox filters attempt_count >= MAX_ATTEMPTS), so
    // without this they would sit in 'pending' forever. Fail them terminally.
    const failedZombies = getDb().query(`UPDATE generation_outbox
     SET status = 'failed',
         terminal_reason = COALESCE(terminal_reason, 'max_attempts'),
         completed_at = COALESCE(completed_at, ?),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status = 'pending'
       AND attempt_count >= ?`).run(now, now, MAX_ATTEMPTS).changes;
    const rows = getDb()
        .query(`SELECT * FROM generation_outbox
       WHERE status IN ('claimed', 'running')`)
        .all();
    let changed = failedZombies;
    for (const raw of rows) {
        const row = rowToOutbox(raw);
        if (row.status === "running" && row.dispatched_at) {
            // In-memory pool liveness is ONLY a skip signal: a live generation on
            // this instance is still in flight, so leave its row alone. Anything
            // else (crashed generation, cleared pool entry) goes through the SAME
            // durable verification as startup recovery - persisted-output check
            // plus attempt/backoff/max_attempts - never a blind completion.
            if (invokeIsGenerationActive(row.user_id, row.generation_id))
                continue;
            resolveOrphanedRunningRow(row, now);
            changed++;
            continue;
        }
        if (row.lease_expires_at != null && row.lease_expires_at < now && row.dispatched_at == null) {
            if (row.attempt_count >= MAX_ATTEMPTS) {
                // Exhausted stale claims are terminal: never re-queue them.
                markOutbox(row.id, {
                    status: "failed",
                    lease_owner: null,
                    lease_expires_at: null,
                    last_error_code: "max_attempts",
                    terminal_reason: "max_attempts",
                    completed_at: now,
                });
            }
            else {
                markOutbox(row.id, {
                    status: "pending",
                    lease_owner: null,
                    lease_expires_at: null,
                    next_attempt_at: now,
                });
            }
            changed++;
        }
    }
    return changed;
}
/**
 * Durable output verification for crash recovery. The messages table has no
 * generation_id column, so linkage uses conservative heuristics:
 * - normal mode: an assistant message row inserted into the branch chat at or
 *   after the dispatch timestamp (messages.created_at is unixepoch seconds,
 *   outbox timestamps are ms; a small slack window absorbs skew).
 *   Residual false-positive window: ANY assistant row in branch_chat_id after
 *   dispatch-5s counts as this row's output, including messages written by
 *   unrelated activity in the same branch chat during a crash window. Swipe
 *   rows have the stronger expected_version revision check and are not
 *   affected.
 * - swipe mode: the target assistant message's revision must have advanced
 *   past expected_version (chats.service bumps revision on every
 *   edit-and-send swipe write).
 */
function hasPersistedEditAndSendOutput(row) {
    const dispatchedAt = row.dispatched_at ?? 0;
    if (!dispatchedAt)
        return false;
    const afterSeconds = Math.floor(dispatchedAt / 1000) - RECOVERY_TIMESTAMP_SLACK_SECONDS;
    const inserted = getDb()
        .query(`SELECT id FROM messages
       WHERE chat_id = ? AND is_user = 0 AND created_at >= ?
       LIMIT 1`)
        .get(row.branch_chat_id, afterSeconds);
    if (inserted)
        return true;
    if (row.mode === "swipe" && row.target_message_id) {
        const target = getDb()
            .query(`SELECT revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1`)
            .get(row.target_message_id, row.branch_chat_id);
        return !!target && typeof target.revision === "number" && target.revision > row.expected_version;
    }
    return false;
}
/**
 * Durable resolution for a dispatched-but-unfinished running row whose
 * generating instance is gone. Shared by startup crash recovery and the
 * periodic reconcile tick: verify persisted output before completing;
 * otherwise retry with backoff until MAX_ATTEMPTS, then fail terminally.
 */
function resolveOrphanedRunningRow(row, now) {
    if (hasPersistedEditAndSendOutput(row)) {
        markOutbox(row.id, {
            status: "completed",
            completed_at: row.completed_at ?? now,
            lease_owner: null,
            lease_expires_at: null,
            terminal_reason: "verified_output",
            last_error_code: null,
        });
        return;
    }
    const attempts = row.attempt_count + 1;
    if (attempts >= MAX_ATTEMPTS) {
        markOutbox(row.id, {
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            attempt_count: attempts,
            last_error_code: "output_not_verified",
            terminal_reason: "max_attempts",
            completed_at: now,
        });
        return;
    }
    markOutbox(row.id, {
        status: "pending",
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: attempts,
        next_attempt_at: now + backoffMs(attempts),
        last_error_code: "output_not_verified",
        terminal_reason: null,
        // Clear the previous attempt's dispatch marker so the periodic sweep can
        // re-claim and fully re-dispatch this row (see markDispatchFailure).
        dispatched_at: null,
    });
}
export async function recoverEditAndSendOutbox() {
    const now = nowMs();
    withImmediateTransaction(() => {
        // Release stale, never-dispatched claims back to the pending queue.
        getDb().query(`UPDATE generation_outbox
       SET status = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = ?,
           updated_at = ?
       WHERE status IN ('claimed', 'running')
         AND dispatched_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)`).run(now, now, now);
        // Dispatched-but-unfinished rows: verify durably whether the assistant
        // output actually persisted before declaring success.
        const orphaned = getDb()
            .query(`SELECT * FROM generation_outbox WHERE status = 'running' AND dispatched_at IS NOT NULL`)
            .all();
        for (const raw of orphaned) {
            resolveOrphanedRunningRow(rowToOutbox(raw), now);
        }
    });
    return dispatchPendingEditAndSendOutbox();
}
