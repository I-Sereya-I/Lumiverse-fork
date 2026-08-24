import { adapterImageInput } from "../provider-adapter";
import { readComfyUIConfig } from "../comfyui-workflow-storage";
import { comfyUIProviderAdapter } from "./comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./simple-provider-adapter";
const swarmuiSimpleAdapter = createSimpleProviderAdapter("swarmui");
function pickInner(connection) {
    return readComfyUIConfig(connection.metadata) ? comfyUIProviderAdapter : swarmuiSimpleAdapter;
}
export const swarmUIProviderAdapter = {
    provider: "swarmui",
    supportsWorkflowImport: true,
    supportsAdvancedMode: false,
    imageInput: "init",
    checkImageInput(connection) {
        return adapterImageInput(pickInner(connection), connection);
    },
    async validate(asset, connection, apiKey) {
        return pickInner(connection).validate(asset, connection, apiKey);
    },
    async build(asset, connection, apiKey) {
        return pickInner(connection).build(asset, connection, apiKey);
    },
};
