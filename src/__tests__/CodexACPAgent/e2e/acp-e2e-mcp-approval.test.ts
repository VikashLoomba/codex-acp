import type * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {ApprovalOptionId} from "../../../ApprovalOptionId";
import {
    createAuthenticatedFixture, createPermissionResponse,
    describeE2E,
    expectEndTurn,
    type PermissionResponder,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";
import os from "node:os";

const MCP_SERVER_NAME = "integration-mcp";
const MCP_ECHO_MESSAGE = "mcp approval e2e";
const MCP_ECHO_PROMPT = `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Reply with exactly the tool result and no extra text.`;

function createMcpServer(invocationMarkerPath: string): acp.McpServerStdio {
    return {
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [path.join(process.cwd(), "src/__tests__/CodexACPAgent/e2e/fixtures/invocation-aware-mcp-server.mjs")],
        env: [{
            name: "MCP_TOOL_INVOCATION_MARKER_PATH",
            value: invocationMarkerPath,
        }],
    };
}

function isMcpPermissionRequest(request: acp.RequestPermissionRequest): boolean {
    return request.toolCall.kind === "execute" && request._meta?.["is_mcp_tool_approval"] === true;
}

function createMcpPermissionResponse(optionId: ApprovalOptionId | null): acp.RequestPermissionResponse {
    if (optionId === null) {
        return {outcome: {outcome: "cancelled"}};
    }
    return {outcome: {outcome: "selected", optionId}};
}

function createMcpPermissionResponder(...optionIds: ApprovalOptionId[]): PermissionResponder {
    const queue = [...optionIds];
    return (request) => createMcpPermissionResponse(
        isMcpPermissionRequest(request)
            ? queue.shift() ?? ApprovalOptionId.RejectOnce
            : null,
    );
}

async function expectEchoToolReply(fixture: SpawnedAgentFixture, sessionId: string, message: string): Promise<void> {
    await fixture.expectPromptText(
        sessionId,
        `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${message}". Reply with exactly the tool result and no extra text.`,
        (text) => expect(text).toContain(`You said: ${message}`),
    );
}

function expectMcpPermissionRequestCount(fixture: SpawnedAgentFixture, sessionId: string, count: number): void {
    const requests = fixture.readPermissionRequests(sessionId, "execute");
    expect(requests.length).toBe(count);
    for (const request of requests) {
        expect(isMcpPermissionRequest(request)).toBe(true);
    }
}

function failingPermissionResponder(label: string): PermissionResponder {
    return (request) => {
        throw new Error(`${label}: unexpected permission request (kind=${request.toolCall.kind})`);
    };
}

describeE2E("E2E MCP approval tests (configured in session)", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    async function createMcpSession(): Promise<{ sessionId: string; invocationMarkerPath: string }> {
        const invocationMarkerPath = path.join(fixture.workspaceDir, `mcp-tool-invocation-${crypto.randomUUID()}.txt`);
        const sessionId = (await fixture.createSession([createMcpServer(invocationMarkerPath)])).sessionId;
        return {sessionId, invocationMarkerPath};
    }

    it("executes an approved MCP tool call", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowOnce));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe(MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("ends turn when MCP tool call is rejected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.RejectOnce));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        expectEndTurn(await fixture.connection.prompt({
            sessionId,
            prompt: [{
                type: "text",
                text: `Use the ${MCP_SERVER_NAME} MCP echo tool with message "${MCP_ECHO_MESSAGE}". Stop if the tool call is rejected.`,
            }],
        }));
        expect(fs.existsSync(invocationMarkerPath)).toBe(false);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("skips subsequent approvals in the same session when allow_session is selected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowForSession));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, "session approval first");
        await expectEchoToolReply(fixture, sessionId, "session approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("session approval second");
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("requests subsequent approvals after session restart when allow_session is selected", async () => {
        fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowForSession, ApprovalOptionId.AllowOnce));
        const {sessionId, invocationMarkerPath} = await createMcpSession();

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 1);

        fixture = await fixture.restart();
        await fixture.connection.loadSession({
            sessionId,
            cwd: fixture.workspaceDir,
            mcpServers: [createMcpServer(invocationMarkerPath)],
        });

        await expectEchoToolReply(fixture, sessionId, MCP_ECHO_MESSAGE);
        expectMcpPermissionRequestCount(fixture, sessionId, 2);
    });
});

