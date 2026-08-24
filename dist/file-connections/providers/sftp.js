/**
 * SFTP filesystem provider — uses ssh2-sftp-client for SSH file transfer.
 * Supports password and private-key authentication.
 */
import SFTPClient from "ssh2-sftp-client";
import { posix } from "path";
import { MAX_REMOTE_FILE_BYTES } from "../remote-fetch-cap";
export class SFTPFileSystem {
    type = "sftp";
    client;
    config;
    constructor(config) {
        this.config = config;
        this.client = new SFTPClient();
    }
    async connect() {
        const connectConfig = {
            host: this.config.host,
            port: this.config.port ?? 22,
            username: this.config.username,
        };
        if (this.config.privateKey) {
            connectConfig.privateKey = this.config.privateKey;
            if (this.config.passphrase) {
                connectConfig.passphrase = this.config.passphrase;
            }
        }
        else if (this.config.password) {
            connectConfig.password = this.config.password;
        }
        await this.client.connect(connectConfig);
    }
    async disconnect() {
        await this.client.end();
    }
    async exists(path) {
        const result = await this.client.exists(path);
        return result !== false;
    }
    async stat(path) {
        const s = await this.client.stat(path);
        return {
            isDirectory: s.isDirectory,
            isFile: !s.isDirectory,
            size: s.size,
            modifiedAt: s.modifyTime ? Math.floor(s.modifyTime / 1000) : undefined,
        };
    }
    async readdir(path) {
        const listing = await this.client.list(path);
        return listing.map((item) => ({
            name: item.name,
            isDirectory: item.type === "d",
            isFile: item.type === "-",
            size: item.size,
        }));
    }
    async readFile(path) {
        // Pre-flight stat so we never start streaming a multi-GB file into memory.
        // SFTP's stat is cheap; this trades one extra round-trip for a hard cap.
        try {
            const meta = await this.client.stat(path);
            const size = meta?.size ?? 0;
            if (size > MAX_REMOTE_FILE_BYTES) {
                throw new Error(`Remote file "${path}" too large: ${size} bytes (max ${MAX_REMOTE_FILE_BYTES})`);
            }
        }
        catch (err) {
            // If stat fails for reasons other than our size check, surface that error
            // verbatim — the get() below would fail with a less specific message.
            if (err?.message?.includes("too large"))
                throw err;
        }
        const data = await this.client.get(path);
        if (Buffer.isBuffer(data)) {
            if (data.byteLength > MAX_REMOTE_FILE_BYTES) {
                throw new Error(`Remote file "${path}" exceeded ${MAX_REMOTE_FILE_BYTES} bytes`);
            }
            return data;
        }
        if (typeof data === "string")
            return Buffer.from(data);
        // Shouldn't reach here without a dst argument, but handle gracefully
        const buf = Buffer.from(data);
        if (buf.byteLength > MAX_REMOTE_FILE_BYTES) {
            throw new Error(`Remote file "${path}" exceeded ${MAX_REMOTE_FILE_BYTES} bytes`);
        }
        return buf;
    }
    async readText(path) {
        const buf = await this.readFile(path);
        return buf.toString("utf-8");
    }
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
}
