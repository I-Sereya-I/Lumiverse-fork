const UI_ONLY_PASSTHROUGH_TYPES = new Set(["Reroute"]);
const BYPASS_NODE_MODE = 4;
const KNOWN_WIDGET_FIELD_ORDER = {
    CheckpointLoaderSimple: ["ckpt_name"],
    CLIPTextEncode: ["text"],
    CLIPTextEncodeSDXL: ["text_g", "text_l"],
    EmptyLatentImage: ["width", "height", "batch_size"],
    EmptySD3LatentImage: ["width", "height", "batch_size"],
    KSampler: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    KSamplerAdvanced: [
        "noise_seed",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "start_at_step",
        "end_at_step",
        "return_with_leftover_noise",
    ],
};
export function detectComfyUIWorkflowFormat(workflow) {
    if (!workflow || typeof workflow !== "object")
        return "api_prompt";
    const record = workflow;
    if (Array.isArray(record.nodes) && Array.isArray(record.links)) {
        return "ui_workflow";
    }
    return "api_prompt";
}
export function convertUiWorkflowToApi(workflow, objectInfo) {
    if (!Array.isArray(workflow.nodes)) {
        throw new Error("convertUiWorkflowToApi: expected `nodes` array on UI workflow");
    }
    const nodes = workflow.nodes;
    const links = Array.isArray(workflow.links) ? workflow.links : [];
    const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
    const outgoingLinkCounts = new Map();
    const linkMap = new Map();
    for (const link of links) {
        if (!Array.isArray(link) || link.length < 5)
            continue;
        const [linkId, srcNodeId, srcSlot] = link;
        if (typeof linkId !== "number")
            continue;
        const sourceNodeId = String(srcNodeId);
        linkMap.set(linkId, {
            from: [sourceNodeId, Number(srcSlot) || 0],
        });
        outgoingLinkCounts.set(sourceNodeId, (outgoingLinkCounts.get(sourceNodeId) ?? 0) + 1);
    }
    const api = {};
    for (const node of nodes) {
        const id = String(node.id);
        const classType = getUiNodeClassType(node);
        if (!classType)
            continue;
        if (shouldSkipUiNodeFromApi(node, classType, id, outgoingLinkCounts, objectInfo)) {
            continue;
        }
        const inputs = {};
        const linkedFieldNames = new Set();
        const assignedWidgetFieldNames = new Set();
        if (Array.isArray(node.inputs)) {
            for (const input of node.inputs) {
                if (!input || typeof input !== "object")
                    continue;
                const name = input.name;
                const linkId = input.link;
                if (typeof name !== "string")
                    continue;
                if (typeof linkId === "number") {
                    linkedFieldNames.add(name);
                }
                else {
                    continue;
                }
                const resolved = resolveUiLinkSource(linkId, linkMap, nodesById, objectInfo);
                if (resolved) {
                    inputs[name] = resolved;
                }
            }
        }
        if (Array.isArray(node.widgets_values)) {
            let widgetIndex = applyWidgetValuesFromNodeInputs(node, classType, inputs, assignedWidgetFieldNames, objectInfo);
            const widgetFieldNames = getWidgetFieldNames(classType, new Set([...linkedFieldNames, ...assignedWidgetFieldNames]), objectInfo);
            for (const fieldName of widgetFieldNames) {
                if (!fieldName)
                    continue;
                if (widgetIndex >= node.widgets_values.length)
                    break;
                inputs[fieldName] = node.widgets_values[widgetIndex];
                widgetIndex += 1;
                if (fieldHasControlAfterGenerate(classType, fieldName, objectInfo)) {
                    widgetIndex += 1;
                }
            }
        }
        api[id] = {
            class_type: classType,
            inputs,
        };
    }
    return api;
}
function applyWidgetValuesFromNodeInputs(node, classType, inputs, assignedWidgetFieldNames, objectInfo) {
    if (!Array.isArray(node.inputs) || !Array.isArray(node.widgets_values)) {
        return 0;
    }
    let widgetIndex = 0;
    for (const input of node.inputs) {
        if (!input || typeof input !== "object")
            continue;
        const fieldName = typeof input.name === "string" ? input.name : "";
        if (!fieldName)
            continue;
        if (!input.widget || typeof input.widget !== "object")
            continue;
        if (widgetIndex >= node.widgets_values.length)
            break;
        inputs[fieldName] = node.widgets_values[widgetIndex];
        assignedWidgetFieldNames.add(fieldName);
        widgetIndex += 1;
        if (fieldHasControlAfterGenerate(classType, fieldName, objectInfo)) {
            widgetIndex += 1;
        }
    }
    return widgetIndex;
}
function fieldHasControlAfterGenerate(classType, fieldName, objectInfo) {
    const fieldSchema = objectInfo?.[classType]?.input?.required?.[fieldName]
        ?? objectInfo?.[classType]?.input?.optional?.[fieldName];
    if (!Array.isArray(fieldSchema))
        return false;
    if (fieldSchema.length < 2 || typeof fieldSchema[1] !== "object" || !fieldSchema[1]) {
        return false;
    }
    return Boolean(fieldSchema[1].control_after_generate);
}
/**
 * Normalize a workflow JSON to API format, regardless of which format it was imported in.
 * Returns { format, workflow } where 'workflow' is always in API format.
 */
