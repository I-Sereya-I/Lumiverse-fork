import { isAbsolute, relative, resolve } from "path";
const TERMUX_PATH_PREFIX = "/data/data/com.termux/";
function isTermuxEnvironment(dbPath, env) {
    return Boolean(env.TERMUX_VERSION)
        || env.LUMIVERSE_IS_TERMUX === "true"
        || env.LUMIVERSE_IS_PROOT === "true"
        || env.PREFIX?.startsWith(TERMUX_PATH_PREFIX)
        || env.HOME?.startsWith(`${TERMUX_PATH_PREFIX}files/home`)
        || dbPath.startsWith(TERMUX_PATH_PREFIX);
}
function isRelativePath(path) {
    return !!path && path !== "." && !isAbsolute(path);
}
function isBrokenRootRelativeTermuxPath(path) {
    return path.startsWith("data/data/com.termux/");
}
export function resolveLanceDbConnectUri(dbPath, options = {}) {
    if (!isAbsolute(dbPath))
        return dbPath;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    // Work around the current LanceDB Rust SDK bug that strips the leading slash
    // from absolute local paths, which breaks Termux installs under /data/data/...
    const runningInTermux = isTermuxEnvironment(dbPath, env);
    if (!runningInTermux)
        return dbPath;
    const relativePath = relative(cwd, dbPath);
    // If CWD is /, path.relative() turns /data/data/... into data/data/...
    // which is exactly the broken shape LanceDB/Rust reports on Termux. In that
    // case keep the absolute path rather than creating the bad URI ourselves.
    if (isBrokenRootRelativeTermuxPath(relativePath))
        return dbPath;
    return isRelativePath(relativePath) ? relativePath : dbPath;
}
export function resolveBrokenTermuxLanceDbMirrorPath(dbPath, options = {}) {
    if (!isAbsolute(dbPath))
        return null;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    if (!isTermuxEnvironment(dbPath, env))
        return null;
    const connectUri = resolveLanceDbConnectUri(dbPath, { cwd, env });
    if (connectUri === dbPath)
        return null;
    const brokenPath = resolve(cwd, dbPath.replace(/^\/+/, ""));
    return brokenPath === dbPath ? null : brokenPath;
}
