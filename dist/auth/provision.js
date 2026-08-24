import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { env } from "../env";
// BetterAuth's default generator produces 32-char alphanumeric IDs; our
// owner-seed path uses crypto.randomUUID(). Accept both shapes (plus nanoid)
// by allowing URL-safe characters only. Critically, `.`, `/`, and `\` are
// rejected so a corrupt row can never escape the per-user data dir via
// path.join (which doesn't strip "..").
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
// Extension identifiers are validated separately at install time
// (lumiverse-spindle-types.validateIdentifier), but defend the path call
// anyway so a bug elsewhere can't leak into a traversal.
const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
function assertUserId(userId) {
    if (!USER_ID_PATTERN.test(userId)) {
        throw new Error("Invalid user id");
    }
}
function assertExtensionIdentifier(identifier) {
    if (!EXTENSION_ID_PATTERN.test(identifier)) {
        throw new Error("Invalid extension identifier");
    }
}
export function provisionUserDirectories(userId) {
    assertUserId(userId);
    const userDir = getUserBaseDir(userId);
    const storagePath = join(userDir, "storage");
    const extensionsPath = join(userDir, "extensions");
    if (!existsSync(storagePath))
        mkdirSync(storagePath, { recursive: true });
    if (!existsSync(extensionsPath))
        mkdirSync(extensionsPath, { recursive: true });
}
export function getUserBaseDir(userId) {
    assertUserId(userId);
    return join(env.dataDir, "users", userId);
}
export function getUserStoragePath(userId) {
    return join(getUserBaseDir(userId), "storage");
}
export function getUserExtensionPath(userId, identifier) {
    assertExtensionIdentifier(identifier);
    return join(getUserBaseDir(userId), "extensions", identifier);
}
