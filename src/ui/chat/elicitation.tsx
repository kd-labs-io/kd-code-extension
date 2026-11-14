import type * as acp from "@agentclientprotocol/sdk";
import { memo, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ElicitationAnswer, ElicitationValue } from "../../chat/protocol";
import { MarkdownView } from "../markdown";
import { useL10n } from "../l10n";
import { openFile, post } from "./post";
import type { FormElicitationItem, UrlElicitationItem } from "./transcript";

interface Choice {
  value: string;
  title: string;
  description?: string;
}

interface FieldBase {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
}

/** A field of the form the chat knows how to show; others are left out. */
type Field = FieldBase &
  (
    | { kind: "choice"; choices: Choice[]; multiple: boolean; minItems?: number; maxItems?: number }
    | { kind: "text"; format?: acp.StringFormat; minLength?: number; maxLength?: number; pattern?: string }
    | { kind: "number"; integer: boolean; minimum?: number; maximum?: number }
    | { kind: "boolean" }
  );

/** What a field holds while the user fills it in: numbers as typed, unparsed. */
type Draft = Record<string, string | string[] | boolean | undefined>;

const opt = <T,>(value: T | null | undefined): T | undefined => value ?? undefined;

export function fieldsOf(schema: acp.ElicitationSchema): Field[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([key, property]): Field[] => {
    // Every known property type has these; an unknown one is left out below.
    const { title, description } = property as { title?: string | null; description?: string | null };
    const base = { key, title: opt(title), description: opt(description), required: required.has(key) };
    switch (property.type) {
      case "string": {
        const p = property as acp.StringPropertySchema;
        const choices =
          p.oneOf?.map((o) => ({ value: o.const, title: o.title, description: opt(o.description) })) ??
          p.enum?.map((value) => ({ value, title: value }));
        if (choices) return [{ ...base, kind: "choice", choices, multiple: false }];
        return [
          {
            ...base,
            kind: "text",
            format: opt(p.format),
            minLength: opt(p.minLength),
            maxLength: opt(p.maxLength),
            pattern: opt(p.pattern),
          },
        ];
      }
      case "number":
      case "integer": {
        const p = property as acp.NumberPropertySchema;
        return [
          {
            ...base,
            kind: "number",
            integer: property.type === "integer",
            minimum: opt(p.minimum),
            maximum: opt(p.maximum),
          },
        ];
      }
      case "boolean":
        return [{ ...base, kind: "boolean" }];
      case "array": {
        const p = property as acp.MultiSelectPropertySchema;
        const items = p.items as Partial<acp.TitledMultiSelectItems & acp.StringMultiSelectItems>;
        const choices =
          items.anyOf?.map((o) => ({ value: o.const, title: o.title, description: opt(o.description) })) ??
          items.enum?.map((value) => ({ value, title: value }));
        if (!choices) return [];
        return [
          { ...base, kind: "choice", choices, multiple: true, minItems: opt(p.minItems), maxItems: opt(p.maxItems) },
        ];
      }
      default:
        return [];
    }
  });
}

function defaults(schema: acp.ElicitationSchema): Draft {
  const draft: Draft = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const value = property.default;
    if (typeof value === "number") draft[key] = String(value);
    else if (typeof value === "string" || typeof value === "boolean" || Array.isArray(value))
      draft[key] = value as Draft[string];
  }
  return draft;
}

/** The field's value as sent to the agent; undefined when it is left empty. */
function valueOf(field: Field, value: Draft[string]): ElicitationValue | undefined {
  switch (field.kind) {
    case "boolean":
      return value === true;
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case "choice":
      if (field.multiple) return Array.isArray(value) && value.length > 0 ? value : undefined;
      return typeof value === "string" ? value : undefined;
    case "text":
      if (typeof value !== "string" || value.trim() === "") return undefined;
      // datetime-local has no zone; the schema's date-time is RFC 3339.
      return field.format === "date-time" ? new Date(value).toISOString() : value;
  }
}

/** Whether the selection count of a multi-select is within its bounds. */
function countOk(field: Field, value: Draft[string]): boolean {
  if (field.kind !== "choice" || !field.multiple) return true;
  const n = Array.isArray(value) ? value.length : 0;
  return n >= (field.minItems ?? 0) && n <= (field.maxItems ?? Infinity);
}

