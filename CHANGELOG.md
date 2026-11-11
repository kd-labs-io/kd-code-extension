# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); entries after 0.0.1 are generated from [Conventional Commits](https://www.conventionalcommits.org/) by release-please.

## [0.0.5](https://github.com/kd-labs-io/kd-code-extension/compare/v0.0.4...v0.0.5) (2026-11-11)


### Added

* **chat:** show messages sent to OpenCode sessions from its other clients ([dd4409d](https://github.com/kd-labs-io/kd-code-extension/commit/dd4409d436a5494a3f4ce258e0c109b1e36beb8c))

## [0.0.4](https://github.com/kd-labs-io/kd-code-extension/compare/v0.0.3...v0.0.4) (2026-11-11)


### Added

* **settings:** add model search and wrap long provider and model names ([d7fe32e](https://github.com/kd-labs-io/kd-code-extension/commit/d7fe32ec570f79fc80f04f7d2cbbc842fe9ffad6))

## [0.0.3](https://github.com/kd-labs-io/kd-code-extension/compare/v0.0.2...v0.0.3) (2026-11-09)


### Added

* **chat:** mark deferred MCP tools in the context panel ([e4fcd68](https://github.com/kd-labs-io/kd-code-extension/commit/e4fcd68a7a449af232db57dc7e312f256a7a74ac))
* **chat:** show Codex instruction files and skills in the context panel ([b00b6f6](https://github.com/kd-labs-io/kd-code-extension/commit/b00b6f61426a65cfd1efc7fe2714c703c30a7e38))
* **chat:** show OpenCode instruction files, skills and MCP servers in the context panel ([e93c4b9](https://github.com/kd-labs-io/kd-code-extension/commit/e93c4b91971e81ba0f6956acbc9375f98daa03b2))
* **chat:** show what fills the context window in the usage panel ([93993df](https://github.com/kd-labs-io/kd-code-extension/commit/93993dfe4606e9b3898ac0bc92010dfab1143bd4))
* **settings:** show connection check progress and suggest OpenCode v2 on setup ([24e86cf](https://github.com/kd-labs-io/kd-code-extension/commit/24e86cfd5e403befec5a2069737ea03e989e72a7))
* **telemetry:** send agents' OpenTelemetry to an OTLP endpoint ([9a43ccc](https://github.com/kd-labs-io/kd-code-extension/commit/9a43ccc52eb647d7691a2fab21de5e654c025b0b))

## [0.0.2](https://github.com/kd-labs-io/kd-code-extension/compare/v0.0.1...v0.0.2) (2026-11-08)


### Chores

* release 0.0.2 ([07425fb](https://github.com/kd-labs-io/kd-code-extension/commit/07425fb7f72b5ed6dd9645b4927b3152d0198a67))

## [0.0.1] - 2026-11-07

First public version.

### Added

- Chat with coding agents over the Agent Client Protocol, in tabs you can pin, rename and reorder, with a searchable history you can delete from.
- A "Waiting on you" section at the top of the tab sidebar for tabs that wait on a permission, a question or a login.
- Sort the open tabs by newest, oldest or title from the sidebar, or keep the order you dragged them into.
- Install, update and switch agents from the ACP Registry, and add your own agents from local commands.
- Queue, edit, resend and retry messages, and fork a conversation into a new tab.
- A composer with live Markdown preview, drafts that survive reloads, and `/` agent commands and `$` skills.
- Permission requests, form questions, links to open after asking, plans, tools, subagents, terminals and context compaction in the chat.
- Rules that answer permission requests without asking, for all projects or one workspace, and for worktree chats.
- Model, effort and fast mode per tab, remembered for each agent, and modes for agents that only offer those.
- Compact a conversation from the context window panel, for agents that offer `/compact`.
- Log out of an agent.
- A first-run panel in the chat: it checks the tools agents need, then offers suggested agents or more, and the chat box appears once one is installed.
- A getting-started walkthrough, and a Doctor page in Settings (`KD Code: Doctor`), which checks Node.js, npm, uv and git, starts each agent and offers to fix what it finds, such as a missing login.
- Attach files, folders, images, problems, terminals and selections as context, and annotate images.
- **Explain**, **Refactor**, **Write Tests** and **Fix with KD Code** actions.
- Review the agent's changes with Keep and Undo, restore checkpoints, and follow the agent in the editor.
- Run a tab in its own git worktree and apply its changes to your checkout. Its branch is named after the first prompt, and those of Best of N go under `kd-code/compare/`.
- Best of N: tick Compare in the composer to send one prompt to several agents, models and efforts, each in its own worktree, grouped under one tab; compare their diffs and apply the best one, or discard them all.
- Copy ignored files and run a setup command when a worktree is created. A project can have its own command, which runs only after you allow it.
- Switch the Settings page between user and workspace settings.
- Commit message generation, then commit and push, from the Source Control view.
- Token and cost tracking, ccusage reports, status bar activity, background notifications and tracing.
- English and Vietnamese interfaces.

### Security

- Settings that decide what runs (custom agents, MCP servers, environment variables, Node and ccusage paths) apply only at machine scope, so a workspace cannot set them. A project's worktree setup command asks first, and asks again when the command or a file it names changes.
- Links from agents open only after asking, over https, or over http to localhost, 127.0.0.1 and hosts you list in Settings; a workspace cannot add to that list.
- Registry entries with unsafe paths are refused at install.
