import { getEffectiveCharacterName } from "../types/character";
export function resolvePersonaPronouns(persona) {
    return {
        subjective: persona?.subjective_pronoun?.trim() || "they",
        objective: persona?.objective_pronoun?.trim() || "them",
        possessive: persona?.possessive_pronoun?.trim() || "their",
        reflexive: persona?.reflexive_pronoun?.trim() || "themselves",
        possessiveStandalone: persona?.possessive_pronoun_standalone?.trim() || "theirs",
    };
}
export function buildEnv(ctx) {
    const { character, persona, chat, messages, generationType, connection } = ctx;
    const focusedCharacter = ctx.focusedCharacter ?? character;
    const personaPronouns = resolvePersonaPronouns(persona);
    const personaAddonOutlets = buildPersonaAddonOutlets(persona);
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastUserMsg = findLast(messages, (m) => m.is_user);
    const lastCharMsg = findLast(messages, (m) => !m.is_user);
    const isGroup = !!chat.metadata?.group && Array.isArray(chat.metadata?.character_ids);
    const allGroupNames = ctx.groupCharacterNames;
    const focusedName = isGroup ? (ctx.targetCharacterName || getEffectiveCharacterName(focusedCharacter)) : "";
    const groupLastSpeaker = isGroup
        ? (findLast(messages, (m) => !m.is_user)?.name || "")
        : "";
    // Resolve the card composition mode. Mirrors the gate in prompt-assembly's
    // getGroupCardMode — anything not explicitly "merge" / "merge_ignore_muted"
    // falls back to "swap". Solo chats short-circuit to "solo".
    const rawCardMode = chat.metadata?.group_card_mode;
    const groupCardMode = !isGroup
        ? "solo"
        : (rawCardMode === "merge" || rawCardMode === "merge_ignore_muted")
            ? rawCardMode
            : "swap";
    return {
        commit: ctx.commit !== false,
        names: {
            user: persona?.name || "User",
            char: getEffectiveCharacterName(character),
            group: allGroupNames?.join(", ") ?? "",
            groupNotMuted: (ctx.groupNotMutedNames ?? allGroupNames)?.join(", ") ?? "",
            notChar: persona?.name || "User",
            charGroupFocused: focusedName,
            groupOthers: isGroup && allGroupNames
                ? allGroupNames.filter((n) => n !== focusedName).join(", ")
                : "",
            groupMemberCount: isGroup && allGroupNames ? String(allGroupNames.length) : "0",
            isGroupChat: isGroup ? "yes" : "no",
            isNarrator: persona?.is_narrator ? "yes" : "no",
            groupLastSpeaker,
            groupCardMode,
        },
        character: {
            name: character.name,
            description: character.description || "",
            personality: character.personality || "",
            scenario: character.scenario || "",
            persona: buildPersonaWithAddons(persona),
            personaSubjectivePronoun: personaPronouns.subjective,
            personaObjectivePronoun: personaPronouns.objective,
            personaPossessivePronoun: personaPronouns.possessive,
            personaReflexivePronoun: personaPronouns.reflexive,
            personaPossessivePronounStandalone: personaPronouns.possessiveStandalone,
            mesExamples: character.mes_example || "",
            mesExamplesRaw: character.mes_example || "",
            systemPrompt: character.system_prompt || "",
            postHistoryInstructions: character.post_history_instructions || "",
            depthPrompt: character.extensions?.depth_prompt || "",
            creatorNotes: character.creator_notes || "",
            version: character.extensions?.version || "",
            creator: character.creator || "",
            firstMessage: resolveChatGreeting(character, chat, messages),
            alternateGreetings: [...(character.alternate_greetings || [])],
        },
        chat: {
            id: chat.id,
            messageCount: messages.length,
            lastMessage: lastMsg?.content || "",
            lastMessageName: lastMsg?.name || "",
            lastUserMessage: lastUserMsg?.content || "",
            lastCharMessage: lastCharMsg?.content || "",
            lastMessageId: lastMsg ? messages.length - 1 : -1,
            firstIncludedMessageId: messages.length > 0 ? 0 : -1,
            lastSwipeId: lastMsg?.swipes ? lastMsg.swipes.length - 1 : 0,
            currentSwipeId: lastMsg?.swipe_id ?? 0,
            rejectedSwipe: ctx.rejectedSwipe ?? "",
            greetingIndex: resolveChatGreetingIndex(character, chat, messages),
        },
        system: {
            model: connection?.model || "",
            maxPrompt: 0,
            maxContext: 0,
            maxResponse: 0,
            lastGenerationType: generationType,
            isMobile: false,
        },
        variables: {
            local: new Map(),
            global: new Map(Object.entries(chat.metadata?.macro_variables?.global || {})),
            chat: new Map(Object.entries(chat.metadata?.chat_variables || {})),
        },
        dynamicMacros: ctx.dynamicMacros || {},
        _dynamicMacrosLower: buildDynamicLookup(ctx.dynamicMacros),
        signal: ctx.signal,
        extra: {
            userId: ctx.userId ?? chat.user_id,
            characterId: character.id,
            groupFocusedCharacter: buildFocusedCharacterMacroState(focusedCharacter, chat, messages),
            messages: messages.map((m) => ({ content: m.content, name: m.name, is_user: m.is_user })),
            chatCreatedAt: chat.created_at,
            characterTags: Array.isArray(character.tags) ? character.tags : [],
            // Idle duration is relative to the most recent character/assistant
            // message. A newly sent user message must not reset it to zero before
            // the preset is assembled.
            lastMessageTime: lastCharMsg && typeof lastCharMsg.send_date === "number"
                ? lastCharMsg.send_date * 1000
                : undefined,
            userInput: ctx.userInput ?? "",
            // Persona outlets are intentionally separate from Lorebook outlets.
            // `{{persona_outlet::name}}` reads this map; `{{outlet::name}}` reads
            // worldInfoOutlets, which is populated only by world-info activation.
            personaAddonOutlets,
        },
    };
}
function buildFocusedCharacterMacroState(character, chat, messages) {
    return {
        id: character.id,
        name: getEffectiveCharacterName(character),
        description: character.description || "",
        personality: character.personality || "",
        scenario: character.scenario || "",
        mesExamples: character.mes_example || "",
        systemPrompt: character.system_prompt || "",
        postHistoryInstructions: character.post_history_instructions || "",
        depthPrompt: character.extensions?.depth_prompt || "",
        creatorNotes: character.creator_notes || "",
        version: character.extensions?.version || "",
        creator: character.creator || "",
        firstMessage: resolveChatGreeting(character, chat, messages),
    };
}
export function cloneEnv(env) {
    return {
        commit: env.commit !== false,
        names: { ...env.names },
        character: { ...env.character },
        chat: { ...env.chat },
        system: { ...env.system },
        variables: {
            local: new Map(env.variables.local),
            global: new Map(env.variables.global),
            chat: new Map(env.variables.chat),
        },
        ...(env._chatVarsDirty ? { _chatVarsDirty: true } : {}),
        ...(env.promptBlock ? { promptBlock: { ...env.promptBlock } } : {}),
        dynamicMacros: { ...env.dynamicMacros },
        _dynamicMacrosLower: env._dynamicMacrosLower
            ? new Map(env._dynamicMacrosLower)
            : undefined,
        signal: env.signal,
        extra: { ...env.extra },
    };
}
/**
 * Run work with the supplied preset block as the read-only macro context.
 * The previous context is always restored so later assembly phases cannot
 * accidentally inherit placement from an earlier block.
 */
