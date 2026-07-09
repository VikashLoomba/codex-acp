import * as acp from "@agentclientprotocol/sdk";
import {readFile, writeFile} from "node:fs/promises";
import type {AcpClientConnection} from "./ACPSessionConnection";
import type {FileContentReader} from "./CodexToolCallMapper";
import {logger} from "./Logger";

/**
 * File system access that respects the client's advertised `fs` capabilities.
 *
 * When the client advertises `fs.readTextFile` / `fs.writeTextFile` in its
 * `clientCapabilities` during `initialize`, file operations are routed through
 * the client (`fs/read_text_file` / `fs/write_text_file`), so reads reflect
 * unsaved editor buffers and writes go through the editor. Otherwise the
 * operations fall back to the local file system.
 */
export class ClientFileSystem {
    private readonly connection: AcpClientConnection;
    private readonly capabilities: acp.FileSystemCapabilities;

    constructor(
        connection: AcpClientConnection,
        capabilities?: acp.FileSystemCapabilities | null,
    ) {
        this.connection = connection;
        this.capabilities = capabilities ?? {};
    }

    get canReadTextFile(): boolean {
        return this.capabilities.readTextFile === true;
    }

    get canWriteTextFile(): boolean {
        return this.capabilities.writeTextFile === true;
    }

    /**
     * Reads a text file, preferring the client's `fs/read_text_file` when the
     * capability is advertised. Falls back to a local read if the client
     * request fails (e.g. the file only exists on disk), and returns null when
     * the file cannot be read at all.
     */
    async readTextFile(sessionId: string, path: string): Promise<string | null> {
        if (this.canReadTextFile) {
            try {
                const response = await this.connection.request(
                    acp.methods.client.fs.readTextFile,
                    {sessionId, path},
                );
                return response.content;
            } catch (error) {
                logger.error(`Client fs/read_text_file failed for ${path}, falling back to local read`, error);
            }
        }
        return await readFile(path, {encoding: "utf8"}).catch(() => null);
    }

    /**
     * Writes a text file through the client's `fs/write_text_file` when the
     * capability is advertised, otherwise writes to the local file system.
     * Client-side failures are propagated instead of silently writing to disk
     * behind the editor's back.
     */
    async writeTextFile(sessionId: string, path: string, content: string): Promise<void> {
        if (this.canWriteTextFile) {
            await this.connection.request(
                acp.methods.client.fs.writeTextFile,
                {sessionId, path, content},
            );
            return;
        }
        await writeFile(path, content, {encoding: "utf8"});
    }

    /**
     * Binds {@link readTextFile} to a session for consumers that only need
     * file content, such as the file-change diff builder.
     */
    createFileReader(sessionId: string): FileContentReader {
        return (path) => this.readTextFile(sessionId, path);
    }
}
