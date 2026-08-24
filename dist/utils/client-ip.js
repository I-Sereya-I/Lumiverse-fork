import { getConnInfo } from "hono/bun";
import { env } from "../env";
function stripQuotes(value) {
    return value.replace(/^"|"$/g, "");
}
function normalizeIpToken(raw) {
    if (!raw)
        return null;
    let value = stripQuotes(String(raw).trim());
    if (!value || /^unknown$/i.test(value))
        return null;
    if (/^for=/i.test(value)) {
        value = stripQuotes(value.slice(4).trim());
    }
    if (value.startsWith("[")) {
        const close = value.indexOf("]");
        if (close > 0) {
            value = value.slice(1, close);
        }
    }
    else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
        value = value.slice(0, value.lastIndexOf(":"));
    }
    if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(value)) {
        value = value.slice(7);
    }
    const lower = value.toLowerCase();
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower);
    const isIpv6 = /^[0-9a-f:]+$/i.test(lower) && lower.includes(":");
    return isIpv4 || isIpv6 ? lower : null;
}
function parseIpv4(ip) {
    const parts = ip.split(".");
    if (parts.length !== 4)
        return null;
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part))
            return null;
        const octet = Number.parseInt(part, 10);
        if (octet > 255)
            return null;
        value = (value << 8n) | BigInt(octet);
    }
    return { family: 4, value };
}
function splitIpv6Groups(segment) {
    if (!segment)
        return [];
    const groups = [];
    for (const group of segment.split(":")) {
        if (!/^[0-9a-f]{1,4}$/.test(group))
            return null;
        groups.push(BigInt(`0x${group}`));
    }
    return groups;
}
function parseIpv6(ip) {
    // Expand an embedded IPv4 tail (::ffff:1.2.3.4 and friends) into hex groups.
    const lastColon = ip.lastIndexOf(":");
    if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
        const v4 = parseIpv4(ip.slice(lastColon + 1));
        if (!v4)
            return null;
        const hi = (v4.value >> 16n).toString(16);
        const lo = (v4.value & 0xffffn).toString(16);
        ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
    let groups;
    if (ip.includes("::")) {
        const halves = ip.split("::");
        if (halves.length !== 2)
            return null; // "::" may appear at most once
        const head = splitIpv6Groups(halves[0]);
        const tail = splitIpv6Groups(halves[1]);
        if (!head || !tail)
            return null;
        const fill = 8 - head.length - tail.length;
        if (fill < 0)
            return null;
        groups = [...head, ...Array(fill).fill(0n), ...tail];
    }
    else {
        const all = splitIpv6Groups(ip);
        if (!all || all.length !== 8)
            return null;
        groups = all;
    }
    // IPv4-mapped (::ffff:0:0/96) normalizes to plain IPv4 so "::ffff:10.0.0.1"
    // and "10.0.0.1" match the same rules.
    if (groups.slice(0, 5).every((g) => g === 0n) && groups[5] === 0xffffn) {
        return { family: 4, value: (groups[6] << 16n) | groups[7] };
    }
    let value = 0n;
    for (const group of groups)
        value = (value << 16n) | group;
    return { family: 6, value };
}
export function parseIp(ip) {
    const value = ip.trim().toLowerCase();
    if (!value)
        return null;
    return value.includes(":") ? parseIpv6(value) : parseIpv4(value);
}
export function parseCidrRule(entry) {
    const slash = entry.indexOf("/");
    const ipPart = slash === -1 ? entry : entry.slice(0, slash);
    const parsed = parseIp(ipPart);
    if (!parsed)
        return null;
    const totalBits = parsed.family === 4 ? 32 : 128;
    let prefixBits = totalBits;
    if (slash !== -1) {
        const maskRaw = entry.slice(slash + 1);
        if (!/^\d{1,3}$/.test(maskRaw))
            return null;
        prefixBits = Number.parseInt(maskRaw, 10);
        if (prefixBits > totalBits)
            return null;
    }
    // Zero the host bits (shift down) so "10.0.0.1/8" and "10.0.0.0/8" behave
    // identically; matching shifts candidate IPs the same way before comparing.
    const shift = BigInt(totalBits - prefixBits);
    return {
        family: parsed.family,
        network: parsed.value >> shift,
        prefixBits,
        totalBits,
    };
}
export function ipMatchesRule(ip, rule) {
    const parsed = parseIp(ip);
    if (!parsed || parsed.family !== rule.family)
        return false;
    const shift = BigInt(rule.totalBits - rule.prefixBits);
    return parsed.value >> shift === rule.network;
}
// --- Forwarded-header parsing -------------------------------------------------
function collectForwardedHeader(value) {
    if (!value)
        return [];
    const out = [];
    for (const part of value.split(",")) {
        for (const token of part.split(";")) {
            const [key, ...rest] = token.split("=");
            if (key?.trim().toLowerCase() !== "for")
                continue;
            const candidate = normalizeIpToken(rest.join("="));
            if (candidate)
                out.push(candidate);
        }
    }
    return out;
}
function collectXForwardedFor(value) {
    if (!value)
        return [];
    const out = [];
    for (const part of value.split(",")) {
        const candidate = normalizeIpToken(part);
        if (candidate)
            out.push(candidate);
    }
    return out;
}
/**
 * Pick the originating client from a forwarded-IP chain. Each proxy appends
 * the address it received the connection from, so entries are read
 * right-to-left: skip addresses that belong to our trusted proxies and take
 * the first one that doesn't. Leftmost parsing would let any client pre-seed
 * X-Forwarded-For and pick its own apparent IP (rate-limit/lockout evasion),
 * since nginx's $proxy_add_x_forwarded_for APPENDS to the incoming value.
 * If every entry is a trusted proxy, the chain originated inside our own
 * proxy layer and the leftmost entry is the closest thing to an origin.
 */
