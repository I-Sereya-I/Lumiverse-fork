export const GALLERY_IMAGE_REFERENCE_PREFIX = "gallery://";
const GALLERY_REFERENCE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_GALLERY_REFERENCE_TOKEN_RE = /^image-([1-9][0-9]*)$/;
export function createGalleryImageReference(token) {
    if (!GALLERY_REFERENCE_TOKEN_RE.test(token)) {
        throw new Error("Invalid gallery image reference token");
    }
    return `${GALLERY_IMAGE_REFERENCE_PREFIX}${token}`;
}
export function parseGalleryImageReference(reference) {
    if (!reference.startsWith(GALLERY_IMAGE_REFERENCE_PREFIX))
        return null;
    const token = reference.slice(GALLERY_IMAGE_REFERENCE_PREFIX.length);
    return GALLERY_REFERENCE_TOKEN_RE.test(token) ? token : null;
}
export function parseCanonicalGalleryImageReference(reference) {
    const token = parseGalleryImageReference(reference);
    if (!token)
        return null;
    const match = CANONICAL_GALLERY_REFERENCE_TOKEN_RE.exec(token);
    if (!match)
        return null;
    const sequence = Number(match[1]);
    return Number.isSafeInteger(sequence) ? sequence : null;
}
export function createCanonicalGalleryImageReference(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("Invalid gallery image reference sequence");
    }
    return createGalleryImageReference(`image-${sequence}`);
}
export function galleryArchiveStem(token) {
    createGalleryImageReference(token);
    return `gallery_${token}`;
}
export function galleryReferenceFromArchivePath(path) {
    const base = path.split("/").pop() || "";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    if (!stem.startsWith("gallery_"))
        return null;
    const token = stem.slice("gallery_".length);
    return GALLERY_REFERENCE_TOKEN_RE.test(token)
        ? `${GALLERY_IMAGE_REFERENCE_PREFIX}${token}`
        : null;
}
export function findGalleryImageReference(assetMap, imageId, preferredToken) {
    if (!assetMap || typeof assetMap !== "object" || Array.isArray(assetMap))
        return null;
    const map = assetMap;
    if (preferredToken && GALLERY_REFERENCE_TOKEN_RE.test(preferredToken)) {
        const preferred = `${GALLERY_IMAGE_REFERENCE_PREFIX}${preferredToken}`;
        if (map[preferred] === imageId)
            return preferred;
    }
    for (const [reference, mappedImageId] of Object.entries(map)) {
        if (mappedImageId === imageId && parseGalleryImageReference(reference))
            return reference;
    }
    return null;
}
export function findCanonicalGalleryImageReference(assetMap, imageId) {
    if (!assetMap || typeof assetMap !== "object" || Array.isArray(assetMap))
        return null;
    const matches = Object.entries(assetMap)
        .filter(([reference, mappedImageId]) => mappedImageId === imageId && parseCanonicalGalleryImageReference(reference) !== null)
        .sort((a, b) => parseCanonicalGalleryImageReference(a[0]) - parseCanonicalGalleryImageReference(b[0]));
    return matches[0]?.[0] ?? null;
}
