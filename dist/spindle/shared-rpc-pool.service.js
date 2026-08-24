import { assertValidSharedRpcEndpoint, normalizeOwnedSharedRpcEndpoint, } from "./shared-rpc";
const sharedRpcEndpoints = new Map();
const sharedRpcByOwner = new Map();
function trackOwnerEndpoint(ownerExtensionId, endpoint) {
    let endpoints = sharedRpcByOwner.get(ownerExtensionId);
    if (!endpoints) {
        endpoints = new Set();
        sharedRpcByOwner.set(ownerExtensionId, endpoints);
    }
    endpoints.add(endpoint);
}
function normalizeOwnedEndpoint(ownerExtensionId, endpoint) {
    return normalizeOwnedSharedRpcEndpoint(ownerExtensionId, endpoint);
}
function normalizePolicy(policy) {
    if (!policy || !Array.isArray(policy.requires))
        return null;
    return {
        requiredPermissions: [...new Set(policy.requires.map((permission) => String(permission).trim()).filter(Boolean))].sort(),
    };
}
export function syncSharedRpcEndpoint(ownerExtensionId, endpoint, value, policy) {
    const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
    sharedRpcEndpoints.set(normalized, {
        mode: "sync",
        ownerExtensionId,
        endpoint: normalized,
        value,
        policy: normalizePolicy(policy),
    });
    trackOwnerEndpoint(ownerExtensionId, normalized);
    return normalized;
}
export function registerSharedRpcRequestEndpoint(ownerExtensionId, endpoint, handler, policy) {
    const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
    sharedRpcEndpoints.set(normalized, {
        mode: "request",
        ownerExtensionId,
        endpoint: normalized,
        handler,
        policy: normalizePolicy(policy),
    });
    trackOwnerEndpoint(ownerExtensionId, normalized);
    return normalized;
}
export function unregisterSharedRpcEndpoint(ownerExtensionId, endpoint) {
    const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
    const existing = sharedRpcEndpoints.get(normalized);
    if (!existing || existing.ownerExtensionId !== ownerExtensionId)
        return;
    sharedRpcEndpoints.delete(normalized);
    const owned = sharedRpcByOwner.get(ownerExtensionId);
    if (!owned)
        return;
    owned.delete(normalized);
    if (owned.size === 0) {
        sharedRpcByOwner.delete(ownerExtensionId);
    }
}
export function unregisterSharedRpcEndpointsByOwner(ownerExtensionId) {
    const owned = sharedRpcByOwner.get(ownerExtensionId);
    if (!owned)
        return;
    for (const endpoint of owned) {
        sharedRpcEndpoints.delete(endpoint);
    }
    sharedRpcByOwner.delete(ownerExtensionId);
}
export async function readSharedRpcEndpoint(endpoint, requesterExtensionId, getGrantedPermissions) {
    const normalized = assertValidSharedRpcEndpoint(endpoint);
    const record = sharedRpcEndpoints.get(normalized);
    if (!record) {
        throw new Error(`Shared RPC endpoint "${normalized}" is not registered`);
    }
    if (getGrantedPermissions) {
        assertRequesterCanReadEndpoint(normalized, requesterExtensionId, record.ownerExtensionId, record.policy, getGrantedPermissions);
    }
    if (record.mode === "sync") {
        return record.value;
    }
    const effectivePermissions = getGrantedPermissions
        ? resolveEffectiveHandlerPermissions(requesterExtensionId, record.ownerExtensionId, record.policy, getGrantedPermissions)
        : [];
    return await record.handler(requesterExtensionId, effectivePermissions);
}
function assertRequesterCanReadEndpoint(endpoint, requesterExtensionId, ownerExtensionId, policy, getGrantedPermissions) {
    const ownerPermissions = new Set(getGrantedPermissions(ownerExtensionId));
    const requiredPermissions = policy?.requiredPermissions ?? [...ownerPermissions].sort();
    if (requiredPermissions.length === 0)
        return;
    const requesterPermissions = new Set(getGrantedPermissions(requesterExtensionId));
    const missingFromRequester = requiredPermissions.filter((permission) => !requesterPermissions.has(permission));
    const missingFromOwner = policy
        ? requiredPermissions.filter((permission) => !ownerPermissions.has(permission))
        : [];
    if (missingFromRequester.length === 0 && missingFromOwner.length === 0)
        return;
    if (missingFromOwner.length > 0) {
        throw new Error(`Shared RPC endpoint "${endpoint}" requires owner "${ownerExtensionId}" permissions: ${missingFromOwner.join(", ")}`);
    }
    throw new Error(policy
        ? `Shared RPC endpoint "${endpoint}" requires requester "${requesterExtensionId}" permissions: ${missingFromRequester.join(", ")}`
        : `Shared RPC endpoint "${endpoint}" requires requester "${requesterExtensionId}" to inherit owner "${ownerExtensionId}" permissions: ${missingFromRequester.join(", ")}`);
}
function resolveEffectiveHandlerPermissions(requesterExtensionId, ownerExtensionId, policy, getGrantedPermissions) {
    if (policy)
        return policy.requiredPermissions;
    const requesterPermissions = new Set(getGrantedPermissions(requesterExtensionId));
    return getGrantedPermissions(ownerExtensionId).filter((permission) => requesterPermissions.has(permission)).sort();
}
export function resetSharedRpcPoolForTests() {
    sharedRpcEndpoints.clear();
    sharedRpcByOwner.clear();
}
