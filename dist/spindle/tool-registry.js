function qualifiedName(extensionId, toolName) {
    return `${extensionId}:${toolName}`;
}
class ToolRegistry {
    tools = new Map();
    register(tool) {
        const key = qualifiedName(tool.extension_id, tool.name);
        this.tools.set(key, tool);
    }
    unregister(name, extensionId) {
        if (extensionId) {
            this.tools.delete(qualifiedName(extensionId, name));
        }
        else {
            // Legacy: try exact key first, then search by bare name
            if (this.tools.has(name)) {
                this.tools.delete(name);
            }
            else {
                for (const [key, tool] of this.tools) {
                    if (tool.name === name) {
                        this.tools.delete(key);
                        break;
                    }
                }
            }
        }
    }
    unregisterByExtension(extensionId) {
        for (const [key, tool] of this.tools) {
            if (tool.extension_id === extensionId) {
                this.tools.delete(key);
            }
        }
    }
    getTool(name) {
        // Try qualified name first (extensionId:toolName)
        const direct = this.tools.get(name);
        if (direct)
            return direct;
        // Fall back to searching by bare tool name (for built-in/DLC lookups)
        for (const tool of this.tools.values()) {
            if (tool.name === name)
                return tool;
        }
        return undefined;
    }
    /** Get tool by its fully qualified key (extensionId:name). No fallback. */
    getToolQualified(qualifiedKey) {
        return this.tools.get(qualifiedKey);
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    getCouncilTools() {
        return this.getTools().filter((t) => t.council_eligible);
    }
    /** Get tools marked for inline availability with the primary model. */
    getInlineAvailableTools() {
        return this.getTools().filter((t) => t.inline_available);
    }
    getToolsByExtension(extensionId) {
        return this.getTools().filter((t) => t.extension_id === extensionId);
    }
    /** Get the qualified key for a tool registration */
    getQualifiedName(tool) {
        return qualifiedName(tool.extension_id, tool.name);
    }
}
export const toolRegistry = new ToolRegistry();