/** Whether `field` may be sent as it is filled in. */
const fieldOk = (field: Field, value: Draft[string]) =>
  (!field.required || valueOf(field, value) !== undefined) && countOk(field, value);

/**
 * The questions of a form, one page each. Free text right after a choice is that choice's "other" answer, so it
 * shares its page.
 */
export function stepsOf(fields: readonly Field[]): Field[][] {
  const steps: Field[][] = [];
  for (const field of fields) {
    const page = steps.at(-1);
    if (page?.length === 1 && page[0]!.kind === "choice" && field.kind === "text") page.push(field);
    else steps.push([field]);
  }
  return steps;
}

const labelOf = (field: Field) => field.title ?? field.description ?? field.key;

/** What the user filled in so far, by request; kept while the tab is not shown. */
const drafts = new Map<number, Draft>();
/** The question shown, by request; kept while the tab is not shown. */
const shownSteps = new Map<number, number>();

const FOCUSABLE = "button.elicitation-option, input, textarea";

/** Whether the user is typing somewhere a form taking focus would interrupt. */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== "";
  return el.isContentEditable && (el.textContent ?? "") !== "";
}

const isMac = navigator.userAgent.includes("Mac");

/**
 * A link the agent asks the user to open: its host and whole address as the host normalized them, and the message as
 * plain text, so nothing the agent wrote can pass for another address. Nothing has the focus, so typing can't open it.
 */
export const UrlElicitationView = memo(function UrlElicitationView({ item }: { item: UrlElicitationItem }) {
  const { t } = useL10n();
  const done = item.outcome !== undefined;
  const answer = (response: ElicitationAnswer) => post({ type: "elicitation", id: item.requestId, response });
  const outcome = item.completed
    ? "chat.elicitation.linkFinished"
    : item.outcome === "accept"
      ? "chat.elicitation.linkOpened"
      : item.outcome === "decline"
        ? "chat.elicitation.declined"
        : "chat.elicitation.cancelled";
  return (
    <div className={"elicitation" + (done ? " done" : "")}>
      <div className="elicitation-title">{t("chat.elicitation.linkTitle")}</div>
      {item.message && <div className="elicitation-link-message">{item.message}</div>}
      <div className="elicitation-link-host">{new URL(item.url).host}</div>
      <code className="elicitation-link">{item.url}</code>
      {done ? (
        <div className="elicitation-outcome">{t(outcome)}</div>
      ) : (
        <div className="elicitation-actions">
          <button type="button" onClick={() => answer({ action: "accept" })}>
            {t("chat.elicitation.open")}
          </button>
          <button type="button" className="secondary" onClick={() => answer({ action: "decline" })}>
            {t("chat.elicitation.decline")}
          </button>
        </div>
      )}
    </div>
  );
});

/**
 * A form the agent asks the user to fill in: choices as cards, numbered for the keyboard, beside free text. Several
 * questions show one at a time, so a long form doesn't have to be scrolled through; an answered form shows only what
 * was picked.
 */
