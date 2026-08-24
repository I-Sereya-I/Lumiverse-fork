import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
initDatabase(":memory:");
const { stMigrationRoutes } = await import("./st-migration.routes");
function createApp() {
    const app = new Hono();
    app.use("*", async (c, next) => {
        const role = c.req.header("x-test-role");
        if (role) {
            const userId = c.req.header("x-test-user") ?? "caller";
            c.set("userId", userId);
            c.set("session", { user: { id: userId, role }, session: {} });
        }
        await next();
    });
    app.route("/st-migration", stMigrationRoutes);
    return app;
}
const app = createApp();
const executeUrl = "http://localhost/st-migration/execute";
const objectBodyUrls = [
    "http://localhost/st-migration/test-connection",
    "http://localhost/st-migration/validate",
    "http://localhost/st-migration/scan",
    executeUrl,
];
const ownerHeaders = { "content-type": "application/json", "x-test-role": "owner", "x-test-user": "owner-a" };
beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run('CREATE TABLE "user" (id TEXT PRIMARY KEY, role TEXT NOT NULL)');
    getDb().run('INSERT INTO "user" (id, role) VALUES (?, ?), (?, ?)', ["owner-a", "owner", "user-a", "user"]);
});
afterEach(() => closeDatabase());
describe("SillyTavern migration route security", () => {
    test("requires an authenticated owner or admin", async () => {
        const anonymous = await app.request(executeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(anonymous.status).toBe(401);
        expect(await anonymous.json()).toEqual({ error: "Unauthorized" });
        const user = await app.request(executeUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-role": "user", "x-test-user": "user-a" },
            body: "{}",
        });
        expect(user.status).toBe(403);
        expect(await user.json()).toEqual({ error: "Forbidden" });
    });
    test("returns controlled 400 responses for malformed JSON and body shapes", async () => {
        for (const url of objectBodyUrls) {
            const malformed = await app.request(url, { method: "POST", headers: ownerHeaders, body: "{" });
            expect(malformed.status).toBe(400);
            expect(await malformed.json()).toEqual({ error: "Invalid JSON body" });
            const arrayBody = await app.request(url, { method: "POST", headers: ownerHeaders, body: "[]" });
            expect(arrayBody.status).toBe(400);
            expect(await arrayBody.json()).toEqual({ error: "JSON body must be an object" });
        }
        const malformedScope = await app.request(executeUrl, {
            method: "POST",
            headers: ownerHeaders,
            body: JSON.stringify({ dataDir: process.cwd(), targetUserId: "owner-a", scope: "connections" }),
        });
        expect(malformedScope.status).toBe(400);
        expect(await malformedScope.json()).toEqual({ error: "scope is required" });
    });
    test("prevents admins from targeting privileged accounts", async () => {
        const response = await app.request(executeUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-role": "admin", "x-test-user": "admin-a" },
            body: JSON.stringify({ dataDir: process.cwd(), targetUserId: "owner-a", scope: { connections: true } }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Admins can only migrate to their own account or user-role accounts" });
    });
    test("does not reflect secret-bearing malformed input in responses", async () => {
        const secret = "route-secret-must-not-leak";
        const response = await app.request(executeUrl, {
            method: "POST",
            headers: ownerHeaders,
            body: JSON.stringify({ dataDir: "Z:/definitely-missing", targetUserId: "owner-a", scope: { connections: true }, password: secret }),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(secret);
    });
});
