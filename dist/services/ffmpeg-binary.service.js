import { isTermuxLikeEnvironment } from "../utils/termux";
let resolvedFfmpegBinary;
let inflightResolution = null;
async function canExecuteBinary(binary) {
    try {
        const proc = Bun.spawn([binary, "-version"], {
            stdout: "ignore",
            stderr: "ignore",
        });
        return (await proc.exited) === 0;
    }
    catch {
        return false;
    }
}
async function loadStaticBinaryPath() {
    try {
        const mod = await import("ffmpeg-static");
        const binary = mod.default;
        return typeof binary === "string" && binary.trim() ? binary : null;
    }
    catch {
        return null;
    }
}
async function resolveFfmpegBinaryUncached(deps) {
    const termux = deps.isTermuxLike?.() ?? isTermuxLikeEnvironment();
    const probe = deps.canExecuteBinary ?? canExecuteBinary;
    const loadStatic = deps.loadStaticBinaryPath ?? loadStaticBinaryPath;
    if (await probe("ffmpeg"))
        return "ffmpeg";
    if (termux)
        return null;
    const staticBinary = await loadStatic();
    if (!staticBinary)
        return null;
    return (await probe(staticBinary)) ? staticBinary : null;
}
export async function resolveFfmpegBinary(deps) {
    if (deps?.isTermuxLike || deps?.canExecuteBinary || deps?.loadStaticBinaryPath) {
        return resolveFfmpegBinaryUncached(deps);
    }
    if (resolvedFfmpegBinary !== undefined)
        return resolvedFfmpegBinary;
    if (inflightResolution)
        return inflightResolution;
    inflightResolution = resolveFfmpegBinaryUncached({})
        .then((binary) => {
        resolvedFfmpegBinary = binary;
        return binary;
    })
        .finally(() => {
        inflightResolution = null;
    });
    return inflightResolution;
}
export async function isFfmpegBinaryAvailable() {
    return (await resolveFfmpegBinary()) !== null;
}
export function resetFfmpegBinaryResolution() {
    resolvedFfmpegBinary = undefined;
    inflightResolution = null;
}
