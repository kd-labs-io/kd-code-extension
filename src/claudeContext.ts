import { Option, Schema } from "effect";

/**
 * How full a Claude session's context window is, by what fills it. ACP has no such report: claude-agent-acp
 * answers `/context` with a table in the conversation, and the SDK message that carries the table also carries
 * the same numbers as `context_usage`. The agent forwards its SDK messages as `_claude/sdkMessage` when the
 * session asks for them in `_meta`, so the client takes them off the stream before the ACP SDK sees them.
 */

/** Agents that forward SDK messages ("emitRawSDKMessages") and answer `/context` with `context_usage`. */
const CLAUDE_AGENTS = new Set(["@agentclientprotocol/claude-agent-acp"]);

export const measuresContext = (agentName: string | undefined): boolean =>
  agentName !== undefined && CLAUDE_AGENTS.has(agentName);

/** Session `_meta` asking for the SDK's assistant messages, of which the `/context` answer is one. */
export const CONTEXT_USAGE_SESSION_META = {
  claudeCode: { emitRawSDKMessages: [{ type: "assistant" }] },
} as const;

/** The prompt the agent answers with `context_usage`; it runs locally, without the model. */
export const CONTEXT_COMMAND = "context";

const SDK_MESSAGE_METHOD = "_claude/sdkMessage";

const Tokens = Schema.Finite;

const ContextCategory = Schema.Struct({
  name: Schema.String,
  tokens: Tokens,
  /** What the row is: in the window, the free part of it, the compaction reserve, or out of it (deferred tools). */
  kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
});

const Named = Schema.Struct({ name: Schema.String, tokens: Tokens });

export const ContextUsage = Schema.Struct({
  model: Schema.String,
  total_tokens: Tokens,
  raw_max_tokens: Tokens,
  categories: Schema.Array(ContextCategory),
  mcp_tools: Schema.optional(Schema.Array(Schema.Struct({ ...Named.fields, server_name: Schema.String }))),
  memory_files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String, tokens: Tokens })),
  ),
  agents: Schema.optional(
    Schema.Array(Schema.Struct({ agent_type: Schema.String, source: Schema.String, tokens: Tokens })),
  ),
  skills: Schema.optional(Schema.Array(Schema.Struct({ ...Named.fields, source: Schema.String }))),
});
export type ContextUsage = typeof ContextUsage.Type;

const ContextUsageNotification = Schema.Struct({
  method: Schema.Literal(SDK_MESSAGE_METHOD),
  params: Schema.Struct({
    sessionId: Schema.String,
    message: Schema.Struct({ type: Schema.Literal("assistant"), context_usage: ContextUsage }),
  }),
});

const decodeNotification = Schema.decodeUnknownOption(ContextUsageNotification);
const isSdkMessage = Schema.is(Schema.Struct({ method: Schema.Literal(SDK_MESSAGE_METHOD) }));

/**
 * What `message` is to the client: a `/context` answer to pass on, another SDK message to drop (the ACP SDK
 * would answer an unknown notification with an error log), or none of them.
 */
export function contextUsageOf(message: unknown): { sessionId: string; usage: ContextUsage } | "drop" | undefined {
  if (!isSdkMessage(message)) return undefined;
  const decoded = Option.getOrUndefined(decodeNotification(message));
  return decoded ? { sessionId: decoded.params.sessionId, usage: decoded.params.message.context_usage } : "drop";
}
