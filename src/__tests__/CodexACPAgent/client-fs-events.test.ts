import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { ClientFileSystem } from '../../ClientFileSystem';
import type { AcpClientConnection } from '../../ACPSessionConnection';
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from '../acp-test-utils';
import { AgentMode } from '../../AgentMode';

const { mockDiskFiles, mockDiskWrites, mockDiskFileContent, clearMockDiskFiles } = vi.hoisted(() => {
    const files = new Map<string, string>();
    const writes = new Map<string, string>();
    return {
        mockDiskFiles: files,
        mockDiskWrites: writes,
        mockDiskFileContent: (path: string, content: string) => files.set(path, content),
        clearMockDiskFiles: () => {
            files.clear();
            writes.clear();
        },
    };
});

vi.mock('node:fs/promises', () => ({
    readFile: async (path: string) => {
        const content = mockDiskFiles.get(path);
        if (content !== undefined) {
            return content;
        }
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    },
    writeFile: async (path: string, content: string) => {
        mockDiskWrites.set(path, content);
    },
}));

const sessionId = 'test-session-id';
const filePath = '/test/project/OldFile.kt';
const oldFileContent = 'package test.project\n\nclass OldFile {}';
const updateDiff =
`--- /test/project/OldFile.kt
+++ /test/project/OldFile.kt
@@ -1,3 +1,3 @@
 package test.project

-class OldFile {}
+class UpdatedFile {}
`;

function updateFileNotification(): ServerNotification {
    return {
        method: 'item/started',
        params: {
            threadId: sessionId,
            turnId: 'turn-1',
            startedAtMs: 0,
            item: {
                type: 'fileChange',
                id: 'file-change-1',
                changes: [
                    {
                        path: filePath,
                        kind: { type: 'update', move_path: null },
                        diff: updateDiff,
                    },
                ],
                status: 'completed',
            },
        },
    };
}

async function initializeAgent(
    fixture: CodexMockTestFixture,
    clientCapabilities?: acp.ClientCapabilities,
): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        ...(clientCapabilities ? { clientCapabilities } : {}),
    });
}

describe('CodexEventHandler - client fs capabilities', () => {
    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: 'model-id[effort]',
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
    });

    beforeEach(() => {
        clearMockDiskFiles();
    });

    it('reads file content through the client when fs.readTextFile is advertised', async () => {
        // The file exists only in the client (e.g. an unsaved editor buffer) — not on disk.
        const clientFiles = new Map<string, string>([[filePath, oldFileContent]]);
        const mockFixture = createCodexMockTestFixture({
            acpRequestHandler: (method, params) => {
                if (method !== acp.methods.client.fs.readTextFile) return undefined;
                const { path } = params as acp.ReadTextFileRequest;
                const content = clientFiles.get(path);
                if (content === undefined) {
                    throw acp.RequestError.resourceNotFound(path);
                }
                return { content };
            },
        });
        await initializeAgent(mockFixture, { fs: { readTextFile: true } });

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updateFileNotification()]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/client-fs-read-from-client.json'
        );
    });

    it('falls back to a local read when the client read fails', async () => {
        mockDiskFileContent(filePath, oldFileContent);
        const mockFixture = createCodexMockTestFixture({
            acpRequestHandler: (method) => {
                if (method !== acp.methods.client.fs.readTextFile) return undefined;
                throw acp.RequestError.internalError('client read failed');
            },
        });
        await initializeAgent(mockFixture, { fs: { readTextFile: true } });

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updateFileNotification()]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/client-fs-read-fallback-to-disk.json'
        );
    });

    it('reads from disk when the client does not advertise fs.readTextFile', async () => {
        mockDiskFileContent(filePath, oldFileContent);
        const clientReads: string[] = [];
        const mockFixture = createCodexMockTestFixture({
            acpRequestHandler: (method, params) => {
                if (method !== acp.methods.client.fs.readTextFile) return undefined;
                clientReads.push((params as acp.ReadTextFileRequest).path);
                return { content: 'client content that must not be used' };
            },
        });
        await initializeAgent(mockFixture, { fs: {} });

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updateFileNotification()]);

        expect(clientReads).toEqual([]);
        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/client-fs-read-without-capability.json'
        );
    });
});

describe('ClientFileSystem', () => {
    beforeEach(() => {
        clearMockDiskFiles();
    });

    function createConnection(
        handler: (method: string, params: unknown) => unknown,
    ): { connection: AcpClientConnection; requests: Array<{ method: string; params: unknown }> } {
        const requests: Array<{ method: string; params: unknown }> = [];
        const connection = {
            request: async (method: string, params: unknown) => {
                requests.push({ method, params });
                return handler(method, params);
            },
            notify: async () => {},
        } as unknown as AcpClientConnection;
        return { connection, requests };
    }

    it('writes through the client when fs.writeTextFile is advertised', async () => {
        const { connection, requests } = createConnection(() => ({}));
        const fileSystem = new ClientFileSystem(connection, { writeTextFile: true });

        await fileSystem.writeTextFile(sessionId, filePath, 'new content');

        expect(requests).toEqual([{
            method: acp.methods.client.fs.writeTextFile,
            params: { sessionId, path: filePath, content: 'new content' },
        }]);
        expect(mockDiskWrites.size).toBe(0);
    });

    it('writes to disk when the client does not advertise fs.writeTextFile', async () => {
        const { connection, requests } = createConnection(() => ({}));
        const fileSystem = new ClientFileSystem(connection, null);

        await fileSystem.writeTextFile(sessionId, filePath, 'new content');

        expect(requests).toEqual([]);
        expect(mockDiskWrites.get(filePath)).toBe('new content');
    });

    it('propagates client write failures instead of writing to disk', async () => {
        const { connection } = createConnection(() => {
            throw acp.RequestError.internalError('client write failed');
        });
        const fileSystem = new ClientFileSystem(connection, { writeTextFile: true });

        await expect(fileSystem.writeTextFile(sessionId, filePath, 'new content')).rejects.toThrow();
        expect(mockDiskWrites.size).toBe(0);
    });

    it('returns null when neither the client nor the disk can read the file', async () => {
        const { connection } = createConnection(() => {
            throw acp.RequestError.resourceNotFound(filePath);
        });
        const fileSystem = new ClientFileSystem(connection, { readTextFile: true });

        expect(await fileSystem.readTextFile(sessionId, filePath)).toBeNull();
    });
});
