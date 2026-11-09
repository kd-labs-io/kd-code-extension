import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpAgent } from "../src/acpClient";
import { TabContext } from "../src/chat/contextBreakdown";
import { TabList } from "../src/chat/tabs";
import { instructionFiles } from "../src/codexContext";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** A Codex home and a repository with instruction files at several levels; returns the folders. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-")));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const pkg = path.join(repo, "pkg");
  const deep = path.join(pkg, "deep");
  for (const dir of [home, path.join(repo, ".git"), deep]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "above the repository");
  fs.writeFileSync(path.join(home, "AGENTS.md"), "global");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "root");
  fs.writeFileSync(path.join(pkg, "AGENTS.md"), "package");
  fs.writeFileSync(path.join(pkg, "AGENTS.override.md"), "override");
  fs.writeFileSync(path.join(deep, "AGENTS.md"), "\n");
  return { root, home, repo, pkg, deep };
}

describe("instructionFiles", () => {
  it.effect("finds the global file, then one per folder from the repository root down, overrides first", () =>
    Effect.gen(function* () {
      const { root, home, repo, pkg, deep } = fixture();
      const saved = process.env.CODEX_HOME;
      process.env.CODEX_HOME = home;
      try {
        assert.deepStrictEqual(yield* instructionFiles(deep), [
          { path: path.join(home, "AGENTS.md"), scope: "User" },
          { path: path.join(repo, "AGENTS.md"), scope: "Project" },
          { path: path.join(pkg, "AGENTS.override.md"), scope: "Project" },
        ]);
        // Outside a repository, only the folder itself.
        assert.deepStrictEqual(yield* instructionFiles(root), [
          { path: path.join(home, "AGENTS.md"), scope: "User" },
          { path: path.join(root, "AGENTS.md"), scope: "Project" },
        ]);
      } finally {
        if (saved === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = saved;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(platform)),
  );
});

describe("TabContext with Codex", () => {
  it.effect("shows the skills it offers as $ commands and the AGENTS.md files it reads", () =>
    Effect.gen(function* () {
      const { root, home, repo } = fixture();
      const saved = process.env.CODEX_HOME;
      process.env.CODEX_HOME = home;
      try {
        const posted: Array<Record<string, unknown>> = [];
        const runs: Array<Effect.Effect<void, unknown, never>> = [];
        const tab = new TabList(undefined, () => repo).active;
        tab.sessionId = "s1";
        tab.running = {
          agent: {
            measuresContext: false,
            mcpServerNames: () => [],
            initializeResponse: {
              protocolVersion: 1,
              agentInfo: { name: "@agentclientprotocol/codex-acp", version: "2" },
            },
          } as unknown as AcpAgent,
          agentId: "codex",
          scope: yield* Scope.make(),
        };
        tab.commands = [
          { name: "review", description: "Review changes" },
          { name: "$pdf", description: "Read PDFs" },
        ];
        const context = new TabContext({
          postTab: (_tab, message) => void posted.push(message),
          run: (effect) => void runs.push(effect as Effect.Effect<void, unknown, never>),
          sendQueued: () => {},
        });
        context.post(tab);
        assert.deepStrictEqual(posted.at(-1), {
          type: "contextBreakdown",
          breakdown: {
            categories: [],
            groups: [{ kind: "skills", items: [{ name: "pdf", description: "Read PDFs" }] }],
            measurable: false,
          },
          measuring: false,
        });
        assert.strictEqual(runs.length, 1);
        yield* runs[0].pipe(Effect.provide(platform));
        assert.deepStrictEqual((posted.at(-1) as { breakdown: { groups: unknown } }).breakdown.groups, [
          {
            kind: "memoryFiles",
            items: [
              { name: path.join(home, "AGENTS.md"), source: "User" },
              { name: path.join(repo, "AGENTS.md"), source: "Project" },
            ],
          },
          { kind: "skills", items: [{ name: "pdf", description: "Read PDFs" }] },
        ]);
        // Found once per session.
        context.post(tab);
        assert.strictEqual(runs.length, 1);
      } finally {
        if (saved === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = saved;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});
