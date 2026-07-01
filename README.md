# ACP adapter for Codex CLI

[![npm version](https://img.shields.io/npm/v/%40agentclientprotocol%2Fcodex-acp)](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)

Use [OpenAI Codex](https://github.com/openai/codex) from [Agent Client Protocol](https://agentclientprotocol.com/) clients.

`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client.

## Features

- ChatGPT, API key, and client-provided custom gateway authentication.
- Model, reasoning effort, fast mode, approval, and sandbox mode configuration.
- Text prompts, embedded context, images, resource links, and additional workspace directories.
- Per-session base and developer instruction overrides via request `_meta` (see below).
- Shell command, file change, permission request, MCP tool call, terminal output, reasoning, plan, web search, image generation, image view, token usage, and review events.
- Client-provided MCP servers over command-based stdio config and HTTP transport.
- Slash commands: `/status`, `/mcp`, `/skills`, `/review`, `/review-branch`, `/review-commit`, `/compact`, and `/logout`, as well as configured skills.

## Installation

Run the published package directly:

```bash
npx -y @agentclientprotocol/codex-acp
```

Or install it globally:

```bash
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary:

```bash
CODEX_PATH=/path/to/codex npx -y @agentclientprotocol/codex-acp
```

## Authentication

The adapter advertises ACP auth methods during initialization. Clients can authenticate with:

- ChatGPT login. Set `NO_BROWSER=1` to hide this method in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway, when the client opts in to the gateway auth capability.

## Runtime options

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

## Session instruction overrides

Clients can override Codex's thread instructions per session by setting bare keys on the ACP
session request's `_meta` (on `session/new`, `session/load`, or `session/resume`). They map
directly onto the Codex `thread/start` / `thread/resume` / `thread/fork` parameters of the same
name:

| `_meta` key | Codex thread param | Effect |
| --- | --- | --- |
| `baseInstructions` | `baseInstructions` | Replaces Codex's built-in base system prompt for the thread. |
| `developerInstructions` | `developerInstructions` | Injects developer-role instructions for the thread. |

Both are optional strings; omit a key to keep Codex's default, and a present non-string value is
rejected with an invalid-params error. Example `session/new` params:

```jsonc
{
  "cwd": "/abs/path/to/workspace",
  "mcpServers": [],
  "_meta": {
    "baseInstructions": "You are a release bot. Only touch CHANGELOG.md.",
    "developerInstructions": "Prefer conventional-commit summaries."
  }
}
```

## Development

```bash
npm install
npm run start
npm run typecheck
npm test
```

Build standalone binaries in `dist/bin` with:

```bash
npm run bundle:all
```

See [readme-dev.md](readme-dev.md) for local client configuration, binary packaging, and Codex type regeneration.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
