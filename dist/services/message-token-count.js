import * as connectionsSvc from "./connections.service";
import * as settingsSvc from "./settings.service";
import * as tokenizerSvc from "./tokenizer.service";
/** Setting key (shared with the frontend store) that gates message token counts. */
export const SHOW_MESSAGE_TOKEN_COUNT_KEY = "showMessageTokenCount";
const defaultDeps = {
    // Mirror the frontend default (true): only opt out when explicitly disabled.
    isEnabled: (userId) => settingsSvc.getSetting(userId, SHOW_MESSAGE_TOKEN_COUNT_KEY)?.value !== false,
    resolveModel: (userId, connectionId) => connectionsSvc.resolveConnection(userId, connectionId)?.model,
    countForModel: tokenizerSvc.countForModel,
};
/**
 * Best-effort token count for a message's raw content, mirroring how assistant
 * output is tokenized after generation (see generate.service). Lets user-sent
 * messages carry a `tokenCount` in `extra` so the UI can show it alongside
 * assistant counts.
 *
 * Gated by the `showMessageTokenCount` user setting — when the user has counts
 * turned off there's nothing to display, so we skip the work entirely rather
 * than store metadata that would never be shown.
 *
 * The tokenizer is resolved from the caller's connection model (the explicit
 * `connectionId` when given, otherwise their default connection). This is a
 * display approximation: a chat may generate with a different connection, but
 * no per-message connection is recorded at send time.
 *
 * Always non-fatal — disabled counts, empty content, no resolvable
 * model/tokenizer, or an encode failure all yield `undefined`. Token counts are
 * optional metadata and must never block message persistence.
 */
export async function computeMessageTokenCount(userId, content, connectionId, deps = defaultDeps) {
    if (!content)
        return undefined;
    try {
        if (!deps.isEnabled(userId))
            return undefined;
        const model = deps.resolveModel(userId, connectionId);
        if (!model)
            return undefined;
        return (await deps.countForModel(model, content)) ?? undefined;
    }
    catch {
        return undefined;
    }
}
