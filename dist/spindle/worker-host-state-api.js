import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import * as chatsSvc from "../services/chats.service";
import * as settingsSvc from "../services/settings.service";
import * as presetsSvc from "../services/presets.service";
import { PresetRevisionConflictError } from "../types/preset";
/** Owns persisted variable and preset API state for a single extension host. */
export class WorkerHostStateApi {
    context;
    constructor(context) {
        this.context = context;
    }
    dispatch(message) {
        const msg = message;
        switch (msg.type) {
            case "vars_get_local":
                this.handleVarsGetLocal(msg.requestId, msg.chatId, msg.key);
                return true;
            case "vars_set_local":
                this.handleVarsSetLocal(msg.requestId, msg.chatId, msg.key, msg.value);
                return true;
            case "vars_delete_local":
                this.handleVarsDeleteLocal(msg.requestId, msg.chatId, msg.key);
                return true;
            case "vars_list_local":
                this.handleVarsListLocal(msg.requestId, msg.chatId);
                return true;
            case "vars_has_local":
                this.handleVarsHasLocal(msg.requestId, msg.chatId, msg.key);
                return true;
            case "vars_get_global":
                this.handleVarsGetGlobal(msg.requestId, msg.key, msg.userId);
                return true;
            case "vars_set_global":
                this.handleVarsSetGlobal(msg.requestId, msg.key, msg.value, msg.userId);
                return true;
            case "vars_delete_global":
                this.handleVarsDeleteGlobal(msg.requestId, msg.key, msg.userId);
                return true;
            case "vars_list_global":
                this.handleVarsListGlobal(msg.requestId, msg.userId);
                return true;
            case "vars_has_global":
                this.handleVarsHasGlobal(msg.requestId, msg.key, msg.userId);
                return true;
            case "vars_get_chat":
                this.handleVarsGetChat(msg.requestId, msg.chatId, msg.key);
                return true;
            case "vars_set_chat":
                this.handleVarsSetChat(msg.requestId, msg.chatId, msg.key, msg.value);
                return true;
            case "vars_delete_chat":
                this.handleVarsDeleteChat(msg.requestId, msg.chatId, msg.key);
                return true;
            case "vars_list_chat":
                this.handleVarsListChat(msg.requestId, msg.chatId);
                return true;
            case "vars_has_chat":
                this.handleVarsHasChat(msg.requestId, msg.chatId, msg.key);
                return true;
            case "presets_list":
                this.handlePresetsList(msg.requestId, msg.limit, msg.offset, msg.userId);
                return true;
            case "presets_get":
                this.handlePresetsGet(msg.requestId, msg.presetId, msg.userId);
                return true;
            case "presets_create":
                this.handlePresetsCreate(msg.requestId, msg.input, msg.userId);
                return true;
            case "presets_update":
                this.handlePresetsUpdate(msg.requestId, msg.presetId, msg.input, msg.userId);
                return true;
            case "presets_delete":
                this.handlePresetsDelete(msg.requestId, msg.presetId, msg.userId);
                return true;
            case "preset_blocks_list":
                this.handlePresetBlocksList(msg.requestId, msg.presetId, msg.userId);
                return true;
            case "preset_blocks_get":
                this.handlePresetBlocksGet(msg.requestId, msg.presetId, msg.blockId, msg.userId);
                return true;
            case "preset_blocks_create":
                this.handlePresetBlocksCreate(msg.requestId, msg.presetId, msg.input, msg.index, msg.userId);
                return true;
            case "preset_blocks_update":
                this.handlePresetBlocksUpdate(msg.requestId, msg.presetId, msg.blockId, msg.input, msg.userId);
                return true;
            case "preset_blocks_delete":
                this.handlePresetBlocksDelete(msg.requestId, msg.presetId, msg.blockId, msg.userId);
                return true;
            case "preset_categories_list":
                this.handlePresetCategoriesList(msg.requestId, msg.presetId, msg.userId);
                return true;
            default: return false;
        }
    }
    getChatOwnerId(chatId) { return this.context.getChatOwnerId(chatId); }
    enforceScopedUser(userId) { this.context.enforceScopedUser(userId); }
    resolveEffectiveUserId(userId) { return this.context.resolveEffectiveUserId(userId); }
    hasPermission(permission) { return this.context.hasPermission(permission); }
    postToWorker(message) { this.context.postResponse(message); }
    getLocalVars(chatId) {
        const userId = this.getChatOwnerId(chatId);
        if (!userId)
            throw new Error("Chat not found");
        this.enforceScopedUser(userId);
        const chat = chatsSvc.getChat(userId, chatId);
        if (!chat)
            throw new Error("Chat not found");
        return chat.metadata?.macro_variables?.local || {};
    }
    setLocalVars(chatId, vars) {
        const userId = this.getChatOwnerId(chatId);
        if (!userId)
            throw new Error("Chat not found");
        const chat = chatsSvc.getChat(userId, chatId);
        if (!chat)
            throw new Error("Chat not found");
        const metadata = { ...chat.metadata };
        const macroVars = metadata.macro_variables || {};
        macroVars.local = vars;
        metadata.macro_variables = macroVars;
        chatsSvc.updateChat(userId, chatId, { metadata });
    }
    getGlobalVars(userId) {
        const setting = settingsSvc.getSetting(userId, "macro_variables_global");
        return setting?.value || {};
    }
    setGlobalVars(userId, vars) {
        settingsSvc.putSetting(userId, "macro_variables_global", vars);
    }
    handleVarsGetLocal(requestId, chatId, key) {
        try {
            const vars = this.getLocalVars(chatId);
            this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsSetLocal(requestId, chatId, key, value) {
        try {
            const vars = this.getLocalVars(chatId);
            vars[key] = value;
            this.setLocalVars(chatId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsDeleteLocal(requestId, chatId, key) {
        try {
            const vars = this.getLocalVars(chatId);
            delete vars[key];
            this.setLocalVars(chatId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsListLocal(requestId, chatId) {
        try {
            const vars = this.getLocalVars(chatId);
            this.postToWorker({ type: "response", requestId, result: vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsHasLocal(requestId, chatId, key) {
        try {
            const vars = this.getLocalVars(chatId);
            this.postToWorker({ type: "response", requestId, result: key in vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsGetGlobal(requestId, key, userId) {
        try {
            const resolvedUserId = this.resolveEffectiveUserId(userId);
            if (!resolvedUserId) {
                throw new Error("userId is required for operator-scoped extensions");
            }
            this.enforceScopedUser(resolvedUserId);
            const vars = this.getGlobalVars(resolvedUserId);
            this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsSetGlobal(requestId, key, value, userId) {
        try {
            const resolvedUserId = this.resolveEffectiveUserId(userId);
            if (!resolvedUserId) {
                throw new Error("userId is required for operator-scoped extensions");
            }
            this.enforceScopedUser(resolvedUserId);
            const vars = this.getGlobalVars(resolvedUserId);
            vars[key] = value;
            this.setGlobalVars(resolvedUserId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsDeleteGlobal(requestId, key, userId) {
        try {
            const resolvedUserId = this.resolveEffectiveUserId(userId);
            if (!resolvedUserId) {
                throw new Error("userId is required for operator-scoped extensions");
            }
            this.enforceScopedUser(resolvedUserId);
            const vars = this.getGlobalVars(resolvedUserId);
            delete vars[key];
            this.setGlobalVars(resolvedUserId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsListGlobal(requestId, userId) {
        try {
            const resolvedUserId = this.resolveEffectiveUserId(userId);
            if (!resolvedUserId) {
                throw new Error("userId is required for operator-scoped extensions");
            }
            this.enforceScopedUser(resolvedUserId);
            const vars = this.getGlobalVars(resolvedUserId);
            this.postToWorker({ type: "response", requestId, result: vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsHasGlobal(requestId, key, userId) {
        try {
            const resolvedUserId = this.resolveEffectiveUserId(userId);
            if (!resolvedUserId) {
                throw new Error("userId is required for operator-scoped extensions");
            }
            this.enforceScopedUser(resolvedUserId);
            const vars = this.getGlobalVars(resolvedUserId);
            this.postToWorker({ type: "response", requestId, result: key in vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    // ─── Chat-Scoped Persisted Variables (free tier) ────────────────────
    getChatVars(chatId) {
        const userId = this.getChatOwnerId(chatId);
        if (!userId)
            throw new Error("Chat not found");
        this.enforceScopedUser(userId);
        const chat = chatsSvc.getChat(userId, chatId);
        if (!chat)
            throw new Error("Chat not found");
        return chat.metadata?.chat_variables || {};
    }
    setChatVars(chatId, vars) {
        const userId = this.getChatOwnerId(chatId);
        if (!userId)
            throw new Error("Chat not found");
        const chat = chatsSvc.getChat(userId, chatId);
        if (!chat)
            throw new Error("Chat not found");
        const metadata = { ...chat.metadata, chat_variables: vars };
        chatsSvc.updateChat(userId, chatId, { metadata });
    }
    handleVarsGetChat(requestId, chatId, key) {
        try {
            const vars = this.getChatVars(chatId);
            this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsSetChat(requestId, chatId, key, value) {
        try {
            const vars = this.getChatVars(chatId);
            vars[key] = value;
            this.setChatVars(chatId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsDeleteChat(requestId, chatId, key) {
        try {
            const vars = this.getChatVars(chatId);
            delete vars[key];
            this.setChatVars(chatId, vars);
            this.postToWorker({ type: "response", requestId, result: true });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsListChat(requestId, chatId) {
        try {
            const vars = this.getChatVars(chatId);
            this.postToWorker({ type: "response", requestId, result: vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handleVarsHasChat(requestId, chatId, key) {
        try {
            const vars = this.getChatVars(chatId);
            this.postToWorker({ type: "response", requestId, result: key in vars });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    // ─── Presets CRUD (gated: "presets") ────────────────────────────────
    resolvePresetUserOrThrow(userId) {
        if (!this.hasPermission("presets")) {
            throw new Error(`${PERMISSION_DENIED_PREFIX} presets — Presets permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId)
            throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);
        return resolvedUserId;
    }
    handlePresetsList(requestId, limit, offset, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const result = presetsSvc.listPresets(resolvedUserId, {
                limit: Math.min(limit || 50, 200),
                offset: offset || 0,
            });
            this.postToWorker({
                type: "response",
                requestId,
                result: { data: result.data, total: result.total },
            });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetsGet(requestId, presetId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            this.postToWorker({ type: "response", requestId, result: presetsSvc.getPreset(resolvedUserId, presetId) });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetsCreate(requestId, input, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
                throw new Error("Preset name is required");
            }
            if (!input?.provider || typeof input.provider !== "string" || !input.provider.trim()) {
                throw new Error("Preset provider is required");
            }
            const preset = presetsSvc.createPreset(resolvedUserId, input);
            this.postToWorker({ type: "response", requestId, result: preset });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetsUpdate(requestId, presetId, input, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const requestedInput = input || {};
            if (requestedInput.expected_cache_revision === undefined) {
                throw new Error("Preset revision is required for preset updates");
            }
            const preset = presetsSvc.updatePreset(resolvedUserId, presetId, requestedInput);
            if (!preset)
                throw new Error("Preset not found");
            this.postToWorker({ type: "response", requestId, result: preset });
        }
        catch (err) {
            const error = err instanceof PresetRevisionConflictError
                ? {
                    code: err.code,
                    message: err.message,
                    presetId: err.presetId,
                    expectedCacheRevision: err.expectedCacheRevision,
                    actualCacheRevision: err.actualCacheRevision,
                }
                : err.message;
            // The published 0.6.2 host contract types errors as strings; the
            // revision-safe candidate widens this field to structured metadata.
            this.postToWorker({ type: "response", requestId, error: error });
        }
    }
    handlePresetsDelete(requestId, presetId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            this.postToWorker({ type: "response", requestId, result: presetsSvc.deletePreset(resolvedUserId, presetId) });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetBlocksList(requestId, presetId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const blocks = presetsSvc.listPromptBlocks(resolvedUserId, presetId);
            if (!blocks)
                throw new Error("Preset not found");
            this.postToWorker({ type: "response", requestId, result: blocks });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetBlocksGet(requestId, presetId, blockId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            this.postToWorker({ type: "response", requestId, result: presetsSvc.getPromptBlock(resolvedUserId, presetId, blockId) });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetBlocksCreate(requestId, presetId, input, index, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const block = presetsSvc.createPromptBlock(resolvedUserId, presetId, input || {}, index);
            if (!block)
                throw new Error("Preset not found");
            this.postToWorker({ type: "response", requestId, result: block });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetBlocksUpdate(requestId, presetId, blockId, input, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const block = presetsSvc.updatePromptBlock(resolvedUserId, presetId, blockId, input || {});
            if (!block)
                throw new Error("Prompt block not found");
            this.postToWorker({ type: "response", requestId, result: block });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetBlocksDelete(requestId, presetId, blockId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            this.postToWorker({ type: "response", requestId, result: presetsSvc.deletePromptBlock(resolvedUserId, presetId, blockId) });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
    handlePresetCategoriesList(requestId, presetId, userId) {
        try {
            const resolvedUserId = this.resolvePresetUserOrThrow(userId);
            const groups = presetsSvc.listPromptBlockCategories(resolvedUserId, presetId);
            if (!groups)
                throw new Error("Preset not found");
            this.postToWorker({ type: "response", requestId, result: groups });
        }
        catch (err) {
            this.postToWorker({ type: "response", requestId, error: err.message });
        }
    }
}
