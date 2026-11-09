import { Effect, FileSystem, Path } from "effect";
import * as os from "node:os";

/**
 * The instruction files Codex reads into a session, found the way Codex finds them: the agent doesn't report
 * them. One global file in `CODEX_HOME`, then one per directory from the project root (the nearest one with a
 * `.git`) down to the session's folder; `AGENTS.override.md` wins over `AGENTS.md`, and empty files don't count.
 * Fallback names set in `config.toml` (`project_doc_fallback_filenames`) are not looked for.
 */

/** Agents that read `AGENTS.md` files the way Codex does. */
const CODEX_AGENTS = new Set(["@agentclientprotocol/codex-acp", "codex-acp"]);

export const readsAgentsMd = (agentName: string | undefined): boolean =>
  agentName !== undefined && CODEX_AGENTS.has(agentName);

const NAMES = ["AGENTS.override.md", "AGENTS.md"];

export interface InstructionFile {
  readonly path: string;
  readonly scope: "User" | "Project";
}

/** The folders from the project root down to `cwd`; only `cwd` when it is in no repository. */
const projectDirs = Effect.fn("codexContext.projectDirs")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false))) return dirs;
    if (path.dirname(dir) === dir) return [path.resolve(cwd)];
  }
});

/** The first of `NAMES` in `dir` with something in it. */
const instructionsIn = Effect.fn("codexContext.instructionsIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of NAMES) {
    const file = path.join(dir, name);
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (text.trim()) return file;
  }
  return undefined;
});

/** The instruction files Codex reads for a session in `cwd`, in the order it reads them. */
export const instructionFiles = Effect.fn("codexContext.instructionFiles")(function* (cwd: string) {
  const path = yield* Path.Path;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const files: InstructionFile[] = [];
  const global = yield* instructionsIn(home);
  if (global) files.push({ path: global, scope: "User" });
  for (const dir of yield* projectDirs(cwd)) {
    const file = yield* instructionsIn(dir);
    if (file) files.push({ path: file, scope: "Project" });
  }
  return files;
});
