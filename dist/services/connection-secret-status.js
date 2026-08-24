import * as secretsSvc from "./secrets.service";
/**
 * Reconcile a persisted `has_api_key` flag with the encrypted row's actual
 * readability before returning a profile to a settings UI.
 */
export async function withReadableApiKeyStatus(userId, profile, secretKey) {
    if (!profile.has_api_key)
        return profile;
    const readable = !!(await secretsSvc.getSecretForStatus(userId, secretKey(profile.id)));
    return readable ? profile : { ...profile, has_api_key: false };
}
export async function withReadableApiKeyStatuses(userId, result, secretKey) {
    return {
        ...result,
        data: await Promise.all(result.data.map((profile) => withReadableApiKeyStatus(userId, profile, secretKey))),
    };
}
