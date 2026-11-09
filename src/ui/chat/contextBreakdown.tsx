import refreshIcon from "@tabler/icons/outline/refresh.svg";
import type { ContextBreakdown, ContextCategory, ContextGroupKind, ContextItem } from "../../chat/contextBreakdown";
import type { MessageKey } from "../l10n";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import { relativeTime } from "./historyList";
import { openFile } from "./post";

/** Colors of the categories in the window, in their order; the free part and the reserve have their own. */
const COLORS = [
  "var(--vscode-charts-blue)",
  "var(--vscode-charts-green)",
  "var(--vscode-charts-purple)",
  "var(--vscode-charts-orange)",
  "var(--vscode-charts-yellow)",
  "var(--vscode-charts-red)",
  "var(--vscode-terminal-ansiCyan)",
  "var(--vscode-terminal-ansiMagenta)",
];

const GROUP_TITLES: Record<ContextGroupKind, MessageKey> = {
  memoryFiles: "chat.context.memoryFiles",
  mcpServers: "chat.context.mcpServers",
  skills: "chat.context.skills",
  agents: "chat.context.agents",
};

/** Labels of the sources the agent names by their settings layer, or as the type of a memory file. */
const SOURCES: Record<string, MessageKey> = {
  userSettings: "chat.context.source.user",
  projectSettings: "chat.context.source.project",
  localSettings: "chat.context.source.local",
  policySettings: "chat.context.source.policy",
  plugin: "chat.context.source.plugin",
  builtin: "chat.context.source.builtin",
  User: "chat.context.source.user",
  Project: "chat.context.source.project",
  Local: "chat.context.source.local",
  Managed: "chat.context.source.policy",
};

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * What fills the context window, in the context meter's panel: a bar and a row per category, then the files,
 * servers, skills and agents in it. `onMeasure` asks the agent to measure it again; absent when it can't.
 */
export function ContextBreakdownView({
  breakdown,
  measuring,
  onMeasure,
}: {
  breakdown: ContextBreakdown;
  measuring: boolean;
  onMeasure: (() => void) | undefined;
}) {
  const { t, lang } = useL10n();
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 });
  const inWindow = breakdown.categories.filter((c) => c.kind !== "deferred");
  const deferred = breakdown.categories.filter((c) => c.kind === "deferred");
  const total = inWindow.reduce((sum, c) => sum + c.tokens, 0);
  const used = inWindow.filter((c) => c.kind === "used");
  const colorOf = (category: ContextCategory) =>
    category.kind === "used" ? COLORS[used.indexOf(category) % COLORS.length] : undefined;
  const source = (item: ContextItem) => {
    const key = item.source !== undefined ? SOURCES[item.source] : undefined;
    return key ? t(key) : item.source;
  };
  const itemDetail = (item: ContextItem) =>
    [item.tools !== undefined ? t("chat.context.tools", item.tools) : undefined, source(item)]
      .filter(Boolean)
      .join(" · ");
  return (
    <span className="context-breakdown">
      {total > 0 && (
        <span className="context-bar">
          {inWindow.map((category) => (
            <span
              key={category.name}
              data-kind={category.kind}
              style={{ width: `${(category.tokens / total) * 100}%`, background: colorOf(category) }}
            />
          ))}
        </span>
      )}
      {inWindow.map((category) => (
        <span key={category.name} className="context-row" data-kind={category.kind}>
          <span className="context-swatch" style={{ background: colorOf(category) }} />
          <span className="context-name">{category.name}</span>
          <span className="context-tokens">{compact.format(category.tokens)}</span>
          <span className="context-percent">{percent.format(total > 0 ? category.tokens / total : 0)}</span>
        </span>
      ))}
      {deferred.map((category) => (
        <span key={category.name} className="context-row" data-kind="deferred" title={t("chat.context.deferred")}>
          <span className="context-swatch" />
          <span className="context-name">{category.name}</span>
          <span className="context-tokens">{compact.format(category.tokens)}</span>
          <span className="context-percent" />
        </span>
      ))}
      {breakdown.groups.map((group) => {
        const tokens = group.items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
        return (
          <details key={group.kind} className="context-group">
            <summary>
              <span className="context-name">
                {t(GROUP_TITLES[group.kind])} <span className="context-count">{group.items.length}</span>
              </span>
              {tokens > 0 && <span className="context-tokens">{compact.format(tokens)}</span>}
            </summary>
            <span className="context-items">
              {group.items.map((item) => (
                <span
                  key={item.name}
                  className="context-item"
                  title={item.description ? `${item.name}\n${item.description}` : item.name}
                >
                  {group.kind === "memoryFiles" ? (
                    <a className="context-name" onClick={() => openFile({ path: item.name })}>
                      {fileName(item.name)}
                    </a>
                  ) : (
                    <span className="context-name">{item.name}</span>
                  )}
                  <span className="context-detail">{itemDetail(item)}</span>
                  {item.tokens !== undefined && <span className="context-tokens">{compact.format(item.tokens)}</span>}
                </span>
              ))}
            </span>
          </details>
        );
      })}
      {(breakdown.measurable || breakdown.measuredAt !== undefined) && (
        <span className="context-footer">
          <span>
            {measuring
              ? t("chat.context.measuring")
              : breakdown.measuredAt !== undefined
                ? t("chat.context.measuredAt", relativeTime(lang, new Date(breakdown.measuredAt).toISOString()))
                : t("chat.context.notMeasured")}
          </span>
          {onMeasure && (
            <button
              type="button"
              className="icon-btn"
              disabled={measuring}
              title={t("chat.context.measure")}
              aria-label={t("chat.context.measure")}
              onClick={onMeasure}
            >
              <Icon svg={refreshIcon} />
            </button>
          )}
        </span>
      )}
    </span>
  );
}
