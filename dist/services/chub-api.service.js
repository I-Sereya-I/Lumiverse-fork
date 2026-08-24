import { safeFetch } from "../utils/safe-fetch";
const CHUB_API_BASES = ["https://gateway.chub.ai/api", "https://api.chub.ai/api"];
export async function fetchChubJson(path) {
    let lastStatus = 0;
    for (const base of CHUB_API_BASES) {
        const res = await safeFetch(`${base}/${path}`, {
            timeoutMs: 15_000,
            maxBytes: 100 * 1024 * 1024,
            headers: { Accept: "application/json", "User-Agent": "Lumiverse" },
        });
        if (res.ok)
            return await res.json();
        lastStatus = res.status;
    }
    throw new Error(`Chub API returned ${lastStatus || "no response"}`);
}
export function extractChubGalleryUrls(data) {
    const nodes = Array.isArray(data?.nodes)
        ? data.nodes
        : [];
    const seen = new Set();
    const urls = [];
    for (const node of nodes) {
        if (!node || typeof node !== "object")
            continue;
        const candidate = typeof node.primary_image_path === "string"
            ? node.primary_image_path
            : typeof node.image_path === "string"
                ? node.image_path
                : typeof node.url === "string"
                    ? node.url
                    : null;
        if (!candidate || seen.has(candidate))
            continue;
        seen.add(candidate);
        urls.push(candidate);
    }
    return urls;
}
export async function fetchChubGalleryUrls(projectId) {
    if (!projectId)
        return [];
    try {
        const data = await fetchChubJson(`gallery/project/${projectId}`);
        return extractChubGalleryUrls(data);
    }
    catch {
        return [];
    }
}
