import { Effect } from "effect";
import * as nodePath from "node:path";
import { CONTEXT_COMMAND, type ContextUsage } from "../claudeContext";
import type { AcpAgent } from "../acpClient";
import * as codex from "../codexContext";
import * as opencode from "../opencodeContext";
import type { ChatUi } from "./host";
import type { Tab } from "./tabs";

/** One thing in the context window: a file, a server, a skill. Without `tokens` when the agent doesn't say. */
export interface ContextItem {
  readonly name: string;
  readonly tokens?: number;
  /** Where it comes from, as the agent names it: "Project", "userSettings", "plugin"… */
  readonly source?: string;
  /** How many tools an MCP server has in the window. */
  readonly tools?: number;
  /** What it is for, as the agent describes it (a skill's description). */
  readonly description?: string;
}

export type ContextGroupKind = "memoryFiles" | "mcpServers" | "skills" | "agents";

export interface ContextGroup {
  readonly kind: ContextGroupKind;
  readonly items: ReadonlyArray<ContextItem>;
  /**
   * Whether the items' tokens are outside the window (deferred MCP tools, loaded only when the agent uses them):
   * all of them, or some, as the agent doesn't say which tool is loaded.
   */
  readonly deferred?: "all" | "some";
}

/** A row of what fills the window. `kind`: in it, its free part, the compaction reserve, or out of it (deferred). */
export interface ContextCategory {
  readonly name: string;
  readonly tokens: number;
  readonly kind: "used" | "free" | "buffer" | "deferred";
}

/**
 * What fills a session's context window: measured by the agent, with `categories` and the tokens of each item, or
 * only what the client knows about the session (the MCP servers it gave it).
 */
export interface ContextBreakdown {
  /** Epoch ms of the measurement; absent when nothing was measured. */
  readonly measuredAt?: number;
  readonly model?: string;
  readonly categories: ReadonlyArray<ContextCategory>;
  readonly groups: ReadonlyArray<ContextGroup>;
  /** Whether the agent can measure the window ("measureContext"). */
  readonly measurable: boolean;
}

const byTokens = (a: ContextItem, b: ContextItem) => (b.tokens ?? 0) - (a.tokens ?? 0);

/** The MCP tools, summed by server. */
function mcpServers(usage: ContextUsage): ContextItem[] {
  const servers = new Map<string, { tokens: number; count: number }>();
  for (const tool of usage.mcp_tools ?? []) {
    const server = servers.get(tool.server_name) ?? { tokens: 0, count: 0 };
    servers.set(tool.server_name, { tokens: server.tokens + tool.tokens, count: server.count + 1 });
  }
  return [...servers].map(([name, { tokens, count }]) => ({ name, tokens, tools: count }));
}

/** The MCP tool rows of the agent's categories ("MCP tools", "MCP tools (deferred)"). */
const isMcpCategory = (category: ContextUsage["categories"][number]) => /^MCP tools\b/i.test(category.name);

/** How much of the MCP tools' tokens is outside the window, by the agent's categories. */
function mcpDeferred(usage: ContextUsage): ContextGroup["deferred"] {
  const mcp = usage.categories.filter((category) => isMcpCategory(category) && category.tokens > 0);
  if (!mcp.some((category) => category.kind === "deferred")) return undefined;
  return mcp.some((category) => category.kind === "used") ? "some" : "all";
}

/** The agent's measurement as the webview shows it. */
export function breakdownOf(usage: ContextUsage, measuredAt: number): ContextBreakdown {
  const deferred = mcpDeferred(usage);
  const groups: ContextGroup[] = [
    {
      kind: "memoryFiles",
      items: (usage.memory_files ?? []).map((file) => ({ name: file.path, source: file.type, tokens: file.tokens })),
    },
    { kind: "mcpServers", items: mcpServers(usage), ...(deferred && { deferred }) },
    {
      kind: "skills",
      items: (usage.skills ?? []).map((skill) => ({ name: skill.name, source: skill.source, tokens: skill.tokens })),
    },
    {
      kind: "agents",
      items:
        usage.agents?.map((agent) => ({ name: agent.agent_type, source: agent.source, tokens: agent.tokens })) ?? [],
    },
  ];
  return {
    measuredAt,
    model: usage.model,
    // Rows may carry no tokens.
    categories: usage.categories.filter((category) => category.tokens > 0),
    groups: groups
      .map((group) => ({ ...group, items: [...group.items].sort(byTokens) }))
      .filter((group) => group.items.length > 0),
    measurable: true,
  };
}

/** What the context breakdown needs from the chat view. */
export interface ContextHost extends Pick<ChatUi, "postTab" | "run"> {
  /** Sends the first message the user queued while the window was measured. */
  sendQueued(tab: Tab): void;
}

/** The skills an agent offers as `$name` commands (Codex does), which it lists to the model. */
const skillsOf = (commands: Tab["commands"]): ContextItem[] =>
  (commands ?? []).flatMap(({ name, description }) =>
    name.startsWith("$") && name.length > 1 ? [{ name: name.slice(1), description: description || undefined }] : [],
  );

/**
 * How the client looks up what an agent that doesn't report it reads into a session in `cwd`: the files Codex
 * finds, or what the OpenCode server knows. Undefined for other agents.
 */
