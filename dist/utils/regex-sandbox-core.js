import { getRegexSearchEnd } from "./regex-search-window";
/**
 * Apply the capture-reference syntax used by raw-mode regex scripts.
 *
 * Keep this separate from native String#replace semantics: raw mode has long
 * exposed this exact contract (notably, capture references are limited to two
 * digits and an out-of-range reference is left untouched).
 */
export function substituteRegexCaptures(template, fullMatch, groups, offset, input, namedGroups) {
    return substituteRegexCapturesFromArrayLike(template, fullMatch, groups, 0, offset, input, namedGroups);
}
function substituteRegexCapturesFromArrayLike(template, fullMatch, groups, groupOffset, offset, input, namedGroups) {
    const groupCount = groups.length - groupOffset;
    return template.replace(/\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g, (token, dollar, amp, backtick, quote, digits, name) => {
        if (dollar !== undefined)
            return "$";
        if (amp !== undefined)
            return fullMatch;
        if (backtick !== undefined)
            return input.slice(0, offset);
        if (quote !== undefined)
            return input.slice(offset + fullMatch.length);
        if (digits !== undefined) {
            const idx = parseInt(digits, 10);
            if (idx >= 1 && idx <= groupCount)
                return groups[idx - 1 + groupOffset] ?? "";
            return token;
        }
        if (name !== undefined && namedGroups) {
            // A name defined by the pattern but absent from this match substitutes
            // empty (native String#replace semantics). Only a name the pattern does
            // not define at all is left untouched, so typos still surface.
            if (Object.prototype.hasOwnProperty.call(namedGroups, name))
                return namedGroups[name] ?? "";
            return token;
        }
        return token;
    });
}
function collectMatches(input, re) {
    const matches = [];
    if (re.global || re.sticky) {
        let match;
        while ((match = re.exec(input)) !== null) {
            matches.push({
                fullMatch: match[0],
                index: match.index,
                groups: Array.from(match).slice(1),
                namedGroups: match.groups,
            });
            if (match[0].length === 0)
                re.lastIndex++;
        }
    }
    else {
        const match = re.exec(input);
        if (match) {
            matches.push({
                fullMatch: match[0],
                index: match.index,
                groups: Array.from(match).slice(1),
                namedGroups: match.groups,
            });
        }
    }
    return matches;
}
/**
 * Resolve capture references before crossing the worker boundary. Returning
 * only the replacement and match span avoids structured-cloning every capture
 * (often hundreds of strings per match) into the main process.
 */
function collectCaptureReplacements(input, re, template) {
    const replacements = [];
    const append = (match) => {
        replacements.push({
            index: match.index,
            matchLength: match[0].length,
            replacement: substituteRegexCapturesFromArrayLike(template, match[0], match, 1, match.index, input, match.groups),
        });
    };
    if (re.global || re.sticky) {
        let match;
        while ((match = re.exec(input)) !== null) {
            append(match);
            if (match[0].length === 0)
                re.lastIndex++;
        }
    }
    else {
        const match = re.exec(input);
        if (match)
            append(match);
    }
    return replacements;
}
export function runRegexRequest(data) {
    const replacement = "replacement" in data ? data.replacement : "";
    const searchEnd = getRegexSearchEnd(data.input, data.pattern, data.flags, replacement);
    const input = searchEnd === data.input.length ? data.input : data.input.slice(0, searchEnd);
    const tail = searchEnd === data.input.length ? "" : data.input.slice(searchEnd);
    const re = new RegExp(data.pattern, data.flags);
    if (data.op === "replace") {
        return input.replace(re, data.replacement) + tail;
    }
    if (data.op === "test") {
        let matches = 0;
        const counter = new RegExp(re.source, re.flags);
        input.replace(counter, (...args) => {
            matches++;
            return String(args[0] ?? "");
        });
        const result = input.replace(re, data.replacement) + tail;
        return { result, matches };
    }
    if (data.op === "collect") {
        return collectMatches(input, re);
    }
    if (data.op === "capture-replacements") {
        return collectCaptureReplacements(input, re, data.replacement);
    }
    throw new Error(`Unknown regex op: ${data.op}`);
}
