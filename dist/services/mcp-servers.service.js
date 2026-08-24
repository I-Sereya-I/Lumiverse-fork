import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secretsSvc from "./secrets.service";
import { paginatedQuery } from "./pagination";
/** Secret key for a server's encrypted headers. */
export function mcpServerHeadersKey(id) {
    return `mcp_server_${id}_headers`;
}
/** Secret key for a server's encrypted stdio env values. */
export function mcpServerEnvKey(id) {
    return `mcp_server_${id}_env`;
}
function rowToProfile(row) {
    return {
        ...row,
        is_enabled: !!row.is_enabled,
        auto_connect: !!row.auto_connect,
        has_headers: !!row.has_headers,
        args: JSON.parse(row.args || "[]"),
        env: JSON.parse(row.env || "{}"),
        metadata: JSON.parse(row.metadata || "{}"),
    };
}
export function listServers(userId, pagination) {
    return paginatedQuery("SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY updated_at DESC", "SELECT COUNT(*) as count FROM mcp_servers WHERE user_id = ?", [userId], pagination, rowToProfile);
}
export function getServer(userId, id) {
    const row = getDb()
        .query("SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?")
        .get(id, userId);
    return row ? rowToProfile(row) : null;
}
/** Keep an MCP profile editable when its encrypted headers/env no longer decrypt. */
export async function withReadableMcpSecretStatus(userId, profile) {
    const hasEnv = Object.keys(profile.env).length > 0;
    const [headers, envValues] = await Promise.all([
        profile.has_headers
            ? secretsSvc.getSecretForStatus(userId, mcpServerHeadersKey(profile.id))
            : Promise.resolve(null),
        hasEnv
            ? secretsSvc.getSecretForStatus(userId, mcpServerEnvKey(profile.id))
            : Promise.resolve(null),
    ]);
    if ((!profile.has_headers || headers) && (!hasEnv || envValues))
        return profile;
    return {
        ...profile,
        has_headers: profile.has_headers && !!headers,
        env: hasEnv && !envValues ? {} : profile.env,
    };
}
export async function listServersForApi(userId, pagination) {
    const result = listServers(userId, pagination);
    return {
        ...result,
        data: await Promise.all(result.data.map((profile) => withReadableMcpSecretStatus(userId, profile))),
    };
}
export function getEnabledServers(userId) {
    const rows = getDb()
        .query("SELECT * FROM mcp_servers WHERE user_id = ? AND is_enabled = 1 ORDER BY name ASC")
        .all(userId);
    return rows.map(rowToProfile);
}
export function getAutoConnectServers() {
    const rows = getDb()
        .query("SELECT * FROM mcp_servers WHERE is_enabled = 1 AND auto_connect = 1 ORDER BY user_id, name ASC")
        .all();
    return rows.map((r) => ({ ...rowToProfile(r), user_id: r.user_id }));
}
export async function createServer(userId, input) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    let hasHeaders = 0;
    if (input.headers && Object.keys(input.headers).length > 0) {
        await secretsSvc.putSecret(userId, mcpServerHeadersKey(id), JSON.stringify(input.headers));
        hasHeaders = 1;
    }
    if (input.env && Object.keys(input.env).length > 0) {
        await secretsSvc.putSecret(userId, mcpServerEnvKey(id), JSON.stringify(input.env));
    }
    getDb()
        .query(`INSERT INTO mcp_servers
        (id, user_id, name, transport_type, url, command, args, env, has_headers, is_enabled, auto_connect, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, input.name, input.transport_type, input.url || "", input.command || "", JSON.stringify(input.args || []), JSON.stringify(Object.keys(input.env || {})), // store key names only in DB
    hasHeaders, input.is_enabled !== false ? 1 : 0, input.auto_connect !== false ? 1 : 0, JSON.stringify(input.metadata || {}), now, now);
    const profile = getServer(userId, id);
    eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, profile }, userId);
    return profile;
}
export async function updateServer(userId, id, input) {
    const existing = getServer(userId, id);
    if (!existing)
        return null;
    if (input.headers !== undefined) {
        if (input.headers && Object.keys(input.headers).length > 0) {
            await secretsSvc.putSecret(userId, mcpServerHeadersKey(id), JSON.stringify(input.headers));
            getDb()
                .query("UPDATE mcp_servers SET has_headers = 1 WHERE id = ? AND user_id = ?")
                .run(id, userId);
        }
        else {
            secretsSvc.deleteSecret(userId, mcpServerHeadersKey(id));
            getDb()
                .query("UPDATE mcp_servers SET has_headers = 0 WHERE id = ? AND user_id = ?")
                .run(id, userId);
        }
    }
    if (input.env !== undefined) {
        if (input.env && Object.keys(input.env).length > 0) {
            await secretsSvc.putSecret(userId, mcpServerEnvKey(id), JSON.stringify(input.env));
        }
        else {
            secretsSvc.deleteSecret(userId, mcpServerEnvKey(id));
        }
    }
    const fields = [];
    const values = [];
    if (input.name !== undefined) {
        fields.push("name = ?");
        values.push(input.name);
    }
    if (input.transport_type !== undefined) {
        fields.push("transport_type = ?");
        values.push(input.transport_type);
    }
    if (input.url !== undefined) {
        fields.push("url = ?");
        values.push(input.url);
    }
    if (input.command !== undefined) {
        fields.push("command = ?");
        values.push(input.command);
    }
    if (input.args !== undefined) {
        fields.push("args = ?");
        values.push(JSON.stringify(input.args));
    }
    if (input.env !== undefined) {
        fields.push("env = ?");
        values.push(JSON.stringify(Object.keys(input.env)));
    }
    if (input.is_enabled !== undefined) {
        fields.push("is_enabled = ?");
        values.push(input.is_enabled ? 1 : 0);
    }
    if (input.auto_connect !== undefined) {
        fields.push("auto_connect = ?");
        values.push(input.auto_connect ? 1 : 0);
    }
    if (input.metadata !== undefined) {
        fields.push("metadata = ?");
        values.push(JSON.stringify(input.metadata));
    }
    if (fields.length === 0 && input.headers === undefined && input.env === undefined)
        return existing;
    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    values.push(userId);
    getDb()
        .query(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
        .run(...values);
    const updated = getServer(userId, id);
    eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, profile: updated }, userId);
    return updated;
}
export async function deleteServer(userId, id) {
    const deleted = getDb()
        .query("DELETE FROM mcp_servers WHERE id = ? AND user_id = ?")
        .run(id, userId).changes > 0;
    if (deleted) {
        secretsSvc.deleteSecret(userId, mcpServerHeadersKey(id));
        secretsSvc.deleteSecret(userId, mcpServerEnvKey(id));
        eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, deleted: true }, userId);
    }
    return deleted;
}
/** Retrieve encrypted headers for a server. */
export async function getServerHeaders(userId, id) {
    const json = await secretsSvc.getSecret(userId, mcpServerHeadersKey(id));
    if (!json)
        return {};
    try {
        return JSON.parse(json);
    }
    catch {
        return {};
    }
}
/** Retrieve encrypted env values for a stdio server. */
export async function getServerEnv(userId, id) {
    const json = await secretsSvc.getSecret(userId, mcpServerEnvKey(id));
    if (!json)
        return {};
    try {
        return JSON.parse(json);
    }
    catch {
        return {};
    }
}
export function updateServerStatus(id, userId, status) {
    const fields = ["updated_at = ?"];
    const values = [Math.floor(Date.now() / 1000)];
    if (status.last_connected_at !== undefined) {
        fields.push("last_connected_at = ?");
        values.push(status.last_connected_at);
    }
    if (status.last_error !== undefined) {
        fields.push("last_error = ?");
        values.push(status.last_error);
    }
    values.push(id);
    values.push(userId);
    getDb()
        .query(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
        .run(...values);
}