export function normalizeComfyUIWorkflow(raw, objectInfo) {
    if (!raw || typeof raw !== "object") {
        throw new Error("normalizeComfyUIWorkflow: workflow is not an object");
    }
    const format = detectComfyUIWorkflowFormat(raw);
    if (format === "ui_workflow") {
        const apiWorkflow = pruneDisconnectedApiWorkflow(convertUiWorkflowToApi(raw, objectInfo));
        return {
            format,
            graphWorkflow: raw,
            apiWorkflow,
            unknownNodes: findUnsupportedApiNodeTypes(apiWorkflow, objectInfo),
        };
    }
    const apiWorkflow = pruneDisconnectedApiWorkflow(raw);
    return {
        format,
        graphWorkflow: apiWorkflow,
        apiWorkflow,
        unknownNodes: findUnsupportedApiNodeTypes(apiWorkflow, objectInfo),
    };
}
function getUiNodeClassType(node) {
    return String(node?.type ?? node?.class_type ?? "");
}
function isUiBypassNode(node) {
    return Number(node?.mode) === BYPASS_NODE_MODE;
}
function countLinkedInputs(node) {
    if (!Array.isArray(node.inputs))
        return 0;
    let count = 0;
    for (const input of node.inputs) {
        if (input && typeof input === "object" && typeof input.link === "number") {
            count += 1;
        }
    }
    return count;
}
function getFirstLinkedInputId(node) {
    if (!Array.isArray(node.inputs))
        return null;
    for (const input of node.inputs) {
        if (input && typeof input === "object" && typeof input.link === "number") {
            return input.link;
        }
    }
    return null;
}
function shouldSkipUiNodeFromApi(node, classType, nodeId, outgoingLinkCounts, objectInfo) {
    if (UI_ONLY_PASSTHROUGH_TYPES.has(classType) || isUiBypassNode(node)) {
        return true;
    }
    if (objectInfo?.[classType]) {
        return false;
    }
    const linkedInputCount = countLinkedInputs(node);
    const outgoingLinkCount = outgoingLinkCounts.get(nodeId) ?? 0;
    const widgetValueCount = Array.isArray(node.widgets_values) ? node.widgets_values.length : 0;
    return linkedInputCount === 0 && outgoingLinkCount === 0 && widgetValueCount === 0;
}
function resolveUiLinkSource(linkId, linkMap, nodesById, objectInfo, seenLinkIds = new Set()) {
    if (seenLinkIds.has(linkId))
        return undefined;
    seenLinkIds.add(linkId);
    const resolved = linkMap.get(linkId);
    if (!resolved)
        return undefined;
    const [sourceNodeId, sourceSlot] = resolved.from;
    const sourceNode = nodesById.get(sourceNodeId);
    const sourceClassType = getUiNodeClassType(sourceNode);
    if (sourceNode && UI_ONLY_PASSTHROUGH_TYPES.has(sourceClassType)) {
        const upstreamLinkId = getFirstLinkedInputId(sourceNode);
        if (typeof upstreamLinkId === "number") {
            const upstream = resolveUiLinkSource(upstreamLinkId, linkMap, nodesById, objectInfo, seenLinkIds);
            if (upstream) {
                return upstream;
            }
        }
    }
    if (sourceNode && isUiBypassNode(sourceNode)) {
        const upstreamLinkId = getBypassInputLinkId(sourceNode, sourceSlot);
        if (typeof upstreamLinkId === "number") {
            const upstream = resolveUiLinkSource(upstreamLinkId, linkMap, nodesById, objectInfo, seenLinkIds);
            if (upstream) {
                return upstream;
            }
        }
    }
    return resolved.from;
}
function getBypassInputLinkId(node, outputSlot) {
    if (!Array.isArray(node.inputs))
        return null;
    for (const input of node.inputs) {
        if (!input || typeof input !== "object")
            continue;
        if (typeof input.link !== "number")
            continue;
        if (Number(input.slot_index) === outputSlot) {
            return input.link;
        }
    }
    const indexedInput = node.inputs[outputSlot];
    if (indexedInput && typeof indexedInput === "object" && typeof indexedInput.link === "number") {
        return indexedInput.link;
    }
    const linkedInputs = node.inputs.filter((input) => input && typeof input === "object" && typeof input.link === "number");
    if (linkedInputs.length === 1) {
        return linkedInputs[0].link;
    }
    return null;
}
function isWorkflowLinkValue(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}
function nodeHasAnyLinkedInput(node) {
    if (!node || typeof node.inputs !== "object" || !node.inputs)
        return false;
    return Object.values(node.inputs).some((value) => isWorkflowLinkValue(value));
}
function pruneDisconnectedApiWorkflow(workflow) {
    const dependents = new Map();
    for (const [nodeId, node] of Object.entries(workflow)) {
        const inputs = node && typeof node === "object" && typeof node.inputs === "object" && node.inputs
            ? node.inputs
            : {};
        for (const value of Object.values(inputs)) {
            if (!isWorkflowLinkValue(value))
                continue;
            const sourceNodeId = value[0];
            const nextDependents = dependents.get(sourceNodeId) ?? new Set();
            nextDependents.add(nodeId);
            dependents.set(sourceNodeId, nextDependents);
        }
    }
    const terminalNodeIds = Object.entries(workflow)
        .filter(([nodeId, node]) => (dependents.get(nodeId)?.size ?? 0) === 0 && nodeHasAnyLinkedInput(node))
        .map(([nodeId]) => nodeId);
    if (terminalNodeIds.length === 0) {
        return workflow;
    }
    const keep = new Set();
    const stack = [...terminalNodeIds];
    while (stack.length > 0) {
        const nodeId = stack.pop();
        if (keep.has(nodeId))
            continue;
        keep.add(nodeId);
        const node = workflow[nodeId];
        if (!node || typeof node.inputs !== "object" || !node.inputs)
            continue;
        for (const value of Object.values(node.inputs)) {
            if (!isWorkflowLinkValue(value))
                continue;
            if (workflow[value[0]]) {
                stack.push(value[0]);
            }
        }
    }
    return Object.fromEntries(Object.entries(workflow).filter(([nodeId]) => keep.has(nodeId)));
}
export function findUnsupportedApiNodeTypes(workflow, objectInfo) {
    if (!objectInfo)
        return [];
    const unknown = new Set();
    for (const node of Object.values(workflow)) {
        const classType = node && typeof node === "object" && typeof node.class_type === "string"
            ? String(node.class_type)
            : "";
        if (!classType || objectInfo[classType])
            continue;
        unknown.add(classType);
    }
    return [...unknown];
}
function getWidgetFieldNames(classType, excludedFieldNames, objectInfo) {
    const schema = objectInfo?.[classType];
    const schemaFieldNames = getWidgetFieldNamesFromSchema(schema, excludedFieldNames);
    if (schemaFieldNames.length > 0) {
        return schemaFieldNames;
    }
    return (KNOWN_WIDGET_FIELD_ORDER[classType] ?? []).filter((fieldName) => !excludedFieldNames.has(fieldName));
}
function getWidgetFieldNamesFromSchema(schema, excludedFieldNames) {
    if (!schema?.input)
        return [];
    const fieldNames = [
        ...getSchemaFieldOrder(schema, "required"),
        ...getSchemaFieldOrder(schema, "optional"),
    ];
    return fieldNames.filter((fieldName) => !excludedFieldNames.has(fieldName));
}
function getSchemaFieldOrder(schema, kind) {
    const order = schema?.input_order?.[kind];
    if (Array.isArray(order)) {
        return order.filter((fieldName) => typeof fieldName === "string");
    }
    return Object.keys(schema?.input?.[kind] ?? {});
}
