const providers = new Map();
export function registerImageProvider(provider) {
    providers.set(provider.name, provider);
}
export function getImageProvider(name) {
    return providers.get(name);
}
export function listImageProviders() {
    return [...providers.keys()];
}
export function getImageProviderList() {
    return [...providers.values()];
}
