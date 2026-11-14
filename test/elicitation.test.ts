// @vitest-environment happy-dom
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FormElicitationItem } from "../src/ui/chat/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<unknown> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void posted.push(message),
  getState: () => undefined,
  setState: () => {},
});
const { ElicitationView, fieldsOf, stepsOf } = await import("../src/ui/chat/elicitation");

const choice = (title: string, ...values: string[]) => ({
  type: "string" as const,
  title,
  oneOf: values.map((v) => ({ const: v, title: v })),
});

const schema: acp.ElicitationSchema = {
  type: "object",
  properties: {
    color: choice("Color", "red", "blue"),
    colorOther: { type: "string", description: "Something else" },
    size: choice("Size", "S", "M", "L"),
    count: { type: "integer", title: "Count" },
  },
  required: ["color", "size"],
};

describe("stepsOf", () => {
  it("puts each question on its own page, with a choice's free text beside it", () => {
    assert.deepStrictEqual(
      stepsOf(fieldsOf(schema)).map((page) => page.map((f) => f.key)),
      [["color", "colorOther"], ["size"], ["count"]],
    );
  });
});

describe("ElicitationView", () => {
  let container: HTMLElement;
  let root: Root;
  let requestId = 0;
  const draw = (item: Partial<FormElicitationItem> = {}) =>
    act(() =>
      root.render(
        createElement(ElicitationView, {
          item: { kind: "elicitation", id: 1, requestId, message: "", schema, ...item },
        }),
      ),
    );
  const pages = () => [...container.querySelectorAll<HTMLElement>(".elicitation-page")];
  const shown = () => pages().findIndex((p) => !p.hidden);
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.querySelector(".elicitation-option-title") ?? b).textContent === label,
    )!;
  const click = (el: HTMLElement) => act(() => el.click());

  beforeEach(() => {
    posted.length = 0;
    requestId++;
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById("root")!;
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it("shows one question at a time", () => {
    draw();
    assert.strictEqual(pages().length, 3);
    assert.strictEqual(shown(), 0);
    assert.strictEqual(pages().filter((p) => !p.hidden).length, 1);
    assert.strictEqual(container.querySelectorAll(".elicitation-step").length, 3);
  });

  it("moves on when a question that is only a choice is answered, and sends at the end", () => {
    draw();
    click(button("chat.elicitation.next"));
    assert.strictEqual(shown(), 1);
    click(button("chat.elicitation.back"));
    assert.strictEqual(shown(), 0);
    click(button("red"));
    assert.strictEqual(shown(), 0, "a choice with free text beside it waits for Next");
    click(button("chat.elicitation.next"));
    click(button("M"));
    assert.strictEqual(shown(), 2);
    click(button("chat.elicitation.submit"));
    assert.deepStrictEqual(posted, [
      { type: "elicitation", id: requestId, response: { action: "accept", content: { color: "red", size: "M" } } },
    ]);
  });

  it("goes back to an unanswered required question instead of sending", () => {
    draw();
    click(container.querySelectorAll<HTMLButtonElement>(".elicitation-step")[2]!);
    assert.strictEqual(shown(), 2);
    click(button("chat.elicitation.submit"));
    assert.strictEqual(shown(), 0);
    assert.deepStrictEqual(posted, []);
  });

  it("shows only what was picked once answered", () => {
    draw();
    click(button("blue"));
    draw({ outcome: "accept" });
    assert.isTrue(pages().every((p) => !p.hidden));
    assert.deepStrictEqual(
      [...container.querySelectorAll(".elicitation-option-title")].map((e) => e.textContent),
      ["blue"],
    );
    assert.strictEqual(container.querySelectorAll(".elicitation-steps").length, 0);
  });
});
