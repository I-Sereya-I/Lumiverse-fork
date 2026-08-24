/** Shared types for the multiplayer rooms feature. A "room" IS the host's chat. */
/** Hard ceiling on peers (host excluded). Never exceeded regardless of settings. */
export const HARD_MAX_PEERS = 8;
export const DEFAULT_FREEFORM_WINDOW_SEC = 120;
export const MIN_FREEFORM_WINDOW_SEC = 10;
export const MAX_FREEFORM_WINDOW_SEC = 3600;
/** Max accepted lengths for untrusted peer-supplied fields. */
export const MAX_DISPLAY_NAME_LEN = 64;
export const MAX_PERSONA_NAME_LEN = 64;
export const MAX_PERSONA_DESCRIPTION_LEN = 4000;
export const MAX_ROOM_MESSAGE_BYTES = 16 * 1024; // 16 KB per peer message
export const MAX_AVATAR_URL_LEN = 512;
/** Cap for an embedded `data:` WebP avatar (a small compressed thumbnail). */
export const MAX_AVATAR_DATA_URL_LEN = 24 * 1024;