export function selectForwardedClientIp(values, isTrustedProxy) {
    for (let i = values.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(values[i]))
            return values[i];
    }
    return values[0] ?? null;
}
// --- Trust decision ------------------------------------------------------------
function isPrivateIpv4(ip) {
    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
        return false;
    }
    if (parts[0] === 10 || parts[0] === 127)
        return true;
    if (parts[0] === 192 && parts[1] === 168)
        return true;
    if (parts[0] === 169 && parts[1] === 254)
        return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        return true;
    return false;
}
function isPrivateIpv6(ip) {
    return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
}
let cachedProxyRules;
function getTrustedProxyRules() {
    if (cachedProxyRules !== undefined)
        return cachedProxyRules;
    const entries = env.trustedProxies;
    if (entries.length === 0) {
        cachedProxyRules = null;
        return null;
    }
    const rules = [];
    for (const entry of entries) {
        const rule = parseCidrRule(entry);
        if (rule) {
            rules.push(rule);
        }
        else {
            console.warn(`[client-ip] Ignoring invalid TRUSTED_PROXIES entry "${entry}"`);
        }
    }
    cachedProxyRules = rules;
    return rules;
}
function isPrivatePeer(ip) {
    return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}
export function getConnectionIp(c) {
    try {
        return normalizeIpToken(getConnInfo(c).remote.address ?? null);
    }
    catch {
        return null;
    }
}
export function getClientIp(c) {
    const remoteIp = getConnectionIp(c);
    if (!remoteIp)
        return "unknown";
    // Forwarded headers are honored only when the DIRECT peer is a trusted
    // proxy. With TRUSTED_PROXIES set that's a strict allowlist (public cloud
    // proxies included); unset, it falls back to the legacy private-network
    // heuristic for LAN reverse proxies.
    const rules = getTrustedProxyRules();
    const trustedByList = rules ? (ip) => rules.some((rule) => ipMatchesRule(ip, rule)) : null;
    const peerTrusted = trustedByList ? trustedByList(remoteIp) : isPrivatePeer(remoteIp);
    if (!peerTrusted)
        return remoteIp;
    // Legacy heuristic knows only the immediate peer, so "trusted proxy" in the
    // chain is nobody — selectForwardedClientIp then takes the rightmost entry,
    // which is exactly the address that peer appended. Explicit-list mode walks
    // past multi-layer proxy chains.
    const isTrustedProxy = trustedByList ?? (() => false);
    const chain = collectForwardedHeader(c.req.header("forwarded")) ||
        collectXForwardedFor(c.req.header("x-forwarded-for"));
    const selected = selectForwardedClientIp(chain, isTrustedProxy) ??
        normalizeIpToken(c.req.header("x-real-ip"));
    return selected ?? remoteIp;
}
