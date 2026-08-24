import { detectComfyUIWorkflowFormat } from "./comfyui-import";
function parseComfyUIConfigValue(value) {
    if (!value || typeof value !== "object")
        return null;
    const config = value;
    const workflowJson = config.workflow_json;
    const workflowApiJson = config.workflow_api_json;
    const storedWorkflowFormat = config.workflow_format;
    const fieldMappings = config.field_mappings;
    const fieldOptions = config.field_options && typeof config.field_options === "object"
        ? config.field_options
        : undefined;
    const importedAt = config.imported_at;
    if (!workflowJson || typeof workflowJson !== "object")
        return null;
    const normalizedApiWorkflow = workflowApiJson && typeof workflowApiJson === "object"
        ? workflowApiJson
        : workflowJson;
    if (storedWorkflowFormat !== "ui_workflow" && storedWorkflowFormat !== "api_prompt")
        return null;
    if (!Array.isArray(fieldMappings))
        return null;
    if (typeof importedAt !== "number")
        return null;
    const graphWorkflowFormat = detectComfyUIWorkflowFormat(workflowJson);
    const needsReimport = !workflowApiJson &&
        storedWorkflowFormat === "ui_workflow" &&
        graphWorkflowFormat !== "ui_workflow";
    return {
        workflow_json: workflowJson,
        workflow_api_json: normalizedApiWorkflow,
        workflow_format: graphWorkflowFormat,
        field_mappings: fieldMappings,
        field_options: fieldOptions,
        imported_at: importedAt,
        needs_reimport: needsReimport,
    };
}
export function readComfyUIConfig(metadata) {
    if (!metadata || typeof metadata !== "object")
        return null;
    return parseComfyUIConfigValue(metadata.comfyui);
}
export function writeComfyUIConfig(metadata, config) {
    const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
    base.comfyui = config;
    return base;
}
export function clearComfyUIConfig(metadata) {
    const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
    delete base.comfyui;
    return base;
}
export function readComfyUIWorkflowLibrary(metadata) {
    if (!metadata || typeof metadata !== "object")
        return { entries: [], activeId: null };
    const record = metadata;
    const entries = [];
    if (Array.isArray(record.comfyui_workflows)) {
        for (const raw of record.comfyui_workflows) {
            if (!raw || typeof raw !== "object")
                continue;
            const entry = raw;
            if (typeof entry.id !== "string" || typeof entry.name !== "string")
                continue;
            const config = parseComfyUIConfigValue(entry.config);
            if (!config)
                continue;
            entries.push({
                id: entry.id,
                name: entry.name,
                updated_at: typeof entry.updated_at === "number" ? entry.updated_at : 0,
                config,
            });
        }
    }
    const rawActiveId = record.comfyui_active_workflow_id;
    const activeId = typeof rawActiveId === "string" && entries.some((e) => e.id === rawActiveId)
        ? rawActiveId
        : null;
    return { entries, activeId };
}
export function writeComfyUIWorkflowLibrary(metadata, library) {
    const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
    base.comfyui_workflows = library.entries;
    if (library.activeId) {
        base.comfyui_active_workflow_id = library.activeId;
    }
    else {
        delete base.comfyui_active_workflow_id;
    }
    return base;
}
export function syncActiveComfyUIWorkflowToLibrary(metadata, config, updatedAt) {
    const base = writeComfyUIConfig(metadata, config);
    const library = readComfyUIWorkflowLibrary(base);
    if (!library.activeId)
        return base;
    const entries = library.entries.map((entry) => entry.id === library.activeId ? { ...entry, config, updated_at: updatedAt } : entry);
    return writeComfyUIWorkflowLibrary(base, { entries, activeId: library.activeId });
}
