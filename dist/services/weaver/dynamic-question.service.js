import { getDb } from "../../db/connection";
import { getSession } from "./session.service";
import { getWeaverTuning } from "./tuning";
export const MAX_DYNAMIC_QUESTIONS = 8;
function dynamicQuestionCap(userId) {
    return getWeaverTuning(userId).dynamic_question_cap ?? MAX_DYNAMIC_QUESTIONS;
}
function safeParseArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
export function parseDynamicItems(value) {
    const arr = safeParseArray(value);
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const id = typeof r.id === "string" ? r.id.trim() : "";
        const answer = typeof r.answer === "string" ? r.answer.trim() : "";
        if (!id || !answer || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, question: typeof r.question === "string" ? r.question.trim() : "", answer });
    }
    return out;
}
export function itemsToDynamicEntries(items) {
    return items.map((i) => ({
        id: i.id,
        question: i.question,
        content: i.answer,
        origin: "established",
    }));
}
function buildState(userId, items) {
    return { items, at_cap: items.length >= dynamicQuestionCap(userId) };
}
function readLane(userId, sessionId) {
    const row = getDb()
        .prepare(`SELECT dynamic_questions FROM weaver_extraction WHERE session_id = ? AND user_id = ?`)
        .get(sessionId, userId);
    return parseDynamicItems(row?.dynamic_questions);
}
function writeLane(userId, sessionId, items) {
    const res = getDb()
        .prepare(`UPDATE weaver_extraction SET dynamic_questions = ?, edited_at = unixepoch()
        WHERE session_id = ? AND user_id = ?`)
        .run(JSON.stringify(items), sessionId, userId);
    if (res.changes === 0) {
        throw new Error("Read the dream first — there is no extraction to attach a dynamic answer to");
    }
}
export function getDynamicState(userId, sessionId) {
    if (!getSession(userId, sessionId))
        throw new Error("Session not found");
    return buildState(userId, readLane(userId, sessionId));
}
export function getDynamicEntries(userId, sessionId) {
    return itemsToDynamicEntries(readLane(userId, sessionId));
}
export function clearDynamicLane(userId, sessionId) {
    getDb()
        .prepare(`UPDATE weaver_extraction SET dynamic_questions = '[]', edited_at = unixepoch()
        WHERE session_id = ? AND user_id = ?`)
        .run(sessionId, userId);
}
export function answerDynamicQuestion(userId, sessionId, input) {
    if (!getSession(userId, sessionId))
        throw new Error("Session not found");
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const question = typeof input.question === "string" ? input.question.trim() : "";
    const answer = typeof input.answer === "string" ? input.answer.trim() : "";
    if (!id)
        throw new Error("Missing dynamic question id");
    if (!question)
        throw new Error("Missing dynamic question");
    if (!answer)
        throw new Error("Answer is empty");
    const items = readLane(userId, sessionId);
    const next = [...items.filter((i) => i.id !== id), { id, question, answer }];
    writeLane(userId, sessionId, next);
    return buildState(userId, next);
}
