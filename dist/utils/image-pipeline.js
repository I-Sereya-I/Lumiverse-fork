import sharp from "./sharp-config";
/**
 * Prefer Bun's off-thread native image pipeline for the operations it supports,
 * while retaining Sharp as a compatibility fallback for inputs such as SVG.
 */
export async function readImageMetadata(input, options = {}) {
    try {
        const metadata = await new Bun.Image(input, {
            autoOrient: options.autoOrient ?? false,
        }).metadata();
        return {
            width: metadata.width,
            height: metadata.height,
            format: metadata.format,
        };
    }
    catch {
        const metadata = await sharp(input).metadata();
        return {
            width: metadata.width ?? null,
            height: metadata.height ?? null,
            format: metadata.format ?? null,
        };
    }
}
export async function resizeInsideToWebp(input, width, height, quality, options = {}) {
    const autoOrient = options.autoOrient ?? false;
    const withoutEnlargement = options.withoutEnlargement ?? false;
    try {
        return await new Bun.Image(input, { autoOrient })
            .resize(width, height, { fit: "inside", withoutEnlargement })
            .webp({ quality })
            .buffer();
    }
    catch {
        let pipeline = sharp(input);
        if (autoOrient)
            pipeline = pipeline.rotate();
        return pipeline
            .resize(width, height, { fit: "inside", withoutEnlargement })
            .webp({ quality })
            .toBuffer();
    }
}
export async function writeInsideWebp(input, destination, width, height, quality, options = {}) {
    const autoOrient = options.autoOrient ?? false;
    const withoutEnlargement = options.withoutEnlargement ?? false;
    try {
        await new Bun.Image(input, { autoOrient })
            .resize(width, height, { fit: "inside", withoutEnlargement })
            .webp({ quality })
            .write(destination);
    }
    catch {
        let pipeline = sharp(input);
        if (autoOrient)
            pipeline = pipeline.rotate();
        await pipeline
            .resize(width, height, { fit: "inside", withoutEnlargement })
            .webp({ quality })
            .toFile(destination);
    }
}
/**
 * AVIF output always uses Sharp/libvips. Unlike WebP, Bun.Image does not
 * currently expose an AVIF encoder. Sharp's process-wide cache and concurrency
 * limits are configured by sharp-settings.service through the shared module.
 */
export async function writeInsideAvif(input, destination, width, height, quality, options = {}) {
    const autoOrient = options.autoOrient ?? false;
    const withoutEnlargement = options.withoutEnlargement ?? false;
    let pipeline = sharp(input);
    if (autoOrient)
        pipeline = pipeline.rotate();
    await pipeline
        .resize(width, height, { fit: "inside", withoutEnlargement })
        .avif({ quality, effort: 4, chromaSubsampling: "4:2:0" })
        .toFile(destination);
}
export async function convertImageToWebp(input, quality, options = {}) {
    const autoOrient = options.autoOrient ?? false;
    try {
        return await new Bun.Image(input, { autoOrient })
            .webp({ quality })
            .buffer();
    }
    catch {
        let pipeline = sharp(input);
        if (autoOrient)
            pipeline = pipeline.rotate();
        return pipeline.webp({ quality }).toBuffer();
    }
}
export async function convertImageToPng(input, options = {}) {
    const autoOrient = options.autoOrient ?? false;
    try {
        return await new Bun.Image(input, { autoOrient }).png().buffer();
    }
    catch {
        let pipeline = sharp(input);
        if (autoOrient)
            pipeline = pipeline.rotate();
        return pipeline.png().toBuffer();
    }
}
