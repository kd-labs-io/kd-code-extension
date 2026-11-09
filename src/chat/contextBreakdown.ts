import { Effect } from "effect";
import { CONTEXT_COMMAND, type ContextUsage } from "../claudeContext";
import { instructionFiles, readsAgentsMd, type InstructionFile } from "../codexContext";
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

/** The agent's measurement as the webview shows it. */
export function breakdownOf(usage: ContextUsage, measuredAt: number): ContextBreakdown {
  const groups: ContextGroup[] = [
    {
      kind: "memoryFiles",
      items: (usage.memory_files ?? []).map((file) => ({ name: file.path, source: file.type, tokens: file.tokens })),
    },
    { kind: "mcpServers", items: mcpServers(usage) },
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

/** What fills the context windows of tabs' sessions. */
export class TabContext {
  constructor(private readonly host: ContextHost) {}

  /** The instruction files found for a tab's session, by tab; `undefined` while they are looked for. */
  private readonly instructions = new WeakMap<Tab, { key: string; files?: ReadonlyArray<InstructionFile> }>();

  /** Whether the agent of the tab's session can measure its window. */
  private measurable(tab: Tab): boolean {
    return !!tab.running?.agent.measuresContext && !!tab.commands?.some((c) => c.name === CONTEXT_COMMAND);
  }

  /**
   * The instruction files an agent that doesn't report them reads into the tab's session, once found; looks for
   * them, and shows them when found, the first time the session is shown.
   */
  private instructionFiles(tab: Tab, sessionId: string): ReadonlyArray<InstructionFile> {
    if (!readsAgentsMd(tab.running?.agent.initializeResponse.agentInfo?.name)) return [];
    const key = `${sessionId}\0${tab.cwd}`;
    const known = this.instructions.get(tab);
    if (known?.key === key) return known.files ?? [];
    this.instructions.set(tab, { key });
    this.host.run(
      instructionFiles(tab.cwd).pipe(
        Effect.map((files) => {
          if (this.instructions.get(tab)?.key !== key) return;
          this.instructions.set(tab, { key, files });
          if (files.length && tab.sessionId === sessionId) this.post(tab);
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
    // Only what the client knows of the session.
    const groups: ContextGroup[] = [
      {
        kind: "memoryFiles",
        items: this.instructionFiles(tab, sessionId).map((file) => ({ name: file.path, source: file.scope })),
      },
      { kind: "mcpServers", items: running.agent.mcpServerNames(sessionId).map((name) => ({ name })) },
      { kind: "skills", items: skillsOf(tab.commands) },
    ];
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
