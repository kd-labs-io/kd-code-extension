// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ContextBreakdown } from "../src/chat/contextBreakdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<unknown> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
const { UsageMeter } = await import("../src/ui/chat/usageMeter");

const measured: ContextBreakdown = {
  measuredAt: Date.now(),
  model: "claude",
  categories: [
    { name: "System prompt", tokens: 2000, kind: "used" },
    { name: "Free space", tokens: 8000, kind: "free" },
  ],
  groups: [{ kind: "mcpServers", items: [{ name: "docs", tokens: 300, tools: 2 }] }],
  measurable: true,
};

describe("UsageMeter", () => {
  let container: HTMLElement;
  let root: Root;
  const draw = (props: {
    busy?: boolean;
    onCompact?: () => void;
    context?: ContextBreakdown;
    contextStale?: boolean;
    onMeasure?: () => void;
  }) =>
    act(() =>
      root.render(
        createElement(UsageMeter, {
          usage: { used: 10, size: 100 },
          compactAt: undefined,
          totals: undefined,
          busy: props.busy ?? false,
          onCompact: props.onCompact,
          context: props.context,
          measuring: false,
          contextStale: props.contextStale ?? false,
          onMeasure: props.onMeasure,
        }),
      ),
    );
  const button = () => container.querySelector("button");

  beforeEach(() => {
    posted.length = 0;
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById("root")!;
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it("offers no compact button when the agent has no such command", () => {
    draw({});
    assert.isNull(button());
  });

  it("compacts on click, without opening the usage summary", () => {
    let compacted = 0;
    draw({ onCompact: () => compacted++ });
    act(() => button()!.click());
    assert.strictEqual(compacted, 1);
    assert.deepStrictEqual(posted, []);
  });

  it("does not submit the composer form around it", () => {
    draw({ onCompact: () => {} });
    assert.strictEqual(button()!.getAttribute("type"), "button");
  });

  it("disables the button during a turn, and a click beside it opens nothing", () => {
    draw({ busy: true, onCompact: () => {} });
    assert.isTrue(button()!.disabled);
    act(() => (container.querySelector(".usage-actions") as HTMLElement).click());
    assert.deepStrictEqual(posted, []);
  });

  it("opens the usage summary from the ring and the panel", () => {
    draw({ onCompact: () => {} });
    const ring = container.querySelector("#usage-ring") as HTMLElement;
    act(() => ring.click());
    act(() => void ring.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => (container.querySelector(".usage-hint") as HTMLElement).click());
    assert.deepStrictEqual(posted, [{ type: "showUsage" }, { type: "showUsage" }, { type: "showUsage" }]);
  });

  it("shows what fills the window, and measures it again on opening once it is old", () => {
    let measures = 0;
    draw({ context: measured, contextStale: false, onMeasure: () => measures++ });
    const rows = [...container.querySelectorAll(".context-row .context-name")].map((el) => el.textContent);
    assert.deepStrictEqual(rows, ["System prompt", "Free space"]);
    assert.include(container.querySelector(".context-group")!.textContent, "docs");
    const usage = container.querySelector("#usage") as HTMLElement;
    act(() => void usage.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    assert.strictEqual(measures, 0);
    draw({ context: measured, contextStale: true, onMeasure: () => measures++ });
    act(() => void usage.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    act(() => void usage.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    assert.strictEqual(measures, 1);
  });

  it("measures again from its button, without opening the usage summary", () => {
    let measures = 0;
    draw({ context: measured, onMeasure: () => measures++ });
    act(() => (container.querySelector(".context-footer button") as HTMLButtonElement).click());
    act(() => (container.querySelector(".context-group summary") as HTMLElement).click());
    assert.strictEqual(measures, 1);
    assert.deepStrictEqual(posted, []);
  });

  it("lists the servers of an agent that can't measure, without a button", () => {
    draw({
      context: { categories: [], groups: [{ kind: "mcpServers", items: [{ name: "docs" }] }], measurable: false },
    });
    assert.isNull(container.querySelector(".context-footer"));
    assert.isNull(container.querySelector(".context-bar"));
    assert.isNotNull(container.querySelector(".usage-bar"));
    assert.include(container.querySelector(".context-group")!.textContent, "docs");
  });
});
