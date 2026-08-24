import { toolRegistry } from "../../spindle/tool-registry";
import { getWorkerHost } from "../../spindle/lifecycle";
import { parseMcpToolName } from "./mcp-tools";
const EMPTY_TOOL_SCHEMA = {
    type: "object",
    properties: {},
    required: [],
};
function normalizeToolJsonSchemaValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeToolJsonSchemaValue);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const input = value;
    const normalized = {};
    for (const [key, child] of Object.entries(input)) {
        normalized[key] = normalizeToolJsonSchemaValue(child);
    }
    return normalized;
}
export function normalizeToolJsonSchema(schema) {
    return normalizeToolJsonSchemaValue(schema);
}
export function buildCouncilMemberContext(member, item) {
    return {
        memberId: member.id,
        itemId: member.itemId,
        packId: member.packId,
        packName: member.packName,
        name: member.itemName,
        role: member.role ?? "",
        chance: member.chance,
        avatarUrl: item?.avatar_url ?? null,
        definition: item?.definition ?? "",
        personality: item?.personality ?? "",
        behavior: item?.behavior ?? "",
        // The shared spindle types package still narrows this field to 0|1|2.
        // Runtime values now allow 3 for "any", so cast at the boundary until the package catches up.
        genderIdentity: (item?.gender_identity ?? 3),
    };
}
export function getCouncilToolExecution(userId, tool) {
    if (tool.execution)
        return tool.execution;
    if (parseMcpToolName(userId, tool.name))
        return "mcp";
    if (toolRegistry.getTool(tool.name)?.extension_id)
        return "extension";
    return "llm";
}
export function getCouncilToolArgsSchema(userId, tool) {
    if (tool.argsSchema && Object.keys(tool.argsSchema).length > 0) {
        return normalizeToolJsonSchema(tool.argsSchema);
    }
    const execution = getCouncilToolExecution(userId, tool);
    if (execution === "host" || execution === "extension" || execution === "mcp") {
        return tool.inputSchema && Object.keys(tool.inputSchema).length > 0
            ? normalizeToolJsonSchema(tool.inputSchema)
            : { ...EMPTY_TOOL_SCHEMA };
    }
    return null;
}
export function isCouncilToolInlineCallable(userId, tool) {
    return getCouncilToolExecution(userId, tool) !== "llm" && getCouncilToolArgsSchema(userId, tool) !== null;
}
export function getExtensionToolRegistration(name) {
    return toolRegistry.getTool(name);
}
export async function invokeExtensionCouncilTool(extensionId, toolName, args, timeoutMs, councilMember, contextMessages) {
    const host = getWorkerHost(extensionId);
    if (!host) {
        throw new Error(`Extension worker '${extensionId}' is not running`);
    }
    return host.invokeExtensionTool(toolName, args, timeoutMs, councilMember, contextMessages);
}