function lookupFor(agent: AcpAgent, cwd: string) {
  const info = agent.initializeResponse.agentInfo;
  if (codex.readsAgentsMd(info?.name)) {
    return codex
      .instructionFiles(cwd)
      .pipe(
        Effect.map((files): ContextGroup[] => [
          { kind: "memoryFiles", items: files.map((file) => ({ name: file.path, source: file.scope })) },
        ]),
      );
  }
  if (opencode.isOpenCodeServer(info) && opencode.apiCommand(agent.command, []) !== undefined) {
    return Effect.all(
      [opencode.instructionFiles(cwd), opencode.skills(agent.command, cwd), opencode.mcpServers(agent.command, cwd)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([files, skills, servers]): ContextGroup[] => [
        { kind: "memoryFiles", items: files.map((file) => ({ name: file.path, source: file.scope })) },
        ...(skills
          ? [
              {
                kind: "skills" as const,
                items: skills.map((skill) => ({
                  name: skill.name,
                  description: skill.description,
                  source: skill.path.startsWith("skill://")
                    ? "builtin"
                    : isWithin(cwd, skill.path)
                      ? "Project"
                      : "User",
                })),
              },
            ]
          : []),
        ...(servers
          ? [
              {
                kind: "mcpServers" as const,
                items: servers.map((server) => ({
                  name: server.name,
                  source: server.status === "connected" ? undefined : server.status,
                })),
              },
            ]
          : []),
      ]),
    );
  }
  return undefined;
}

/** Whether `file` is in the folder `dir`. */
const isWithin = (dir: string, file: string) => {
  const relative = nodePath.relative(dir, file);
  return !!relative && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
};

/** What fills the context windows of tabs' sessions. */
export class TabContext {
  constructor(private readonly host: ContextHost) {}

  /** What was looked up about a tab's session, by tab; `groups` is absent while it is looked up. */
  private readonly found = new WeakMap<Tab, { key: string; groups?: ReadonlyArray<ContextGroup> }>();

  /** Whether the agent of the tab's session can measure its window. */
  private measurable(tab: Tab): boolean {
    return !!tab.running?.agent.measuresContext && !!tab.commands?.some((c) => c.name === CONTEXT_COMMAND);
  }

  /**
   * What the client looks up about the tab's session, for an agent that doesn't report it; looked up the first
   * time the session is shown, and shown when found.
   */
  private lookedUp(tab: Tab, sessionId: string): ReadonlyArray<ContextGroup> {
    const agent = tab.running?.agent;
    const lookup = agent && lookupFor(agent, tab.cwd);
    if (!lookup) return [];
    const key = `${sessionId}\0${tab.cwd}`;
    const known = this.found.get(tab);
    if (known?.key === key) return known.groups ?? [];
    this.found.set(tab, { key });
    this.host.run(
      lookup.pipe(
        Effect.map((groups) => {
          if (this.found.get(tab)?.key !== key) return;
          this.found.set(tab, { key, groups });
          if (groups.length && tab.sessionId === sessionId) this.post(tab);
        }),
      ),
      tab,
    );
    return [];
  }

  /** Shows what is known about the window of the tab's session. */
  post(tab: Tab): void {
    const { sessionId, running } = tab;
    if (!sessionId || !running) {
      this.host.postTab(tab, { type: "contextBreakdown", breakdown: null });
      return;
    }
    const measured = tab.context?.sessionId === sessionId ? tab.context.breakdown : undefined;
    if (measured) {
      this.host.postTab(tab, { type: "contextBreakdown", breakdown: measured, measuring: !!tab.measuringContext });
      return;
    }
    // Only what the client knows of the session, and what it looked up.
    const found = this.lookedUp(tab, sessionId);
    const given = running.agent.mcpServerNames(sessionId).map((name): ContextItem => ({ name }));
    const groups = (["memoryFiles", "mcpServers", "skills"] as const).map((kind): ContextGroup => {
      const items = found.find((group) => group.kind === kind)?.items;
      if (kind === "mcpServers") {
        // The agent's own servers, then those the client gave the session.
        const own = items ?? [];
        return { kind, items: [...own, ...given.filter((s) => !own.some((o) => o.name === s.name))] };
      }
      return { kind, items: items ?? (kind === "skills" ? skillsOf(tab.commands) : []) };
    });
    const breakdown: ContextBreakdown = {
      categories: [],
      groups: groups.filter((group) => group.items.length > 0),
      measurable: this.measurable(tab),
    };
    this.host.postTab(tab, { type: "contextBreakdown", breakdown, measuring: !!tab.measuringContext });
  }

  /**
   * Has the agent measure the window of the tab's session, when it can and is idle: `/context` runs without the
   * model, and its answer goes to "onUsage" instead of the conversation. What the user sends meanwhile is queued.
   */
  readonly measure = Effect.fn("TabContext.measure")(function* (this: TabContext, tab: Tab) {
    const { sessionId, running } = tab;
    if (!sessionId || !running || !this.measurable(tab) || tab.busy || tab.sending) {
      return;
    }
    tab.sending = true;
    tab.measuringContext = true;
    this.post(tab);
    yield* running.agent.prompt(sessionId, [{ type: "text", text: `/${CONTEXT_COMMAND}` }]).pipe(
      Effect.tapError((err) => Effect.logWarning(`Measuring the context window failed: ${err.message}`)),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          tab.sending = false;
          tab.measuringContext = false;
          this.post(tab);
          this.host.sendQueued(tab);
        }),
      ),
    );
  });

  /** The agent measured the window of `sessionId`: asked for by "measure", or by the user's own `/context`. */
  onUsage(tab: Tab, sessionId: string, usage: ContextUsage): void {
    tab.context = { sessionId, breakdown: breakdownOf(usage, Date.now()) };
    if (tab.sessionId === sessionId) {
      this.post(tab);
    }
  }
}
