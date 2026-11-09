import { assert, describe, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import type { AcpAgent } from "../src/acpClient";
import type { ContextUsage } from "../src/claudeContext";
import { breakdownOf, TabContext } from "../src/chat/contextBreakdown";
import { TabList } from "../src/chat/tabs";

const usage: ContextUsage = {
  model: "claude",
  total_tokens: 3000,
  raw_max_tokens: 10000,
  categories: [
    { name: "System prompt", tokens: 2000, kind: "used" },
    { name: "Custom agents", tokens: 0, kind: "used" },
    { name: "MCP tools (deferred)", tokens: 500, kind: "deferred" },
    { name: "Free space", tokens: 8000, kind: "free" },
  ],
  mcp_tools: [
    { name: "mcp__a__one", server_name: "a", tokens: 10 },
    { name: "mcp__b__one", server_name: "b", tokens: 50 },
    { name: "mcp__a__two", server_name: "a", tokens: 30 },
  ],
  memory_files: [{ path: "/w/AGENTS.md", type: "Project", tokens: 200 }],
  agents: [],
  skills: [
    { name: "small", source: "userSettings", tokens: 5 },
    { name: "big", source: "plugin", tokens: 90 },
  ],
};

describe("breakdownOf", () => {
  it("leaves out empty rows and groups, sums the tools by server, and puts the biggest first", () => {
    const breakdown = breakdownOf(usage, 42);
    assert.strictEqual(breakdown.measuredAt, 42);
    assert.isTrue(breakdown.measurable);
    assert.deepStrictEqual(
      breakdown.categories.map((c) => c.name),
      ["System prompt", "MCP tools (deferred)", "Free space"],
    );
    assert.deepStrictEqual(breakdown.groups, [
      { kind: "memoryFiles", items: [{ name: "/w/AGENTS.md", source: "Project", tokens: 200 }] },
      {
        kind: "mcpServers",
        items: [
          { name: "b", tokens: 50, tools: 1 },
          { name: "a", tokens: 40, tools: 2 },
        ],
        deferred: "all",
      },
      {
        kind: "skills",
        items: [
          { name: "big", source: "plugin", tokens: 90 },
          { name: "small", source: "userSettings", tokens: 5 },
        ],
      },
    ]);
  });

  it("tells whether the MCP tools are outside the window", () => {
    const mcpGroup = (categories: ContextUsage["categories"]) =>
      breakdownOf({ ...usage, categories }, 0).groups.find((group) => group.kind === "mcpServers");
    const loaded = { name: "MCP tools", tokens: 300, kind: "used" } as const;
    const deferred = { name: "MCP tools (deferred)", tokens: 500, kind: "deferred" } as const;
    assert.strictEqual(mcpGroup([loaded, deferred])?.deferred, "some");
    assert.strictEqual(mcpGroup([loaded, { ...deferred, tokens: 0 }])?.deferred, undefined);
    assert.strictEqual(mcpGroup([loaded])?.deferred, undefined);
  });
});

describe("TabContext", () => {
  const setup = (measures: boolean) =>
    Effect.gen(function* () {
      const posted: Array<Record<string, unknown>> = [];
      const prompts: Array<{ text: unknown; sending: boolean; measuring: boolean | undefined }> = [];
      let queued = 0;
      const tab = new TabList(undefined, () => "/w").active;
      const agent = {
        measuresContext: measures,
        initializeResponse: { protocolVersion: 1 },
        mcpServerNames: () => ["docs"],
        prompt: (_sessionId: string, blocks: ReadonlyArray<{ text?: string }>) =>
          Effect.sync(() => {
            prompts.push({ text: blocks[0]?.text, sending: tab.sending, measuring: tab.measuringContext });
            context.onUsage(tab, "s1", usage);
            return { stopReason: "end_turn" as const };
          }),
      } as unknown as AcpAgent;
      tab.sessionId = "s1";
      tab.running = { agent, agentId: "claude", scope: yield* Scope.make() };
      tab.commands = [
        { name: "compact", description: "" },
        { name: "context", description: "" },
      ];
      const context: TabContext = new TabContext({
        postTab: (_tab, message) => void posted.push(message),
        run: () => {},
        sendQueued: () => void queued++,
      });
      return { tab, context, posted, prompts, queued: () => queued };
    });

  it.effect("runs /context, holding back the user's messages meanwhile, then sends the queue on", () =>
    Effect.gen(function* () {
      const { tab, context, posted, prompts, queued } = yield* setup(true);
      yield* context.measure(tab);
      assert.deepStrictEqual(prompts, [{ text: "/context", sending: true, measuring: true }]);
      assert.isFalse(tab.sending);
      assert.isFalse(tab.measuringContext);
      assert.strictEqual(queued(), 1);
      const last = posted.at(-1) as { breakdown: { measuredAt?: number }; measuring: boolean };
      assert.isFalse(last.measuring);
      assert.isDefined(last.breakdown.measuredAt);
    }),
  );

  it.effect("doesn't measure during a turn, nor with an agent that can't", () =>
    Effect.gen(function* () {
      const busy = yield* setup(true);
      busy.tab.busy = true;
      yield* busy.context.measure(busy.tab);
      assert.deepStrictEqual(busy.prompts, []);
      const other = yield* setup(false);
      yield* other.context.measure(other.tab);
      assert.deepStrictEqual(other.prompts, []);
      other.context.post(other.tab);
      assert.deepStrictEqual(other.posted.at(-1), {
        type: "contextBreakdown",
        breakdown: { categories: [], groups: [{ kind: "mcpServers", items: [{ name: "docs" }] }], measurable: false },
        measuring: false,
      });
    }),
  );
});
