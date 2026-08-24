import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
export function emitSpindlePreGenerationActivity(input) {
    if (!input.chatId || !input.userId)
        return;
    eventBus.emit(EventType.SPINDLE_PRE_GENERATION_ACTIVITY, {
        chatId: input.chatId,
        phase: input.phase,
        status: input.status,
        extensionId: input.extensionId,
        extensionName: input.extensionName?.trim() || input.extensionId,
        ...(input.error ? { error: input.error } : {}),
    }, input.userId);
}
