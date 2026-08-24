export function patchWorkflow(workflow, mappings, values) {
    const patched = JSON.parse(JSON.stringify(workflow));
    const validNodeIds = new Set(Object.keys(patched));
    const loraEntriesByNodeId = buildLoraEntryMap(mappings, values.loras, validNodeIds);
    for (const mapping of mappings) {
        const node = patched[mapping.nodeId];
        if (!node || typeof node.inputs !== "object")
            continue;
        const value = resolveMappedValue(mapping, values, loraEntriesByNodeId);
        if (value === undefined)
            continue;
        node.inputs[mapping.fieldName] = value;
    }
    return patched;
}
function buildLoraEntryMap(mappings, loras, validNodeIds) {
    if (!loras?.length)
        return undefined;
    const entriesByNodeId = new Map();
    for (const mapping of mappings) {
        if (!isLoraMapping(mapping) || entriesByNodeId.has(mapping.nodeId))
            continue;
        if (!validNodeIds.has(mapping.nodeId))
            continue;
        if (entriesByNodeId.size >= loras.length)
            break;
        const lora = loras[entriesByNodeId.size];
        if (lora === undefined)
            break;
        entriesByNodeId.set(mapping.nodeId, lora);
    }
    return entriesByNodeId;
}
function isLoraMapping(mapping) {
    return (mapping.mappedAs === "lora_name" ||
        mapping.mappedAs === "lora_strength_model" ||
        mapping.mappedAs === "lora_strength_clip");
}
function resolveMappedValue(mapping, values, loraEntriesByNodeId) {
    switch (mapping.mappedAs) {
        case "positive_prompt":
            return values.positive_prompt;
        case "negative_prompt":
            return values.negative_prompt;
        case "seed":
            return values.seed;
        case "steps":
            return values.steps;
        case "cfg":
            return values.cfg;
        case "sampler_name":
            return values.sampler_name;
        case "scheduler":
            return values.scheduler;
        case "width":
            return values.width;
        case "height":
            return values.height;
        case "checkpoint":
            return values.checkpoint;
        case "unet":
            return values.unet;
        case "lora_name": {
            const lora = loraEntriesByNodeId?.get(mapping.nodeId);
            return loraEntriesByNodeId ? lora?.lora_name : values.lora_name;
        }
        case "lora_strength_model": {
            const lora = loraEntriesByNodeId?.get(mapping.nodeId);
            return loraEntriesByNodeId ? lora?.weight_model : values.lora_strength_model;
        }
        case "lora_strength_clip": {
            const lora = loraEntriesByNodeId?.get(mapping.nodeId);
            if (!loraEntriesByNodeId)
                return values.lora_strength_clip;
            return lora ? lora.weight_clip ?? lora.weight_model : undefined;
        }
        case "init_image":
            return values.init_image;
        case "denoise":
            return values.denoise;
        case "custom":
            return values.custom?.[`${mapping.nodeId}:${mapping.fieldName}`];
        default:
            return undefined;
    }
}
