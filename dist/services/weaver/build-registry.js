import { CHARACTER_REGISTRY } from "./registries/character";
import { WORLD_REGISTRY } from "./registries/world";
const REGISTRIES = [CHARACTER_REGISTRY, WORLD_REGISTRY];
export function getBuildRegistry(buildType) {
    return REGISTRIES.find((r) => r.buildType === buildType) ?? CHARACTER_REGISTRY;
}
