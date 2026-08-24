import * as settingsSvc from "../services/settings.service";
const TRAILING_NEWLINE_RUN_RE = /(?:\n[ \t\f\v]*)+$/;
const LEADING_NEWLINE_RUN_RE = /^(?:[ \t\f\v]*\n)+/;
function countNewlines(value) {
    return value.match(/\n/g)?.length ?? 0;
}
function hasVisibleText(value) {
    return /\S/.test(value);
}
function getTrailingNewlineRunCount(value) {
    const match = value.match(TRAILING_NEWLINE_RUN_RE);
    return match ? countNewlines(match[0]) : 0;
}
function joinContentAroundExtractedReasoning(before, after) {
    const beforeMatch = before.match(TRAILING_NEWLINE_RUN_RE);
    const afterMatch = after.match(LEADING_NEWLINE_RUN_RE);
    if (!beforeMatch && !afterMatch)
        return before + after;
    const beforeBody = beforeMatch ? before.slice(0, before.length - beforeMatch[0].length) : before;
    const afterBody = afterMatch ? after.slice(afterMatch[0].length) : after;
    const hasVisibleBefore = hasVisibleText(beforeBody);
    const hasVisibleAfter = hasVisibleText(afterBody);
    if (beforeMatch && afterMatch) {
        const preservedNewlines = hasVisibleBefore && hasVisibleAfter
            ? Math.max(countNewlines(beforeMatch[0]), countNewlines(afterMatch[0]))
            : 0;
        return beforeBody + "\n".repeat(preservedNewlines) + afterBody;
    }
    if (beforeMatch && !hasVisibleAfter) {
        return beforeBody;
    }
    if (afterMatch && !hasVisibleBefore) {
        return afterBody;
    }
    return before + after;
}
function normalizeLeadingContentAfterReasoningBoundary(content, opts) {
    const match = content.match(LEADING_NEWLINE_RUN_RE);
    if (!match)
        return content;
    const remainder = content.slice(match[0].length);
    if (!opts.hasVisibleContentBefore) {
        return remainder;
    }
    if (opts.trailingNewlineRun === 0) {
        return content;
    }
    const keptNewlines = Math.max(countNewlines(match[0]) - opts.trailingNewlineRun, 0);
    return "\n".repeat(keptNewlines) + remainder;
}
export function normalizeReasoningDelimiter(value, fallback) {
    return (typeof value === "string" ? value : fallback).replace(/^\n+|\n+$/g, "");
}
export function resolveReasoningDelimiters(value) {
    return {
        prefix: normalizeReasoningDelimiter(value?.prefix, "<think>\n"),
        suffix: normalizeReasoningDelimiter(value?.suffix, "\n</think>"),
    };
}
export function hasReasoningDelimiters(delimiters) {
    return !!(delimiters.prefix && delimiters.suffix);
}
export function closeUnterminatedDelimitedReasoning(content, delimiters) {
    if (!content || !hasReasoningDelimiters(delimiters))
        return content;
    const lastOpenIdx = content.lastIndexOf(delimiters.prefix);
    if (lastOpenIdx === -1)
        return content;
    const afterOpen = content.indexOf(delimiters.suffix, lastOpenIdx + delimiters.prefix.length);
    return afterOpen === -1 ? content + delimiters.suffix : content;
}
export function extractDelimitedReasoning(content, delimiters) {
    if (!content || !hasReasoningDelimiters(delimiters) || !content.includes(delimiters.prefix)) {
        return { cleaned: content, reasoning: "" };
    }
    let cleaned = content;
    let reasoning = "";
    let idx = cleaned.indexOf(delimiters.prefix);
    while (idx !== -1) {
        const endIdx = cleaned.indexOf(delimiters.suffix, idx + delimiters.prefix.length);
        if (endIdx !== -1) {
            reasoning += cleaned.slice(idx + delimiters.prefix.length, endIdx);
            cleaned = joinContentAroundExtractedReasoning(cleaned.slice(0, idx), cleaned.slice(endIdx + delimiters.suffix.length));
        }
        else {
            reasoning += cleaned.slice(idx + delimiters.prefix.length);
            cleaned = joinContentAroundExtractedReasoning(cleaned.slice(0, idx), "");
            break;
        }
        idx = cleaned.indexOf(delimiters.prefix);
    }
    return { cleaned, reasoning };
}
export function separateDelimitedReasoning(content, existingReasoning, delimiters, enabled) {
    if (!enabled)
        return { content, reasoning: existingReasoning || undefined };
    const extracted = extractDelimitedReasoning(content, delimiters);
    const mergedReasoning = [existingReasoning, extracted.reasoning]
        .filter((value) => !!value)
        .join("\n");
    return {
        content: extracted.cleaned,
        reasoning: mergedReasoning || undefined,
    };
}
export class GuidedReasoningStreamParser {
    delimiters;
    enabled;
    phase;
    detectBuffer = "";
    suffixBuffer = "";
    hasVisibleContent = false;
    trailingNewlineRun = 0;
    pendingContentAfterReasoningBoundary = false;
    constructor(delimiters, enabled) {
        this.delimiters = delimiters;
        this.enabled = enabled && hasReasoningDelimiters(delimiters);
        this.phase = this.enabled ? "detecting" : "content";
    }
    trackEmittedContent(text) {
        if (!text)
            return;
        if (hasVisibleText(text)) {
            this.hasVisibleContent = true;
        }
        const trailingRun = getTrailingNewlineRunCount(text);
        if (trailingRun > 0) {
            this.trailingNewlineRun = trailingRun;
            return;
        }
        if (hasVisibleText(text) || text.includes("\n")) {
            this.trailingNewlineRun = 0;
        }
    }
    push(token) {
        if (!token)
            return { content: "", reasoning: "" };
        if (!this.enabled)
            return { content: token, reasoning: "" };
        let content = "";
        let reasoning = "";
        const emitContent = (text) => {
            if (!text)
                return;
            const normalized = this.pendingContentAfterReasoningBoundary
                ? normalizeLeadingContentAfterReasoningBoundary(text, {
                    hasVisibleContentBefore: this.hasVisibleContent,
                    trailingNewlineRun: this.trailingNewlineRun,
                })
                : text;
            this.pendingContentAfterReasoningBoundary = false;
            if (!normalized)
                return;
            content += normalized;
            this.trackEmittedContent(normalized);
        };
        const emitReasoning = (text) => { reasoning += text; };
        const processReasoningChunk = (chunk) => {
            this.suffixBuffer += chunk;
            const suffixIdx = this.suffixBuffer.indexOf(this.delimiters.suffix);
            if (suffixIdx !== -1) {
                emitReasoning(this.suffixBuffer.slice(0, suffixIdx));
                const afterSuffix = this.suffixBuffer.slice(suffixIdx + this.delimiters.suffix.length);
                this.phase = "content";
                this.suffixBuffer = "";
                this.pendingContentAfterReasoningBoundary = true;
                if (afterSuffix)
                    emitContent(afterSuffix);
                return;
            }
            const safe = this.suffixBuffer.length - Math.max(this.delimiters.suffix.length - 1, 0);
            if (safe > 0) {
                emitReasoning(this.suffixBuffer.slice(0, safe));
                this.suffixBuffer = this.suffixBuffer.slice(safe);
            }
        };
        const processContentChunk = (chunk) => {
            if (this.phase === "content") {
                this.detectBuffer += chunk;
                const prefixIdx = this.detectBuffer.indexOf(this.delimiters.prefix);
                if (prefixIdx !== -1) {
                    if (prefixIdx > 0)
                        emitContent(this.detectBuffer.slice(0, prefixIdx));
                    this.phase = "reasoning";
                    const afterPrefix = this.detectBuffer.slice(prefixIdx + this.delimiters.prefix.length);
                    this.detectBuffer = "";
                    if (afterPrefix)
                        processReasoningChunk(afterPrefix);
                    return;
                }
                let partialLen = Math.min(this.detectBuffer.length, this.delimiters.prefix.length - 1);
                while (partialLen > 0) {
                    if (this.delimiters.prefix.startsWith(this.detectBuffer.slice(-partialLen)))
                        break;
                    partialLen--;
                }
                const safeLen = this.detectBuffer.length - partialLen;
                if (safeLen > 0) {
                    emitContent(this.detectBuffer.slice(0, safeLen));
                    this.detectBuffer = this.detectBuffer.slice(safeLen);
                }
                return;
            }
            if (this.phase === "detecting") {
                this.detectBuffer += chunk;
                const trimmed = this.detectBuffer.trimStart();
                if (trimmed.length >= this.delimiters.prefix.length && trimmed.startsWith(this.delimiters.prefix)) {
                    this.phase = "reasoning";
                    const afterPrefix = trimmed.slice(this.delimiters.prefix.length);
                    this.detectBuffer = "";
                    if (afterPrefix)
                        processReasoningChunk(afterPrefix);
                }
                else if (!this.delimiters.prefix.startsWith(trimmed)) {
                    this.phase = "content";
                    const buffer = this.detectBuffer;
                    this.detectBuffer = "";
                    processContentChunk(buffer);
                }
                return;
            }
            processReasoningChunk(chunk);
        };
        processContentChunk(token);
        return { content, reasoning };
    }
    flush() {
        if (!this.enabled)
            return { content: "", reasoning: "" };
        let content = "";
        let reasoning = "";
        if (this.detectBuffer) {
            if (this.phase === "reasoning")
                reasoning += this.detectBuffer;
            else {
                const normalized = this.pendingContentAfterReasoningBoundary
                    ? normalizeLeadingContentAfterReasoningBoundary(this.detectBuffer, {
                        hasVisibleContentBefore: this.hasVisibleContent,
                        trailingNewlineRun: this.trailingNewlineRun,
                    })
                    : this.detectBuffer;
                if (normalized) {
                    content += normalized;
                    this.trackEmittedContent(normalized);
                }
            }
            this.detectBuffer = "";
        }
        if (this.phase === "reasoning" && this.suffixBuffer) {
            reasoning += this.suffixBuffer;
            this.suffixBuffer = "";
        }
        this.pendingContentAfterReasoningBoundary = false;
        this.phase = "content";
        return { content, reasoning };
    }
}
export async function* wrapDelimitedReasoningStream(stream, delimiters, enabled) {
    if (!enabled || !hasReasoningDelimiters(delimiters)) {
        yield* stream;
        return;
    }
    const parser = new GuidedReasoningStreamParser(delimiters, true);
    let trailingChunk = null;
    for await (const chunk of stream) {
        const parsed = parser.push(chunk.token || "");
        const reasoning = [parsed.reasoning, chunk.reasoning]
            .filter((value) => !!value)
            .join("");
        if (parsed.content || reasoning || chunk.usage || chunk.tool_calls) {
            yield {
                token: parsed.content,
                ...(reasoning ? { reasoning } : {}),
                ...(chunk.usage ? { usage: chunk.usage } : {}),
                ...(chunk.tool_calls ? { tool_calls: chunk.tool_calls } : {}),
            };
        }
        if (chunk.finish_reason) {
            trailingChunk = {
                finish_reason: chunk.finish_reason,
            };
        }
    }
    const flushed = parser.flush();
    if (flushed.content || flushed.reasoning) {
        yield {
            token: flushed.content,
            ...(flushed.reasoning ? { reasoning: flushed.reasoning } : {}),
        };
    }
    if (trailingChunk) {
        yield {
            token: "",
            ...trailingChunk,
        };
    }
}
/**
 * Resolve the user's configured reasoning prefix/suffix so callers can strip
 * custom CoT delimiters from content before it enters chat chunks, retrieval
 * queries, or Memory Cortex. Returns undefined when the user hasn't configured
 * any reasoning settings — the default `<think>` tags are already covered by
 * `sanitizeForVectorization`.
 */
export function getReasoningStripOptions(userId) {
    const setting = settingsSvc.getSetting(userId, "reasoningSettings");
    const value = setting?.value;
    if (!value)
        return undefined;
    const delimiters = resolveReasoningDelimiters(value);
    if (!hasReasoningDelimiters(delimiters))
        return undefined;
    return { reasoningPrefix: delimiters.prefix, reasoningSuffix: delimiters.suffix };
}