describeE2E("E2E MCP approval tests (configured in toml)", () => {
    let invocationMarkerPath: string;
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
        invocationMarkerPath = path.join(os.tmpdir(), `mcp-tool-invocation-${crypto.randomUUID()}.txt`)
    });

    afterEach(async () => {
        await fixture.dispose();
        fs.rmSync(invocationMarkerPath, { force: true });
    });


    beforeEach(async () => {
        await fixture.dispose();
        fixture = await createAuthenticatedFixture(undefined, [createMcpServer(invocationMarkerPath)]);
    });

    it("skips subsequent approvals in the same session when allow_for_session is selected", async () => {
        fixture.setPermissionResponder(
            createMcpPermissionResponder(ApprovalOptionId.AllowForSession),
        );
        const sessionId = (await fixture.createSession()).sessionId;

        await expectEchoToolReply(fixture, sessionId, "always approval first");
        await expectEchoToolReply(fixture, sessionId, "always approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("always approval second");
        expectMcpPermissionRequestCount(fixture, sessionId, 1);
    });

    it("skips subsequent approvals after session restart when allow_persist is selected", async () => {
        fixture.setPermissionResponder(
            createMcpPermissionResponder(ApprovalOptionId.AllowPersist),
        );
        const firstSessionId = (await fixture.createSession()).sessionId;

        await expectEchoToolReply(fixture, firstSessionId, "always approval first");

        fixture = await fixture.restart();
        fixture.setPermissionResponder((request) => {
            if (isMcpPermissionRequest(request)) {
                throw new Error("unexpected MCP approval after allow_always restart");
            }
            return createMcpPermissionResponse(null);
        });
        const newSessionId = (await fixture.createSession()).sessionId;
        await expectEchoToolReply(fixture, newSessionId, "always approval second");

        expect(fs.readFileSync(invocationMarkerPath, "utf8")).toBe("always approval second");
        expect(fixture.readPermissionRequests(newSessionId, "execute").length).toBe(0);
    });

    describe("persisted approvals", () => {
        let beforeRestartFixture: SpawnedAgentFixture | null = null;
        let afterRestartFixture: SpawnedAgentFixture | null = null;
        let sessionId: string;

        beforeEach(async () => {
            // The outer beforeEach already created `fixture` without a config-backed MCP server.
            // Persistence tests need the server in config.toml so Codex offers "Always allow",
            // so dispose that fixture and replace it with a config-backed one.
            await fixture.dispose();
            beforeRestartFixture = await createAuthenticatedFixture(undefined, [createMcpServer(invocationMarkerPath)]);
            fixture = beforeRestartFixture;
            sessionId = (await fixture.createSession()).sessionId;
        });

        afterEach(async () => {
            await afterRestartFixture?.dispose();
            afterRestartFixture = null;
            beforeRestartFixture = null;
        });

        it("does not re-prompt across agent restart when user picks Always allow", async () => {
            fixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowPersist));

            await fixture.expectPromptText(
                sessionId,
                MCP_ECHO_PROMPT,
                (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
            );

            const requests = fixture.readPermissionRequests(sessionId, "execute");
            expect(requests.length).toBe(1);
            expect(isMcpPermissionRequest(requests[0]!)).toBe(true);
            const optionIds = requests[0]!.options.map((option) => option.optionId);
            expect(optionIds).toContain(ApprovalOptionId.AllowPersist);

            afterRestartFixture = await fixture.restart();
            // `fixture` is now stopped; route all subsequent calls through afterRestartFixture.
            fixture = afterRestartFixture;
            afterRestartFixture.setPermissionResponder(failingPermissionResponder("after restart"));
            const resumedSessionId = (await afterRestartFixture.createSession()).sessionId;

            await afterRestartFixture.expectPromptText(
                resumedSessionId,
                MCP_ECHO_PROMPT,
                (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
            );
            expect(afterRestartFixture.readPermissionRequests(resumedSessionId, "execute").length).toBe(0);
        });

        it("does not re-prompt within a session when user picks Allow for session, but re-prompts after restart", async () => {
            let approvalsGranted = 0;
            fixture.setPermissionResponder((request) => {
                if (!isMcpPermissionRequest(request)) {
                    return createPermissionResponse(null);
                }
                approvalsGranted += 1;
                if (approvalsGranted > 1) {
                    throw new Error("Allow-for-session approval should be reused within the same session");
                }
                return createPermissionResponse(ApprovalOptionId.AllowForSession);
            });

            await fixture.expectPromptText(
                sessionId,
                MCP_ECHO_PROMPT,
                (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
            );
            expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(1);

            await fixture.expectPromptText(
                sessionId,
                MCP_ECHO_PROMPT,
                (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
            );
            // Still just the one approval recorded - the second call reused the session-scoped grant.
            expect(fixture.readPermissionRequests(sessionId, "execute").length).toBe(1);

            afterRestartFixture = await fixture.restart();
            fixture = afterRestartFixture;
            afterRestartFixture.setPermissionResponder(createMcpPermissionResponder(ApprovalOptionId.AllowOnce));
            const newSessionId = (await afterRestartFixture.createSession()).sessionId;

            await afterRestartFixture.expectPromptText(
                newSessionId,
                MCP_ECHO_PROMPT,
                (text) => expect(text).toContain(`You said: ${MCP_ECHO_MESSAGE}`),
            );
            expect(afterRestartFixture.readPermissionRequests(newSessionId, "execute").length).toBe(1);
        });
    });
});
