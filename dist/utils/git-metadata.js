import { join } from "path";
const PROJECT_ROOT = join(import.meta.dir, "../..");
const GIT_METADATA_CACHE_MS = 30_000;
const GIT_MISSING_METADATA_CACHE_MS = 5 * 60_000;
let cachedGitMetadata = null;
function runGit(projectRoot, ...args) {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}
export function getGitMetadata(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedGitMetadata && cachedGitMetadata.expiresAt > now) {
        return cachedGitMetadata.value;
    }
    const inWorkTree = runGit(PROJECT_ROOT, "rev-parse", "--is-inside-work-tree") === "true";
    const value = inWorkTree
        ? {
            branch: runGit(PROJECT_ROOT, "rev-parse", "--abbrev-ref", "HEAD") || "unknown",
            commit: runGit(PROJECT_ROOT, "rev-parse", "--short", "HEAD") || "unknown",
            inWorkTree: true,
        }
        : {
            branch: "unknown",
            commit: "unknown",
            inWorkTree: false,
        };
    cachedGitMetadata = {
        value,
        expiresAt: now + (inWorkTree ? GIT_METADATA_CACHE_MS : GIT_MISSING_METADATA_CACHE_MS),
    };
    return value;
}
