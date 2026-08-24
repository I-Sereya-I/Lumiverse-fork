import { join } from "path";
export const LUMIHUB_PROTOCOL_VERSION = 2;
export const PRESET_REGEX_VERSIONING_CAPABILITY = "preset_regex_versioning_v1";
export const LUMIHUB_CAPABILITIES = Object.freeze([
    "character_import",
    "chub_import",
    "worldbook_import",
    "theme_import",
    "preset_import",
    "manifest_sync",
    "stats_sync",
    PRESET_REGEX_VERSIONING_CAPABILITY,
]);
export function createLumiHubInstanceInfo(versions) {
    return {
        version: versions.backendVersion,
        protocolVersion: LUMIHUB_PROTOCOL_VERSION,
        backendVersion: versions.backendVersion,
        frontendVersion: versions.frontendVersion,
        capabilities: LUMIHUB_CAPABILITIES,
    };
}
async function readPackageVersion(path) {
    try {
        const raw = await Bun.file(path).text();
        const parsed = JSON.parse(raw);
        return typeof parsed.version === "string" && parsed.version.trim()
            ? parsed.version.trim()
            : "unknown";
    }
    catch {
        return "unknown";
    }
}
let cachedInfo = null;
/** Report the two independently deployed app surfaces, not a hard-coded protocol version. */
export function getLumiHubInstanceInfo() {
    cachedInfo ??= Promise.all([
        readPackageVersion(join(import.meta.dir, "../../package.json")),
        readPackageVersion(join(import.meta.dir, "../../frontend/package.json")),
    ]).then(([backendVersion, frontendVersion]) => createLumiHubInstanceInfo({
        backendVersion,
        frontendVersion,
    }));
    return cachedInfo;
}
