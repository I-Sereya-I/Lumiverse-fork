export var EventType;
(function (EventType) {
    // Connection
    EventType["CONNECTED"] = "CONNECTED";
    // Chat lifecycle
    EventType["CHAT_CREATED"] = "CHAT_CREATED";
    EventType["CHAT_CHANGED"] = "CHAT_CHANGED";
    EventType["CHAT_SWITCHED"] = "CHAT_SWITCHED";
    EventType["CHAT_DELETED"] = "CHAT_DELETED";
    EventType["CHAT_FORKED"] = "CHAT_FORKED";
    EventType["MESSAGE_SENT"] = "MESSAGE_SENT";
    EventType["MESSAGE_EDITED"] = "MESSAGE_EDITED";
    EventType["MESSAGE_DELETED"] = "MESSAGE_DELETED";
    EventType["MESSAGE_SWIPED"] = "MESSAGE_SWIPED";
    EventType["SWIPE_EDITED"] = "SWIPE_EDITED";
    EventType["CHARACTER_MESSAGE_RENDERED"] = "CHARACTER_MESSAGE_RENDERED";
    EventType["USER_MESSAGE_RENDERED"] = "USER_MESSAGE_RENDERED";
    // Generation
    EventType["GENERATION_STARTED"] = "GENERATION_STARTED";
    EventType["GENERATION_ENDED"] = "GENERATION_ENDED";
    EventType["GENERATION_STOPPED"] = "GENERATION_STOPPED";
    EventType["GENERATION_ACKNOWLEDGED"] = "GENERATION_ACKNOWLEDGED";
    EventType["GENERATION_IN_PROGRESS"] = "GENERATION_IN_PROGRESS";
    EventType["GENERATION_PHASE_CHANGED"] = "GENERATION_PHASE_CHANGED";
    // Deferred post-generation bookkeeping (tokenCount / TTFT / TPS) finished and
    // was persisted. Emitted after GENERATION_ENDED so the detail pill + hover
    // tooltip can fill in without a reload — the terminal event stays cheap.
    EventType["GENERATION_METRICS_READY"] = "GENERATION_METRICS_READY";
    // Deferred prompt-breakdown tokenization finished. Emitted after
    // GENERATION_ENDED (and separately from METRICS_READY so the pill isn't held
    // behind the heavier breakdown count) so an opened Prompt Breakdown modal can
    // render from cache instead of re-fetching.
    EventType["GENERATION_BREAKDOWN_READY"] = "GENERATION_BREAKDOWN_READY";
    EventType["STREAM_TOKEN_RECEIVED"] = "STREAM_TOKEN_RECEIVED";
    // Entities
    EventType["CHARACTER_CREATED"] = "CHARACTER_CREATED";
    EventType["CHARACTER_EDITED"] = "CHARACTER_EDITED";
    EventType["CHARACTER_DELETED"] = "CHARACTER_DELETED";
    EventType["CHARACTER_DUPLICATED"] = "CHARACTER_DUPLICATED";
    /** Coarse invalidation for bulk workflows that intentionally suppress per-row events. */
    EventType["CHARACTER_LIBRARY_CHANGED"] = "CHARACTER_LIBRARY_CHANGED";
    EventType["PERSONA_CHANGED"] = "PERSONA_CHANGED";
    // Images
    EventType["IMAGE_UPLOADED"] = "IMAGE_UPLOADED";
    EventType["IMAGE_DELETED"] = "IMAGE_DELETED";
    EventType["WALLPAPER_UPLOAD_PROGRESS"] = "WALLPAPER_UPLOAD_PROGRESS";
    // Settings
    EventType["SETTINGS_UPDATED"] = "SETTINGS_UPDATED";
    EventType["PRESET_CHANGED"] = "PRESET_CHANGED";
    EventType["PRESET_DELETED"] = "PRESET_DELETED";
    EventType["CONNECTION_PROFILE_LOADED"] = "CONNECTION_PROFILE_LOADED";
    EventType["MAIN_API_CHANGED"] = "MAIN_API_CHANGED";
    EventType["WORLD_INFO_ACTIVATED"] = "WORLD_INFO_ACTIVATED";
    // Preset Profiles
    EventType["PRESET_PROFILE_CHANGED"] = "PRESET_PROFILE_CHANGED";
    // Packs
    EventType["PACK_CHANGED"] = "PACK_CHANGED";
    EventType["PACK_DELETED"] = "PACK_DELETED";
    // Council
    EventType["COUNCIL_STARTED"] = "COUNCIL_STARTED";
    EventType["COUNCIL_MEMBER_DONE"] = "COUNCIL_MEMBER_DONE";
    EventType["COUNCIL_COMPLETED"] = "COUNCIL_COMPLETED";
    EventType["COUNCIL_TOOLS_FAILED"] = "COUNCIL_TOOLS_FAILED";
    EventType["WEAVER_VISUAL_JOB_CREATED"] = "WEAVER_VISUAL_JOB_CREATED";
    EventType["WEAVER_VISUAL_JOB_PROGRESS"] = "WEAVER_VISUAL_JOB_PROGRESS";
    EventType["WEAVER_VISUAL_JOB_COMPLETED"] = "WEAVER_VISUAL_JOB_COMPLETED";
    EventType["WEAVER_VISUAL_JOB_FAILED"] = "WEAVER_VISUAL_JOB_FAILED";
    // Spindle extension events
    EventType["SPINDLE_EXTENSION_LOADED"] = "SPINDLE_EXTENSION_LOADED";
    EventType["SPINDLE_EXTENSION_UNLOADED"] = "SPINDLE_EXTENSION_UNLOADED";
    EventType["SPINDLE_EXTENSION_ERROR"] = "SPINDLE_EXTENSION_ERROR";
    EventType["SPINDLE_EXTENSION_STATUS"] = "SPINDLE_EXTENSION_STATUS";
    EventType["SPINDLE_RUNTIME_STATS"] = "SPINDLE_RUNTIME_STATS";
    EventType["SPINDLE_PRE_GENERATION_ACTIVITY"] = "SPINDLE_PRE_GENERATION_ACTIVITY";
    EventType["SPINDLE_BULK_UPDATE_PROGRESS"] = "SPINDLE_BULK_UPDATE_PROGRESS";
    EventType["SPINDLE_BULK_UPDATE_COMPLETE"] = "SPINDLE_BULK_UPDATE_COMPLETE";
    EventType["SPINDLE_BATCH_CHANGED"] = "SPINDLE_BATCH_CHANGED";
    EventType["SPINDLE_FRONTEND_MSG"] = "SPINDLE_FRONTEND_MSG";
    EventType["SPINDLE_FRONTEND_PROCESS"] = "SPINDLE_FRONTEND_PROCESS";
    EventType["SPINDLE_FRONTEND_RUNTIME_CAPABILITY_CHANGED"] = "SPINDLE_FRONTEND_RUNTIME_CAPABILITY_CHANGED";
    EventType["SPINDLE_TOAST"] = "SPINDLE_TOAST";
    EventType["MESSAGE_TAG_INTERCEPTED"] = "MESSAGE_TAG_INTERCEPTED";
    // Spindle text editor
    EventType["SPINDLE_TEXT_EDITOR_OPEN"] = "SPINDLE_TEXT_EDITOR_OPEN";
    EventType["SPINDLE_TEXT_EDITOR_RESULT"] = "SPINDLE_TEXT_EDITOR_RESULT";
    // Spindle modal
    EventType["SPINDLE_MODAL_OPEN"] = "SPINDLE_MODAL_OPEN";
    EventType["SPINDLE_MODAL_RESULT"] = "SPINDLE_MODAL_RESULT";
    EventType["SPINDLE_CONFIRM_OPEN"] = "SPINDLE_CONFIRM_OPEN";
    EventType["SPINDLE_CONFIRM_RESULT"] = "SPINDLE_CONFIRM_RESULT";
    EventType["SPINDLE_INPUT_PROMPT_OPEN"] = "SPINDLE_INPUT_PROMPT_OPEN";
    EventType["SPINDLE_INPUT_PROMPT_RESULT"] = "SPINDLE_INPUT_PROMPT_RESULT";
    // Tool invocation (Spindle extension tools)
    EventType["TOOL_INVOCATION"] = "TOOL_INVOCATION";
    // Regex Scripts
    EventType["REGEX_SCRIPT_CHANGED"] = "REGEX_SCRIPT_CHANGED";
    EventType["REGEX_SCRIPT_DELETED"] = "REGEX_SCRIPT_DELETED";
    // World Books
    EventType["WORLD_BOOK_CHANGED"] = "WORLD_BOOK_CHANGED";
    /** Coarse invalidation for bulk workflows that suppress per-book payloads. */
    EventType["WORLD_BOOK_LIBRARY_CHANGED"] = "WORLD_BOOK_LIBRARY_CHANGED";
    EventType["WORLD_BOOK_DELETED"] = "WORLD_BOOK_DELETED";
    EventType["WORLD_BOOK_ENTRY_CHANGED"] = "WORLD_BOOK_ENTRY_CHANGED";
    EventType["WORLD_BOOK_ENTRY_DELETED"] = "WORLD_BOOK_ENTRY_DELETED";
    // Expressions
    EventType["EXPRESSION_CHANGED"] = "EXPRESSION_CHANGED";
    // Avatar
    EventType["CHARACTER_AVATAR_CHANGED"] = "CHARACTER_AVATAR_CHANGED";
    EventType["CHARACTER_EXPORT_PROGRESS"] = "CHARACTER_EXPORT_PROGRESS";
    // Image Gen Connections
    EventType["IMAGE_GEN_CONNECTION_CHANGED"] = "IMAGE_GEN_CONNECTION_CHANGED";
    // Image Gen Streaming (Comfy/Swarm progress)
    EventType["IMAGE_GEN_PROGRESS"] = "IMAGE_GEN_PROGRESS";
    EventType["IMAGE_GEN_COMPLETE"] = "IMAGE_GEN_COMPLETE";
    EventType["IMAGE_GEN_ERROR"] = "IMAGE_GEN_ERROR";
    // TTS Connections
    EventType["TTS_CONNECTION_CHANGED"] = "TTS_CONNECTION_CHANGED";
    // STT Connections
    EventType["STT_CONNECTION_CHANGED"] = "STT_CONNECTION_CHANGED";
    // Theme overrides (Spindle extensions)
    EventType["SPINDLE_THEME_OVERRIDES"] = "SPINDLE_THEME_OVERRIDES";
    // Per-chat CSS containment mode (Spindle extensions, app_manipulation)
    EventType["SPINDLE_CHAT_STYLE_MODE"] = "SPINDLE_CHAT_STYLE_MODE";
    // Spindle permission changes (broadcast with extensionId so frontends can scope)
    EventType["SPINDLE_PERMISSION_CHANGED"] = "SPINDLE_PERMISSION_CHANGED";
    // Spindle provider registry (recipient-scoped; never a system broadcast)
    EventType["SPINDLE_PROVIDER_CHANGED"] = "SPINDLE_PROVIDER_CHANGED";
    // Spindle command palette commands
    EventType["SPINDLE_COMMANDS_CHANGED"] = "SPINDLE_COMMANDS_CHANGED";
    // Spindle UI automation (navigate drawer/settings/command palette)
    EventType["SPINDLE_UI_NAVIGATE"] = "SPINDLE_UI_NAVIGATE";
    // Import progress
    EventType["IMPORT_GALLERY_PROGRESS"] = "IMPORT_GALLERY_PROGRESS";
    // User-data export/import (portability)
    EventType["USER_EXPORT_PROGRESS"] = "USER_EXPORT_PROGRESS";
    EventType["USER_IMPORT_PROGRESS"] = "USER_IMPORT_PROGRESS";
    EventType["USER_IMPORT_COMPLETE"] = "USER_IMPORT_COMPLETE";
    EventType["USER_IMPORT_FAILED"] = "USER_IMPORT_FAILED";
    // LumiHub remote install
    EventType["LUMIHUB_INSTALL_STARTED"] = "LUMIHUB_INSTALL_STARTED";
    EventType["LUMIHUB_INSTALL_COMPLETED"] = "LUMIHUB_INSTALL_COMPLETED";
    EventType["LUMIHUB_INSTALL_FAILED"] = "LUMIHUB_INSTALL_FAILED";
    EventType["LUMIHUB_CONNECTION_CHANGED"] = "LUMIHUB_CONNECTION_CHANGED";
    // SillyTavern Migration
    EventType["MIGRATION_PROGRESS"] = "MIGRATION_PROGRESS";
    EventType["MIGRATION_LOG"] = "MIGRATION_LOG";
    EventType["MIGRATION_COMPLETED"] = "MIGRATION_COMPLETED";
    EventType["MIGRATION_FAILED"] = "MIGRATION_FAILED";
    // Operator panel
    EventType["OPERATOR_LOG"] = "OPERATOR_LOG";
    EventType["OPERATOR_STATUS"] = "OPERATOR_STATUS";
    EventType["OPERATOR_PROGRESS"] = "OPERATOR_PROGRESS";
    EventType["IMAGE_THUMBNAIL_QUEUE"] = "IMAGE_THUMBNAIL_QUEUE";
    // Memory Cortex
    EventType["CORTEX_REBUILD_PROGRESS"] = "CORTEX_REBUILD_PROGRESS";
    EventType["CORTEX_INGESTION_PROGRESS"] = "CORTEX_INGESTION_PROGRESS";
    EventType["CORTEX_VAULT_CREATED"] = "CORTEX_VAULT_CREATED";
    EventType["CORTEX_VAULT_REINDEXED"] = "CORTEX_VAULT_REINDEXED";
    EventType["CORTEX_LINK_CHANGED"] = "CORTEX_LINK_CHANGED";
    // MCP Servers
    EventType["MCP_SERVER_CONNECTED"] = "MCP_SERVER_CONNECTED";
    EventType["MCP_SERVER_DISCONNECTED"] = "MCP_SERVER_DISCONNECTED";
    EventType["MCP_SERVER_ERROR"] = "MCP_SERVER_ERROR";
    EventType["MCP_SERVER_CHANGED"] = "MCP_SERVER_CHANGED";
    // Databank
    EventType["DATABANK_CHANGED"] = "DATABANK_CHANGED";
    EventType["DATABANK_DELETED"] = "DATABANK_DELETED";
    EventType["DATABANK_DOCUMENT_STATUS"] = "DATABANK_DOCUMENT_STATUS";
    // Global Add-Ons
    EventType["GLOBAL_ADDON_CHANGED"] = "GLOBAL_ADDON_CHANGED";
    EventType["GLOBAL_ADDON_DELETED"] = "GLOBAL_ADDON_DELETED";
    // Loom summary auto-summarization
    EventType["SUMMARIZATION_STARTED"] = "SUMMARIZATION_STARTED";
    EventType["SUMMARIZATION_PROGRESS"] = "SUMMARIZATION_PROGRESS";
    EventType["SUMMARIZATION_COMPLETED"] = "SUMMARIZATION_COMPLETED";
    EventType["SUMMARIZATION_FAILED"] = "SUMMARIZATION_FAILED";
    // System health
    EventType["SYSTEM_DISK_LOW"] = "SYSTEM_DISK_LOW";
    EventType["SYSTEM_SMART_ALERT"] = "SYSTEM_SMART_ALERT";
    // Multiplayer rooms (broadcast to the room:{roomId} topic). Peer chat
    // messages and bot stream tokens reuse MESSAGE_SENT / STREAM_TOKEN_RECEIVED /
    // GENERATION_* (re-broadcast to the room topic by the fan-out listener) — these
    // only cover room lifecycle, turn, persona-relay and moderation.
    EventType["ROOM_STATUS"] = "ROOM_STATUS";
    EventType["ROOM_PARTICIPANT_JOINED"] = "ROOM_PARTICIPANT_JOINED";
    EventType["ROOM_PARTICIPANT_LEFT"] = "ROOM_PARTICIPANT_LEFT";
    EventType["ROOM_PARTICIPANT_KICKED"] = "ROOM_PARTICIPANT_KICKED";
    EventType["ROOM_PERSONA_CHANGED"] = "ROOM_PERSONA_CHANGED";
    EventType["ROOM_TURN_CHANGED"] = "ROOM_TURN_CHANGED";
    EventType["ROOM_TURN_SKIPPED"] = "ROOM_TURN_SKIPPED";
    EventType["ROOM_PRESENCE"] = "ROOM_PRESENCE";
    EventType["ROOM_ROUND_COMPLETE"] = "ROOM_ROUND_COMPLETE";
    /** Host-only: a fresh remote invite code (auto-rolled after one is redeemed). */
    EventType["ROOM_INVITE_CODE"] = "ROOM_INVITE_CODE";
})(EventType || (EventType = {}));