export async function withPromptBlockContext(env, block, work) {
    const previous = env.promptBlock;
    env.promptBlock = { ...block };
    // Prompt-variable values are stored by block, but the legacy macro surface
    // ({{var::name}}, {{getvar::name}}, and {{.name}}) reads the flat local map.
    // Temporarily overlay this block's own resolved bucket so a later block with
    // a same-named variable cannot shadow the value while this block renders.
    // Writes made by {{setvar::...}} during the block still update the overlay
    // normally; the previous assembly scope is restored afterward.
    const byBlock = env.extra.promptVariablesByBlock;
    const blockValues = block.id ? byBlock?.[block.id] : undefined;
    const saved = new Map();
    if (blockValues) {
        for (const [name, value] of Object.entries(blockValues)) {
            saved.set(name, {
                existed: env.variables.local.has(name),
                value: env.variables.local.get(name),
            });
            env.variables.local.set(name, String(value));
        }
    }
    try {
        return await work();
    }
    finally {
        for (const [name, prior] of saved) {
            if (prior.existed)
                env.variables.local.set(name, prior.value ?? "");
            else
                env.variables.local.delete(name);
        }
        env.promptBlock = previous;
    }
}
function resolveChatGreeting(character, chat, messages) {
    const metadataOverride = chat.metadata?.greeting_override;
    if (typeof metadataOverride === "string")
        return metadataOverride;
    if (chat.metadata?.group) {
        const taggedGreeting = messages.find((message) => !message.is_user
            && message.extra?.greeting === true
            && message.extra?.greeting_character_id === character.id);
        return taggedGreeting?.content || character.first_mes || "";
    }
    const taggedGreeting = messages.find((message) => !message.is_user && message.extra?.greeting === true);
    if (taggedGreeting?.content)
        return taggedGreeting.content;
    const openingMessage = messages[0];
    if (openingMessage && !openingMessage.is_user)
        return openingMessage.content;
    return character.first_mes || "";
}
function resolveChatGreetingIndex(character, chat, messages) {
    const metadataIndex = chat.metadata?.activeGreetingIndex;
    if (Number.isInteger(metadataIndex) && metadataIndex >= 0) {
        return metadataIndex;
    }
    const taggedGreeting = chat.metadata?.group
        ? messages.find((message) => !message.is_user
            && message.extra?.greeting === true
            && message.extra?.greeting_character_id === character.id)
        : messages.find((message) => !message.is_user && message.extra?.greeting === true);
    const storedIndex = taggedGreeting?.extra?.greeting_index;
    return Number.isInteger(storedIndex) && storedIndex >= 0 ? storedIndex : 0;
}
export function mergeDynamicMacros(env, overrides) {
    if (!overrides)
        return;
    for (const k of Object.keys(overrides)) {
        env.dynamicMacros[k] = overrides[k];
    }
    env._dynamicMacrosLower = buildDynamicLookup(env.dynamicMacros);
}
/** Build a lowercase-keyed Map from dynamicMacros for O(1) lookup. */
function buildDynamicLookup(macros) {
    if (!macros)
        return undefined;
    const keys = Object.keys(macros);
    if (keys.length === 0)
        return undefined;
    const map = new Map();
    for (const k of keys) {
        map.set(k.toLowerCase(), macros[k]);
    }
    return map;
}
/**
 * Resolve group character names from chat metadata for group chats.
 * Returns the names array, or undefined if not a group chat.
 * @param chat The chat object
 * @param getCharacterName Lookup function: (characterId) => name | undefined
 */
