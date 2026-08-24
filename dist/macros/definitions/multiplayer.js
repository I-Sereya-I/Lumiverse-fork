import { registry } from "../MacroRegistry";
/** Read the room snapshot off the env, or null when this chat isn't a room. */
function mpContext(ctx) {
    const mp = ctx.env.extra?.multiplayer;
    if (mp && Array.isArray(mp.playerNames)) {
        return mp;
    }
    return null;
}
export function registerMultiplayerMacros() {
    registry.registerMacro({
        builtIn: true,
        terminal: true,
        name: "isMultiplayer",
        category: "Multiplayer",
        description: 'Whether the current chat is a multiplayer room — "yes" or "no". Usable as an {{if}} condition.',
        returnType: "boolean",
        aliases: ["is_multiplayer", "isMultiplayerRoom", "is_multiplayer_room"],
        handler: (ctx) => (mpContext(ctx) ? "yes" : "no"),
    });
    registry.registerMacro({
        builtIn: true,
        terminal: true,
        name: "playerCount",
        category: "Multiplayer",
        description: "Number of active players in the room (host + peers). 0 outside a room.",
        returnType: "integer",
        aliases: ["player_count", "playersCount", "players_count"],
        handler: (ctx) => String(mpContext(ctx)?.playerCount ?? 0),
    });
    registry.registerMacro({
        builtIn: true,
        terminal: true,
        name: "players",
        category: "Multiplayer",
        description: "Comma-separated names of all active players (host first). Empty outside a room. Pairs with {{foreach}}.",
        returnType: "string",
        aliases: ["player_names", "playerNames"],
        handler: (ctx) => (mpContext(ctx)?.playerNames ?? []).join(", "),
    });
    registry.registerMacro({
        builtIn: true,
        terminal: true,
        name: "hostName",
        category: "Multiplayer",
        description: "Display name of the room's host. Empty outside a room.",
        returnType: "string",
        aliases: ["host_name"],
        handler: (ctx) => mpContext(ctx)?.hostName ?? "",
    });
    registry.registerMacro({
        builtIn: true,
        terminal: true,
        name: "currentPlayer",
        category: "Multiplayer",
        description: "Name of the player whose turn it is (round-robin rooms). Empty in freeform rooms or outside a room.",
        returnType: "string",
        aliases: ["current_player", "currentTurn", "current_turn"],
        handler: (ctx) => mpContext(ctx)?.currentTurnName ?? "",
    });
}
