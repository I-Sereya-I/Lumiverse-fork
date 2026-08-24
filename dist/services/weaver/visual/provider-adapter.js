export function adapterImageInput(adapter, connection) {
    if (adapter.checkImageInput)
        return adapter.checkImageInput(connection);
    if (adapter.imageInput)
        return { supported: true, mechanism: adapter.imageInput };
    return {
        supported: false,
        mechanism: null,
        reason: "This image provider cannot take an image as input.",
    };
}