export const ElicitationView = memo(function ElicitationView({ item }: { item: FormElicitationItem }) {
  const { t } = useL10n();
  const [fields] = useState(() => fieldsOf(item.schema));
  const [steps] = useState(() => stepsOf(fields));
  const [draft, setDraft] = useState<Draft>(() => drafts.get(item.requestId) ?? defaults(item.schema));
  const last = steps.length - 1;
  const [step, setStep] = useState(() => Math.min(shownSteps.get(item.requestId) ?? 0, Math.max(last, 0)));
  const form = useRef<HTMLFormElement>(null);
  const done = item.outcome !== undefined;
  const paged = !done && steps.length > 1;
  /** Set when the shown question changes: its first control takes the focus, and maybe shows why it can't be sent. */
  const moved = useRef<{ report: boolean }>(undefined);

  const page = () => form.current?.querySelector<HTMLElement>(paged ? `[data-step="${step}"]` : "fieldset");

  useLayoutEffect(() => {
    if (!done && !typingElsewhere()) page()?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const how = moved.current;
    if (!how) return;
    moved.current = undefined;
    page()?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    form.current?.scrollIntoView({ block: "nearest" });
    if (how.report) form.current?.reportValidity();
  }, [step]);

  const go = (to: number, report = false) => {
    moved.current = { report };
    shownSteps.set(item.requestId, to);
    setStep(to);
  };

  const set = (key: string, value: Draft[string]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      drafts.set(item.requestId, next);
      return next;
    });

  const pick = (field: Field & { kind: "choice" }, value: string) => {
    const current = draft[field.key];
    if (field.multiple) {
      const list = Array.isArray(current) ? current : [];
      set(field.key, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    } else {
      // Picking the chosen option again clears it, e.g. to answer with free text only.
      set(field.key, current === value ? undefined : value);
      // A question that is just this choice is answered by it.
      if (paged && current !== value && step < last && steps[step]!.length === 1) go(step + 1);
    }
  };

  const stepOk = (fs: readonly Field[]) => fs.every((f) => fieldOk(f, draft[f.key]));
  const answered = (fs: readonly Field[]) => fs.some((f) => valueOf(f, draft[f.key]) !== undefined);
  const complete = stepOk(fields);

  const answer = (response: ElicitationAnswer) => post({ type: "elicitation", id: item.requestId, response });

  /** Sends the answers, or shows the first question that can't be sent yet. */
  const finish = () => {
    if (done) return;
    const missing = steps.findIndex((s) => !stepOk(s));
    if (missing >= 0) {
      if (paged && missing !== step) go(missing);
      return;
    }
    // Questions not shown are hidden, not gone, so the browser still checks their inputs.
    const invalid = form.current?.querySelector<HTMLElement>("input:invalid, textarea:invalid");
    if (invalid) {
      const at = Number(invalid.closest<HTMLElement>("[data-step]")?.dataset["step"] ?? step);
      if (paged && at !== step) go(at, true);
      else form.current?.reportValidity();
      return;
    }
    const content: Record<string, ElicitationValue> = {};
    for (const f of fields) {
      const value = valueOf(f, draft[f.key]);
      if (value !== undefined) content[f.key] = value;
    }
    answer({ action: "accept", content });
  };

  /** Shows the next question once this one is filled in correctly. */
  const next = () => {
    const invalid = page()?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:invalid, textarea:invalid");
    if (invalid) invalid.reportValidity();
    else go(step + 1);
  };

  // Enter in a field, or the main button: the next question, then send.
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (paged && step < last) next();
    else finish();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (done || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish();
    } else if (e.key === "Enter" && target instanceof HTMLTextAreaElement && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      // A digit picks an option of the field the focus is in, else of the first one with options on screen.
      const shown = paged ? steps[step]! : fields;
      const key = target.closest<HTMLElement>("[data-field]")?.dataset["field"];
      const field = shown.find((f) => f.key === key && f.kind === "choice") ?? shown.find((f) => f.kind === "choice");
      const choice = field?.kind === "choice" ? field.choices[Number(e.key) - 1] : undefined;
      if (field?.kind === "choice" && choice) {
        e.preventDefault();
        pick(field, choice.value);
        form.current
          ?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field.key)}"] [data-index="${Number(e.key) - 1}"]`)
          ?.focus();
      }
    }
  };

  const outcome =
    item.outcome === "accept"
      ? "chat.elicitation.answered"
      : item.outcome === "decline"
        ? "chat.elicitation.declined"
        : "chat.elicitation.cancelled";

  return (
    <form ref={form} className={"elicitation" + (done ? " done" : "")} onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="elicitation-title">{t("chat.question")}</div>
      {item.message && <MarkdownView className="md elicitation-message" text={item.message} onOpenFile={openFile} />}
      {paged && (
        <div className="elicitation-steps" role="tablist" aria-label={t("chat.question")}>
          {steps.map((fs, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === step}
              className={
                "elicitation-step" + (i === step ? " current" : "") + (answered(fs) && stepOk(fs) ? " answered" : "")
              }
              title={labelOf(fs[0]!)}
              onClick={() => go(i)}
            >
              <span className="elicitation-step-number">{i + 1}</span>
              <span className="elicitation-step-label">{labelOf(fs[0]!)}</span>
            </button>
          ))}
        </div>
      )}
      <fieldset disabled={done}>
        {steps.map((fs, i) => (
          <div key={i} className="elicitation-page" data-step={i} hidden={paged && i !== step}>
            {fs.map((field) => (
              <FieldView
                key={field.key}
                field={field}
                value={draft[field.key]}
                done={done}
                onPick={pick}
                onChange={set}
              />
            ))}
          </div>
        ))}
      </fieldset>
      {done ? (
        <div className="elicitation-outcome">{t(outcome)}</div>
      ) : (
        <div className="elicitation-actions">
          {paged && step > 0 && (
            <button type="button" className="secondary" onClick={() => go(step - 1)}>
              {t("chat.elicitation.back")}
            </button>
          )}
          <button type="submit" disabled={!paged && !complete}>
            {t(paged && step < last ? "chat.elicitation.next" : "chat.elicitation.submit")}
          </button>
          <button type="button" className="secondary" onClick={() => answer({ action: "decline" })}>
            {t("chat.elicitation.decline")}
          </button>
          <span className="elicitation-hint">
            {fields.some((f) => f.kind === "choice")
              ? t("chat.elicitation.hint", "1–9", isMac ? "⌘Enter" : "Ctrl+Enter")
              : null}
          </span>
        </div>
      )}
    </form>
  );
});

