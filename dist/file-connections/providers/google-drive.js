/**
 * Google Drive filesystem provider — uses the Drive API v3 via raw fetch.
 *
 * Paths are virtual: "My Drive/SillyTavern/data/default-user". Each path
 * segment is resolved to a Drive file ID by walking the tree. The root
 * "My Drive" maps to the special ID "root".
 *
 * No SDK dependency — just fetch + Bearer token.
 */
import { posix } from "path";
import { readResponseBuffer, MAX_REMOTE_FILE_BYTES, REMOTE_FETCH_TIMEOUT_MS } from "../remote-fetch-cap";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export class GoogleDriveFileSystem {
    type = "google-drive";
    accessToken;
    /** Cache of resolved path → file ID to avoid redundant API calls */
    idCache = new Map();
    constructor(config) {
        this.accessToken = config.accessToken;
        this.idCache.set("", "root");
        this.idCache.set("/", "root");
    }
    async connect() {
        // Verify token works by listing root
        const res = await this.driveGet("/files", {
            q: "'root' in parents",
            pageSize: "1",
            fields: "files(id)",
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Google Drive auth failed: ${body}`);
        }
    }
    async disconnect() {
        // no-op — token-based, stateless
    }
    async exists(path) {
        try {
            await this.resolveId(path);
            return true;
        }
        catch {
            return false;
        }
    }
    async stat(path) {
        const id = await this.resolveId(path);
        const res = await this.driveGet(`/files/${id}`, {
            fields: "id,name,mimeType,size,modifiedTime",
        });
        if (!res.ok)
            throw new Error(`Failed to stat: ${path}`);
        const file = await res.json();
        const isDir = file.mimeType === FOLDER_MIME;
        return {
            isDirectory: isDir,
            isFile: !isDir,
            size: file.size ? parseInt(file.size, 10) : 0,
            modifiedAt: file.modifiedTime
                ? Math.floor(new Date(file.modifiedTime).getTime() / 1000)
                : undefined,
        };
    }
    async readdir(path) {
        const folderId = await this.resolveId(path);
        const entries = [];
        let pageToken;
        do {
            const params = {
                q: `'${folderId}' in parents and trashed = false`,
                fields: "nextPageToken,files(id,name,mimeType,size)",
                pageSize: "1000",
                orderBy: "folder,name",
            };
            if (pageToken)
                params.pageToken = pageToken;
            const res = await this.driveGet("/files", params);
            if (!res.ok)
                throw new Error(`Failed to list: ${path}`);
            const data = await res.json();
            for (const file of data.files) {
                const isDir = file.mimeType === FOLDER_MIME;
                entries.push({
                    name: file.name,
                    isDirectory: isDir,
                    isFile: !isDir,
                    size: file.size ? parseInt(file.size, 10) : 0,
                });
                // Cache child IDs for future resolution
                const childPath = path ? `${this.normalizePath(path)}/${file.name}` : file.name;
                this.idCache.set(childPath, file.id);
            }
            pageToken = data.nextPageToken;
        } while (pageToken);
        return entries;
    }
    async readFile(path) {
        const id = await this.resolveId(path);
        const res = await this.driveGet(`/files/${id}`, { alt: "media" });
        if (!res.ok)
            throw new Error(`Failed to download: ${path}`);
        return readResponseBuffer(res, MAX_REMOTE_FILE_BYTES, path);
    }
    async readText(path) {
        const buf = await this.readFile(path);
        return buf.toString("utf-8");
    }
    // ─── Path operations ──────────────────────────────────────────────────
    join(...parts) {
        return posix.join(...parts);
    }
    dirname(path) {
        return posix.dirname(path);
    }
    basename(path, ext) {
        return ext ? posix.basename(path, ext) : posix.basename(path);
    }
    extname(path) {
        return posix.extname(path);
    }
    // ─── Internals ────────────────────────────────────────────────────────
    normalizePath(path) {
        return path.replace(/^\/+|\/+$/g, "");
    }
    /**
     * Resolve a virtual path like "SillyTavern/data/default-user" to a
     * Google Drive file ID by walking each segment.
     */
    async resolveId(path) {
        const normalized = this.normalizePath(path);
        if (!normalized || normalized === "/")
            return "root";
        // Check cache
        const cached = this.idCache.get(normalized);
        if (cached)
            return cached;
        // Walk path segments
        const segments = normalized.split("/");
        let parentId = "root";
        let resolvedSoFar = "";
        for (const segment of segments) {
            resolvedSoFar = resolvedSoFar ? `${resolvedSoFar}/${segment}` : segment;
            const cachedSegment = this.idCache.get(resolvedSoFar);
            if (cachedSegment) {
                parentId = cachedSegment;
                continue;
            }
            // Query Drive for this child in the parent
            const escapedName = segment.replace(/'/g, "\\'");
            const res = await this.driveGet("/files", {
                q: `'${parentId}' in parents and name = '${escapedName}' and trashed = false`,
                fields: "files(id,name,mimeType)",
                pageSize: "1",
            });
            if (!res.ok)
                throw new Error(`Failed to resolve path: ${resolvedSoFar}`);
            const data = await res.json();
            if (!data.files || data.files.length === 0) {
                throw new Error(`Not found: ${resolvedSoFar}`);
            }
            parentId = data.files[0].id;
            this.idCache.set(resolvedSoFar, parentId);
        }
        return parentId;
    }
    driveGet(endpoint, params) {
        const url = new URL(`${DRIVE_API}${endpoint}`);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }
        return fetch(url.toString(), {
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
            },
            signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
        });
    }
}
