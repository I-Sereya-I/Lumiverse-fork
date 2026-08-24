export function warn(message, macroName, offset) {
    return { level: "warn", message, macroName, offset };
}
export function error(message, macroName, offset) {
    return { level: "error", message, macroName, offset };
}
export function formatDiagnostics(diagnostics) {
    return diagnostics
        .map((d) => {
        const prefix = d.level === "error" ? "ERROR" : "WARN";
        const loc = d.macroName ? ` [${d.macroName}]` : "";
        return `[${prefix}${loc}] ${d.message}`;
    })
        .join("\n");
}
