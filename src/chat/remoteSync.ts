import { Effect, Result } from "effect";
import { isOpenCode } from "../opencodeContext";
import { isIdle, type RunningAgent, type Tab } from "./tabs";

/** How often the sessions of the tabs are checked while the chat is in view. */
export const REMOTE_SYNC_INTERVAL_MS = 5000;

/** A tab whose session another client changed, and when that session was last updated. */
export interface RemoteChange {
  readonly tab: Tab;
  readonly sessionId: string;
  readonly updatedAt: string;
}

/**
 * Whether the tab's session can change from elsewhere and be shown again: OpenCode serves its app, web and TUI from
 * the same sessions, but its ACP agent only reports the turns this chat runs. It lists sessions with their
 * `updatedAt` (session/list) and replays them (session/load).
 */
function watchable(tab: Tab): tab is Tab & { running: RunningAgent; sessionId: string } {
  const init = tab.running?.agent.initializeResponse;
  return (
    tab.sessionId !== undefined &&
    isOpenCode(init?.agentInfo) &&
    !!init?.agentCapabilities?.loadSession &&
    !!init.agentCapabilities.sessionCapabilities?.list
  );
}

/**
 * Notices what other clients of OpenCode (its phone app with remote on, the web, the TUI) add to the sessions the
 * tabs show, by when each session was last updated. What the tab did itself is not a change: a tab at work, or
 * whose turn just ended, takes the next time it is listed with as seen.
 */
export class RemoteSync {
  private readonly seen = new WeakMap<Tab, { readonly sessionId: string; readonly updatedAt: string }>();

  /** The tab changed its session itself (a turn, an option): the next check takes its time as seen. */
  forget(tab: Tab): void {
    this.seen.delete(tab);
  }

  /** The tab shows its session as it was at `updatedAt`. */
  shown(change: RemoteChange): void {
    if (change.tab.sessionId === change.sessionId) {
      this.seen.set(change.tab, { sessionId: change.sessionId, updatedAt: change.updatedAt });
    }
  }

  /** The tabs whose session was updated by another client since last seen, one session/list per agent and folder. */
  readonly changes = Effect.fn("RemoteSync.changes")(function* (this: RemoteSync, tabs: ReadonlyArray<Tab>) {
    const byFolder = new Map<RunningAgent, Map<string, Array<Tab & { sessionId: string }>>>();
    for (const tab of tabs.filter(watchable)) {
      const folders = byFolder.get(tab.running) ?? new Map<string, Array<Tab & { sessionId: string }>>();
      byFolder.set(tab.running, folders);
      folders.set(tab.cwd, [...(folders.get(tab.cwd) ?? []), tab]);
    }
    const changes: RemoteChange[] = [];
    for (const [running, folders] of byFolder) {
      for (const [cwd, watched] of folders) {
        const listed = yield* Effect.result(running.agent.listSessions(cwd));
        if (Result.isFailure(listed)) {
          yield* Effect.logDebug(`Listing the sessions in ${cwd} failed: ${listed.failure.message}`);
          continue;
        }
        const updated = new Map(listed.success.sessions.map((s) => [s.sessionId, s.updatedAt ?? undefined]));
        for (const tab of watched) {
          const updatedAt = updated.get(tab.sessionId);
          // The tab moved on while the agent listed, or its session isn't among the latest, so unchanged.
          if (updatedAt === undefined || tab.running !== running || tab.cwd !== cwd) {
            continue;
          }
          if (!isIdle(tab)) {
            this.forget(tab);
            continue;
          }
          const last = this.seen.get(tab);
          if (last?.sessionId === tab.sessionId && last.updatedAt !== updatedAt) {
            changes.push({ tab, sessionId: tab.sessionId, updatedAt });
          } else {
            this.seen.set(tab, { sessionId: tab.sessionId, updatedAt });
          }
        }
      }
    }
    return changes;
  });
}
