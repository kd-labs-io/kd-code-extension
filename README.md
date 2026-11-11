# KD Code

[![Version](https://img.shields.io/github/package-json/v/kd-labs-io/kd-code-extension?label=version)](package.json)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.123-007ACC)](https://code.visualstudio.com)
[![ACP](https://img.shields.io/badge/protocol-ACP-6E56CF)](https://agentclientprotocol.com)
[![License](https://img.shields.io/github/license/kd-labs-io/kd-code-extension)](LICENSE)

Chat with coding agents in VS Code over the [Agent Client Protocol](https://agentclientprotocol.com). Install Claude, Codex, OpenCode and more from the [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) in one click, then compare their work in isolated git worktrees.

## Getting started

Install **KD Code** (`kd-labs.kd-code`) from the Visual Studio Marketplace or Open VSX, or grab the `.vsix` from [GitHub Releases](https://github.com/kd-labs-io/kd-code-extension/releases). It needs VS Code ≥ 1.123.

1. Run `KD Code: Manage Agents` and install an agent.
2. Run `KD Code: Doctor` to check your setup.
3. Open the chat with `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS) and start chatting. Use **Log in** if the agent asks.

`KD Code: Get Started` walks you through the same steps. `npx` agents need Node.js, `uvx` agents need [uv](https://docs.astral.sh/uv/). See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for known limitations.

## Features

- **Chat**: tabs you can pin, rename and reorder, searchable history, queue, edit, retry and fork messages, `/` commands and `$` skills, permission rules, and model, effort and mode per tab.
- **Context**: attach files, folders, images, problems, selections and terminal output with `@`, paste or drag and drop. Run **Explain**, **Refactor**, **Write Tests** or **Fix with KD Code** from the editor.
- **Changes**: review, keep or undo the agent's edits per file or per change, follow it in the editor, and restore checkpoints.
- **Worktrees**: run a chat in its own git worktree, send one prompt to several agents and models (Best of N) and apply the best result, then merge, open a PR or copy the changes.
- **Agents**: install, update and add your own agents, pass MCP servers and environment variables, and check your setup with Doctor.
- **Usage**: context window breakdown, tokens and cost by day, conversation and agent, tracing, and OpenTelemetry export to an OTLP endpoint.
- **Git**: generate commit messages from the Source Control view.
- **Language**: English and Vietnamese.

## Keyboard shortcuts

| Action                    | Windows / Linux    | macOS        | When                                    |
| ------------------------- | ------------------ | ------------ | --------------------------------------- |
| Open the chat             | `Ctrl+Alt+A`       | `Cmd+Alt+A`  | Anywhere                                |
| New chat tab              | `Ctrl+Shift+Alt+N` | `Ctrl+Cmd+N` | Anywhere                                |
| Find in conversation      | `Ctrl+F`           | `Cmd+F`      | Chat focused                            |
| Archive the active thread | `Ctrl+W`           | `Cmd+W`      | Chat focused                            |
| Cancel                    | `Ctrl+.`           | `Cmd+.`      | Chat focused                            |
| Add selection to chat     | `Ctrl+Alt+L`       | `Cmd+Alt+L`  | Text selected in the editor or terminal |
| Add file problems to chat | `Ctrl+Alt+P`       | `Cmd+Alt+P`  | Editor focused                          |

## Security

- Settings that decide what runs (custom agents, MCP servers, environment variables, tool paths) apply only at machine scope, so a workspace cannot set them.
- A project's worktree setup command and links from agents open only after you allow them.
- Permission rules save clicks but are no security boundary: agents describe their own tools, and a worktree is no sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
