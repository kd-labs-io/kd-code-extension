import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpAgent, AgentCommand } from "../src/acpClient";
import { TabContext } from "../src/chat/contextBreakdown";
import { TabList } from "../src/chat/tabs";
import { apiCommand, instructionFiles, isOpenCodeServer } from "../src/opencodeContext";

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

/** Runs `body` with `XDG_CONFIG_HOME` and `HOME` in a fresh folder, removed afterwards. */
function withHome<A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-context-")));
      const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME };
      process.env.XDG_CONFIG_HOME = path.join(root, "config");
      process.env.HOME = path.join(root, "home");
      fs.mkdirSync(process.env.HOME, { recursive: true });
      return { root, saved };
    }),
    ({ root }) => body(root),
    ({ root, saved }) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }),
  );
}

describe("isOpenCodeServer and apiCommand", () => {
  it("knows OpenCode v2 and how to reach its server", () => {
    assert.isTrue(isOpenCodeServer({ name: "OpenCode", version: "2.2.6" }));
    assert.isFalse(isOpenCodeServer({ name: "OpenCode", version: "1.14.0" }));
    assert.isFalse(isOpenCodeServer({ name: "Other", version: "2.0.0" }));
    const agent: AgentCommand = { command: "/bin/opencode", args: ["acp"], env: { A: "1" } };
    assert.deepStrictEqual(apiCommand(agent, ["GET", "/api/mcp"]), {
      command: "/bin/opencode",
      args: ["api", "GET", "/api/mcp"],
      env: { A: "1" },
    });
    assert.isUndefined(apiCommand({ ...agent, args: ["serve"] }, []));
  });
});

describe("instructionFiles", () => {
  it.effect("finds the global file, then every AGENTS.md from the folder up to the repository root", () =>
    withHome((root) =>
      Effect.gen(function* () {
        const repo = path.join(root, "repo");
        const pkg = path.join(repo, "pkg");
        fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
        fs.mkdirSync(pkg, { recursive: true });
        fs.mkdirSync(path.join(root, "home", ".claude"), { recursive: true });
        fs.writeFileSync(path.join(root, "home", ".claude", "CLAUDE.md"), "claude");
        fs.writeFileSync(path.join(root, "AGENTS.md"), "above the repository");
        fs.writeFileSync(path.join(repo, "AGENTS.md"), "root");
        fs.writeFileSync(path.join(repo, "CLAUDE.md"), "not read beside AGENTS.md");
        fs.writeFileSync(path.join(pkg, "AGENTS.md"), "package");
        assert.deepStrictEqual(yield* instructionFiles(pkg), [
          { path: path.join(root, "home", ".claude", "CLAUDE.md"), scope: "User" },
          { path: path.join(repo, "AGENTS.md"), scope: "Project" },
          { path: path.join(pkg, "AGENTS.md"), scope: "Project" },
        ]);
        // Its own global file comes first.
        fs.mkdirSync(path.join(root, "config", "opencode"), { recursive: true });
        fs.writeFileSync(path.join(root, "config", "opencode", "AGENTS.md"), "");
        assert.deepStrictEqual((yield* instructionFiles(pkg))[0], {
          path: path.join(root, "config", "opencode", "AGENTS.md"),
          scope: "User",
        });
      }),
    ).pipe(Effect.provide(platform)),
  );
});

describe("TabContext with OpenCode", () => {
  it.effect("shows the skills and MCP servers the OpenCode server has for the folder", () =>
    withHome((root) =>
      Effect.gen(function* () {
        const repo = path.join(root, "repo");
        fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
        // Stands in for `opencode api GET <path>`.
        const server = path.join(root, "opencode.mjs");
        fs.writeFileSync(
          server,
          `const [, , api, method, url] = process.argv;
if (api !== "api" || method !== "GET") process.exit(2);
const { pathname, searchParams } = new URL(url, "http://x");
const dir = searchParams.get("location[directory]");
const data = pathname === "/api/skill"
  ? [{ name: "opencode", description: "About OpenCode", path: "skill://opencode/SKILL.md" },
     { name: "local", path: dir + "/.opencode/skills/local/SKILL.md" }]
  : [{ name: "browse", status: { status: "connected" } }, { name: "docs", status: { status: "failed" } }];
console.log(JSON.stringify({ location: { directory: dir }, data }));`,
        );
        const posted: Array<Record<string, unknown>> = [];
        const runs: Array<Effect.Effect<void, unknown, never>> = [];
        const tab = new TabList(undefined, () => repo).active;
        tab.sessionId = "s1";
        tab.running = {
          agent: {
            command: { command: process.execPath, args: [server, "acp"], env: {} },
            measuresContext: false,
            mcpServerNames: () => ["kd", "docs"],
            initializeResponse: { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "2.2.6" } },
          } as unknown as AcpAgent,
          agentId: "opencode",
          scope: yield* Scope.make(),
        };
        const context = new TabContext({
          postTab: (_tab, message) => void posted.push(message),
          run: (effect) => void runs.push(effect as Effect.Effect<void, unknown, never>),
          sendQueued: () => {},
        });
        context.post(tab);
        assert.deepStrictEqual((posted.at(-1) as { breakdown: { groups: unknown } }).breakdown.groups, [
          { kind: "mcpServers", items: [{ name: "kd" }, { name: "docs" }] },
        ]);
        yield* runs[0].pipe(Effect.provide(platform));
        assert.deepStrictEqual((posted.at(-1) as { breakdown: { groups: unknown } }).breakdown.groups, [
          {
            kind: "mcpServers",
            items: [{ name: "browse", source: undefined }, { name: "docs", source: "failed" }, { name: "kd" }],
          },
          {
            kind: "skills",
            items: [
              { name: "opencode", description: "About OpenCode", source: "builtin" },
              { name: "local", description: undefined, source: "Project" },
            ],
          },
        ]);
      }),
    ),
  );
});
