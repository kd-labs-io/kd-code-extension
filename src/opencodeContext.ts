import { Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as os from "node:os";
import type { AgentCommand } from "./acpClient";

/**
 * What an OpenCode v2 session reads, which its ACP agent doesn't report. OpenCode keeps sessions in a background
 * server shared with its ACP agent, and `opencode api` reaches it (and logs in to it) on the client's behalf: the
 * skills and MCP servers of a folder come from there. The instruction files are found the way OpenCode finds them.
 */

const OPENCODE_AGENT = "OpenCode";

/** Whether the agent is OpenCode, any version. */
export function isOpenCode(agentInfo: { name: string } | null | undefined): boolean {
  return agentInfo?.name === OPENCODE_AGENT;
}

/** Whether the agent is OpenCode v2 or later, whose server answers `opencode api`. */
export function isOpenCodeServer(agentInfo: { name: string; version: string } | null | undefined): boolean {
  if (agentInfo?.name !== OPENCODE_AGENT) return false;
  const major = Number.parseInt(agentInfo.version, 10);
  return Number.isFinite(major) && major >= 2;
}

/** `opencode api …` from the command that started the agent (`opencode acp`); undefined for another launch. */
export function apiCommand(agent: AgentCommand, request: ReadonlyArray<string>): AgentCommand | undefined {
  if (agent.args.at(-1) !== "acp") return undefined;
  return { ...agent, args: [...agent.args.slice(0, -1), "api", ...request] };
}

const TIMEOUT = Duration.seconds(15);

const Skills = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String), path: Schema.String }),
  ),
});
const McpServers = Schema.Struct({
  data: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.Struct({ status: Schema.String }) })),
});

const decodeSkills = Schema.decodeUnknownOption(Schema.fromJsonString(Skills));
const decodeMcpServers = Schema.decodeUnknownOption(Schema.fromJsonString(McpServers));

export interface OpenCodeSkill {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
}

export interface OpenCodeServer {
  readonly name: string;
  /** "connected", "failed", "disabled"… */
  readonly status: string;
}

/** `GET path` on the OpenCode server, for the folder `cwd`; none when it fails. */
const get = <A>(agent: AgentCommand, path: string, cwd: string, decode: (json: string) => Option.Option<A>) =>
  Effect.gen(function* () {
    const command = apiCommand(agent, ["GET", `${path}?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`]);
    if (!command) return Option.none<A>();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command.command, [...command.args], {
        cwd,
        env: { ...command.env },
        extendEnv: true,
        shell: process.platform === "win32",
      }),
    );
    const [stdout, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
      concurrency: "unbounded",
    });
    if (code !== 0) return Option.none<A>();
    return decode(stdout);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.succeed(Option.none<A>()) }),
    Effect.tapCause((cause) => Effect.logDebug(`OpenCode ${path} failed`, cause)),
    Effect.orElseSucceed(() => Option.none<A>()),
  );

/**
 * The skills OpenCode offers in `cwd`. The server answers with none while it loads a folder it hasn't served yet,
 * so it is asked once more then.
 */
export const skills = Effect.fn("opencodeContext.skills")(function* (agent: AgentCommand, cwd: string) {
  const once = get(agent, "/api/skill", cwd, decodeSkills);
  let found = yield* once;
  if (Option.isSome(found) && found.value.data.length === 0) {
    yield* Effect.sleep("1 second");
    found = yield* once;
  }
  return Option.match(found, {
    onNone: () => undefined,
    onSome: ({ data }): ReadonlyArray<OpenCodeSkill> => data,
  });
});

/** The MCP servers of OpenCode's own config for `cwd`, with their status. */
export const mcpServers = Effect.fn("opencodeContext.mcpServers")(function* (agent: AgentCommand, cwd: string) {
  return Option.match(yield* get(agent, "/api/mcp", cwd, decodeMcpServers), {
    onNone: () => undefined,
    onSome: ({ data }): ReadonlyArray<OpenCodeServer> =>
      data.map(({ name, status }) => ({ name, status: status.status })),
  });
});

export interface OpenCodeInstructionFile {
  readonly path: string;
  readonly scope: "User" | "Project";
}

/** File names OpenCode reads instructions from in a project, by preference: the first one found anywhere wins. */
const PROJECT_NAMES = ["AGENTS.md", "CLAUDE.md"];

/**
 * The instruction files OpenCode reads for a session in `cwd`: its global `AGENTS.md` (or Claude Code's
 * `CLAUDE.md` when it has none), then every `AGENTS.md` from `cwd` up to the repository root (or every
 * `CLAUDE.md` when there is none). Files listed in the config's `instructions` are not looked for.
 */
export const instructionFiles = Effect.fn("opencodeContext.instructionFiles")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const home = os.homedir();
  const config = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const files: OpenCodeInstructionFile[] = [];
  for (const global of [path.join(config, "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md")]) {
    if (yield* exists(global)) {
      files.push({ path: global, scope: "User" });
      break;
    }
  }
  // From `cwd` up to the repository root, or only `cwd` outside one.
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (yield* exists(path.join(dir, ".git"))) break;
    if (path.dirname(dir) === dir) {
      dirs.splice(1);
      break;
    }
  }
  for (const name of PROJECT_NAMES) {
    const found: string[] = [];
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (yield* exists(file)) found.unshift(file);
    }
    if (found.length) {
      files.push(...found.map((file) => ({ path: file, scope: "Project" as const })));
      break;
    }
  }
  return files;
});