export function resolveGroupCharacterNames(chat, getCharacterName) {
    const meta = chat.metadata;
    if (!meta?.group || !Array.isArray(meta.character_ids))
        return undefined;
    const names = [];
    for (const cid of meta.character_ids) {
        const name = getCharacterName(cid);
        if (name)
            names.push(name);
    }
    return names.length > 0 ? names : undefined;
}
function buildPersonaWithAddons(persona) {
    if (!persona)
        return "";
    const base = persona.description || "";
    // Persona-specific add-ons
    const personaAddons = persona.metadata?.addons;
    const enabledPersonaContent = Array.isArray(personaAddons)
        ? personaAddons
            .filter((a) => a.enabled && a.content && !getAddonOutletName(a))
            .slice()
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map((a) => a.content.trim())
            .filter(Boolean)
        : [];
    // Global add-ons (resolved upstream in prompt assembly, injected into metadata)
    const globalAddons = persona.metadata?._resolvedGlobalAddons;
    const enabledGlobalContent = Array.isArray(globalAddons)
        ? globalAddons
            .slice()
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map((a) => (a.content || "").trim())
            .filter(Boolean)
        : [];
    const allContent = [...enabledPersonaContent, ...enabledGlobalContent];
    if (allContent.length === 0)
        return base;
    return base ? `${base}\n${allContent.join("\n")}` : allContent.join("\n");
}
/**
 * Persona add-ons can opt out of the normal `{{persona}}` append-only flow
 * and instead publish their content through the separate `persona_outlet`
 * macro namespace. The name is normalized for case-insensitive lookup.
 */
function buildPersonaAddonOutlets(persona) {
    const addons = persona?.metadata?.addons;
    if (!Array.isArray(addons))
        return {};
    const outlets = new Map();
    for (const addon of addons
        .filter((value) => value?.enabled && typeof value.content === "string")
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
        const outletName = getAddonOutletName(addon);
        const content = addon.content.trim();
        if (!outletName || !content)
            continue;
        const existing = outlets.get(outletName);
        outlets.set(outletName, existing ? `${existing}\n\n${content}` : content);
    }
    return Object.fromEntries(outlets);
}
function getAddonOutletName(addon) {
    const value = addon?.outlet_name ?? addon?.outletName;
    if (typeof value !== "string")
        return null;
    const name = value.trim().toLowerCase();
    return name || null;
}
function findLast(messages, predicate) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (predicate(messages[i]))
            return messages[i];
    }
    return null;
}