function FieldView({
  field,
  value,
  done,
  onPick,
  onChange,
}: {
  field: Field;
  value: Draft[string];
  /** The form is answered: only what was picked or typed is shown. */
  done: boolean;
  onPick: (field: Field & { kind: "choice" }, value: string) => void;
  onChange: (key: string, value: Draft[string]) => void;
}) {
  const { t } = useL10n();
  const label = field.title ?? (field.kind === "text" || field.kind === "number" ? undefined : field.description);
  const required = field.required && (
    <span className="elicitation-required" title={t("chat.elicitation.required")}>
      {" "}
      *
    </span>
  );
  switch (field.kind) {
    case "choice": {
      const chosen = (v: string) => (field.multiple ? Array.isArray(value) && value.includes(v) : value === v);
      const choices = field.choices
        .map((choice, i) => ({ choice, i }))
        .filter(({ choice }) => !done || chosen(choice.value));
      return (
        <div
          className="elicitation-field"
          data-field={field.key}
          role={field.multiple ? "group" : "radiogroup"}
          aria-label={label}
        >
          {label && (
            <div className="elicitation-label">
              {label}
              {required}
            </div>
          )}
          {!done && field.title && field.description && (
            <div className="elicitation-description">{field.description}</div>
          )}
          <div className="elicitation-options">
            {choices.map(({ choice, i }) => (
              <button
                key={choice.value}
                type="button"
                data-index={i}
                role={field.multiple ? "checkbox" : "radio"}
                aria-checked={chosen(choice.value)}
                className={
                  "elicitation-option" + (chosen(choice.value) ? " chosen" : "") + (field.multiple ? " multiple" : "")
                }
                onClick={() => onPick(field, choice.value)}
              >
                <span className="elicitation-key">{i < 9 ? i + 1 : ""}</span>
                <span className="elicitation-option-text">
                  <span className="elicitation-option-title">{choice.title}</span>
                  {choice.description && <span className="elicitation-option-description">{choice.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    case "boolean":
      return (
        <label className="elicitation-field elicitation-check" data-field={field.key}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(field.key, e.target.checked)} />
          <span>
            {label ?? field.key}
            {required}
          </span>
        </label>
      );
    case "number":
    case "text": {
      if (done && (typeof value !== "string" || value.trim() === "")) return null;
      const common = {
        className: "elicitation-input",
        value: typeof value === "string" ? value : "",
        required: field.required,
        placeholder: field.description,
        "aria-label": field.title ?? field.description ?? field.key,
      };
      const input =
        field.kind === "number" ? (
          <input
            {...common}
            type="number"
            step={field.integer ? 1 : "any"}
            min={field.minimum}
            max={field.maximum}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : field.format ? (
          <input
            {...common}
            type={{ email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[field.format]}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : field.pattern ? (
          // Only an input checks a pattern.
          <input
            {...common}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        ) : (
          <textarea
            {...common}
            rows={1}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        );
      return (
        <div className="elicitation-field" data-field={field.key}>
          {field.title && (
            <div className="elicitation-label">
              {field.title}
              {required}
            </div>
          )}
          {input}
        </div>
      );
    }
  }
}
