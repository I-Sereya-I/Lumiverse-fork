import { isOwnGitRepositoryPathAsync } from "./git-repository";
import { spawnAsync } from "./spawn-async";
const GIT_UPDATE_CHECK_TIMEOUT_MS = 15_000;
function gitEnvironment() {
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
    };
}
async function runGit(repo, args) {
    return spawnAsync(["git", ...args], {
        cwd: repo,
        timeoutMs: GIT_UPDATE_CHECK_TIMEOUT_MS,
        env: gitEnvironment(),
    });
}
function firstLine(value) {
    return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
/**
 * Read-only remote comparison used by both the monitor and its focused tests.
 * `git ls-remote` avoids changing the extension worktree or its remote refs.
 */
export async function probeGitRepositoryForUpdate(repo, preferredBranch) {
    if (!(await isOwnGitRepositoryPathAsync(repo))) {
        return { status: "skipped", reason: "not-own-git-repository" };
    }
    const localResult = await runGit(repo, ["rev-parse", "HEAD"]);
    if (localResult.exitCode !== 0) {
        return { status: "unavailable", reason: "unable-to-read-local-head" };
    }
    const localCommit = firstLine(localResult.stdout);
    if (!localCommit) {
        return { status: "unavailable", reason: "empty-local-head" };
    }
    const branchResult = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const currentBranch = branchResult.exitCode === 0 ? firstLine(branchResult.stdout) : "";
    const branch = currentBranch && currentBranch !== "HEAD"
        ? currentBranch
        : (preferredBranch?.trim() ?? "");
    if (!branch) {
        return { status: "skipped", reason: "detached-head-without-branch" };
    }
    const remoteResult = await runGit(repo, [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${branch}`,
    ]);
    if (remoteResult.exitCode !== 0) {
        return {
            status: "unavailable",
            reason: remoteResult.timedOut ? "remote-check-timed-out" : "remote-check-failed",
        };
    }
    const remoteLine = remoteResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.endsWith(`refs/heads/${branch}`));
    const remoteCommit = remoteLine?.split(/\s+/, 1)[0]?.trim() ?? "";
    if (!remoteCommit) {
        return { status: "unavailable", reason: "remote-branch-not-found" };
    }
    return {
        status: remoteCommit === localCommit ? "current" : "update",
        branch,
        localCommit,
        remoteCommit,
    };
}
