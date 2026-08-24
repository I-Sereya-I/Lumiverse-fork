const SYSTEM_ORIGIN = Object.freeze({ kind: "system" });
function sameOrigin(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === "system")
        return true;
    return right.kind === "extension" && left.extensionId === right.extensionId;
}
export class MacroRegistry {
    macros = new Map();
    aliases = new Map();
    registerMacro(def, origin = SYSTEM_ORIGIN) {
        const key = def.name.toLowerCase();
        const existingPrimary = this.aliases.get(key) ?? key;
        const existing = this.macros.get(existingPrimary);
        if (origin.kind === "extension" && existing && !sameOrigin(existing.origin, origin)) {
            return false;
        }
        const aliases = (def.aliases ?? []).map((alias) => alias.toLowerCase());
        for (const alias of aliases) {
            const aliasPrimary = this.aliases.get(alias) ?? alias;
            const aliasExisting = this.macros.get(aliasPrimary);
            if (origin.kind === "extension" && aliasExisting && !sameOrigin(aliasExisting.origin, origin)) {
                return false;
            }
        }
        // A same-owner re-registration replaces its old aliases atomically.
        if (existing && sameOrigin(existing.origin, origin)) {
            if (existingPrimary !== key)
                this.macros.delete(existingPrimary);
            this.removeAliasesFor(existingPrimary);
        }
        this.macros.set(key, { definition: def, origin });
        for (const alias of aliases) {
            this.aliases.set(alias, key);
        }
        return true;
    }
    registerAlias(primaryName, alias, origin = SYSTEM_ORIGIN) {
        const primary = primaryName.toLowerCase();
        const registration = this.macros.get(primary);
        if (!registration || !sameOrigin(registration.origin, origin))
            return false;
        const aliasKey = alias.toLowerCase();
        const existingPrimary = this.aliases.get(aliasKey) ?? aliasKey;
        const existing = this.macros.get(existingPrimary);
        if (origin.kind === "extension" && existing && !sameOrigin(existing.origin, origin))
            return false;
        this.aliases.set(aliasKey, primary);
        return true;
    }
    unregisterMacro(name, origin = SYSTEM_ORIGIN) {
        const key = name.toLowerCase();
        const primary = this.aliases.get(key) ?? key;
        const registration = this.macros.get(primary);
        if (!registration || !sameOrigin(registration.origin, origin))
            return false;
        this.macros.delete(primary);
        this.removeAliasesFor(primary);
        return true;
    }
    unregisterByExtension(extensionId) {
        for (const [name, registration] of this.macros.entries()) {
            if (registration.origin.kind === "extension" && registration.origin.extensionId === extensionId) {
                this.macros.delete(name);
                this.removeAliasesFor(name);
            }
        }
    }
    removeAliasesFor(primary) {
        for (const [alias, target] of this.aliases.entries()) {
            if (alias === primary || target === primary) {
                this.aliases.delete(alias);
            }
        }
    }
    getMacro(name) {
        return this.getRegistration(name)?.definition ?? null;
    }
    getMacroOrigin(name) {
        return this.getRegistration(name)?.origin ?? null;
    }
    getRegistration(name) {
        const key = name.toLowerCase();
        const registration = this.macros.get(key);
        if (registration)
            return registration;
        const primary = this.aliases.get(key);
        if (primary)
            return this.macros.get(primary) ?? null;
        return null;
    }
    hasMacro(name) {
        return this.getMacro(name) !== null;
    }
    getAllMacros() {
        return Array.from(this.macros.values(), ({ definition }) => definition);
    }
    getCategories() {
        const cats = new Map();
        for (const { definition: def } of this.macros.values()) {
            const list = cats.get(def.category) ?? [];
            list.push(def);
            cats.set(def.category, list);
        }
        return Array.from(cats.entries()).map(([category, macros]) => ({ category, macros }));
    }
}
/** Singleton registry instance */
export const registry = new MacroRegistry();
