const DEFAULT_SLOW_PHASE_MS = 75;
const DEFAULT_SLOW_TOTAL_MS = 250;
function readPositiveNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const SLOW_PHASE_MS = readPositiveNumber("LUMIVERSE_PROMPT_PHASE_WARN_MS", DEFAULT_SLOW_PHASE_MS);
const SLOW_TOTAL_MS = readPositiveNumber("LUMIVERSE_PROMPT_TOTAL_WARN_MS", DEFAULT_SLOW_TOTAL_MS);
export class PromptAssemblyProfiler {
    label;
    meta;
    startedAt = performance.now();
    phases = [];
    constructor(label, meta = {}) {
        this.label = label;
        this.meta = meta;
    }
    measureSync(name, fn) {
        const startedAt = performance.now();
        try {
            return fn();
        }
        finally {
            this.addPhase(name, performance.now() - startedAt);
        }
    }
    async measure(name, fn) {
        const startedAt = performance.now();
        try {
            return await fn();
        }
        finally {
            this.addPhase(name, performance.now() - startedAt);
        }
    }
    addPhase(name, ms) {
        this.phases.push({ name, ms });
    }
    finish() {
        const totalMs = performance.now() - this.startedAt;
        const slowPhases = this.phases.filter((phase) => phase.ms >= SLOW_PHASE_MS);
        if (totalMs < SLOW_TOTAL_MS && slowPhases.length === 0)
            return;
        const meta = Object.entries(this.meta)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" ");
        const topPhases = [...this.phases]
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 8)
            .map((phase) => `${phase.name}=${phase.ms.toFixed(1)}ms`)
            .join(" ");
        console.warn(`[prompt-profiler] ${this.label} total=${totalMs.toFixed(1)}ms${meta ? ` ${meta}` : ""}${topPhases ? ` phases: ${topPhases}` : ""}`);
    }
}
export function createPromptAssemblyProfiler(label, meta) {
    return new PromptAssemblyProfiler(label, meta);
}
