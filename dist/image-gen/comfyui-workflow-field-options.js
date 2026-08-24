function extractFieldOptions(fieldSchema) {
    if (!Array.isArray(fieldSchema))
        return [];
    if (Array.isArray(fieldSchema[0])) {
        return fieldSchema[0].filter((value) => typeof value === "string");
    }
    if (fieldSchema[0] === "COMBO" &&
        fieldSchema[1] &&
        typeof fieldSchema[1] === "object" &&
        Array.isArray(fieldSchema[1].options)) {
        return fieldSchema[1].options.filter((value) => typeof value === "string");
    }
    return [];
}
function isLinkedWorkflowInput(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}
export function buildComfyUIWorkflowFieldOptions(workflow, objectInfo) {
    if (!objectInfo)
        return {};
    const fieldOptions = {};
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object")
            continue;
        const classType = node.class_type;
        if (typeof classType !== "string" || !classType.trim())
            continue;
        const nodeInfo = objectInfo[classType];
        if (!nodeInfo)
            continue;
        const inputs = typeof node.inputs === "object" && node.inputs
            ? node.inputs
            : {};
        const declaredFields = {
            ...(nodeInfo.input?.required ?? {}),
            ...(nodeInfo.input?.optional ?? {}),
        };
        for (const [fieldName, schema] of Object.entries(declaredFields)) {
            if (isLinkedWorkflowInput(inputs[fieldName]))
                continue;
            const options = extractFieldOptions(schema);
            if (options.length === 0)
                continue;
            fieldOptions[`${nodeId}:${fieldName}`] = options;
        }
    }
    return fieldOptions;
}
