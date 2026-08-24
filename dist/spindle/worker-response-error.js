/** Reconstruct host error metadata without losing optimistic-concurrency fields. */
export function deserializeWorkerResponseError(value) {
    if (typeof value === "string")
        return new Error(value);
    const error = new Error(value.message);
    Object.assign(error, value);
    return error;
}
