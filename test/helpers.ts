import type * as vscode from "vscode";
import { Layer } from "effect";
import { AcpTrace } from "../src/acpTrace";
import { ExtensionCtx, Output } from "../src/runtime";

export interface OutputStub extends vscode.OutputChannel {
  readonly lines: Array<string>;
}

export const makeOutput = (): OutputStub => {
  const lines: Array<string> = [];
  return {
    lines,
    name: "test",
    append: (v: string) => void lines.push(v),
    appendLine: (v: string) => void lines.push(v),
    replace: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  } as OutputStub;
};

/** An in-memory `ExtensionContext.secrets`. */
export const makeSecrets = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    keys: async () => [...values.keys()],
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as vscode.SecretStorage & { readonly values: Map<string, string> };
};

export const makeExtensionCtx = (
  globalStorage = "/tmp/kd-code-test-storage",
  packageJSON: unknown = { version: "1.2.3" },
) =>
  ({
    extension: { packageJSON },
    globalStorageUri: { fsPath: globalStorage },
  }) as unknown as vscode.ExtensionContext;

export const stubLayer = (output: OutputStub, ctx = makeExtensionCtx()) =>
  Layer.mergeAll(Layer.succeed(Output, output), Layer.succeed(ExtensionCtx, ctx), AcpTrace.layer);
