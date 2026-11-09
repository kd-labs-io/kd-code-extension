import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as net from "node:net";
import * as vscode from "vscode";
import { t } from "./i18n";
import { ExtensionCtx, messageOf, thenable, type VscodeError } from "./runtime";
import { readSettings, type TelemetrySettings } from "./settings";

export const DEFAULT_TELEMETRY_ENDPOINT = "http://localhost:4318";
export const DEFAULT_TELEMETRY_PROTOCOL = "http/protobuf";

/** Where the OTLP headers are kept: they often hold an API key, so they stay out of settings.json. */
const HEADERS_KEY = "kdCode.telemetry.headers";

/** The endpoint agents send to, without a trailing slash; undefined when it is no http(s) URL. */
export function telemetryEndpoint(settings: TelemetrySettings): string | undefined {
  const raw = settings.endpoint?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
  if (!URL.canParse(raw)) return undefined;
  const { protocol } = new URL(raw);
  return protocol === "http:" || protocol === "https:" ? raw.replace(/\/+$/, "") : undefined;
}

/** The headers of an OTEL_EXPORTER_OTLP_HEADERS value ("name=value,name2=value2"), decoded; undefined when malformed. */
export function parseOtlpHeaders(value: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const part of value.split(",")) {
    if (!part.trim()) continue;
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    if (at <= 0 || !name || !raw) return undefined;
    try {
      headers[name] = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return headers;
}

/**
 * Variables that make an agent export OpenTelemetry to the endpoint of `settings`: the standard OTEL_* ones,
 * and Claude Code's own switches. Empty while telemetry is off or its endpoint is invalid.
 */
export function telemetryEnv(settings: TelemetrySettings, headers: string, agentId: string): Record<string, string> {
  const endpoint = settings.enabled ? telemetryEndpoint(settings) : undefined;
  if (!endpoint) return {};
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: settings.protocol ?? DEFAULT_TELEMETRY_PROTOCOL,
    ...(headers ? { OTEL_EXPORTER_OTLP_HEADERS: headers } : {}),
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    // Tells the agents apart in the backend.
    OTEL_RESOURCE_ATTRIBUTES: `kd.agent.id=${encodeURIComponent(agentId)}`,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    ...(settings.logPrompts ? { OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1" } : {}),
    ...(settings.logToolDetails ? { OTEL_LOG_TOOL_DETAILS: "1" } : {}),
  };
}

/** What the connection check found, said for the user. */
export interface TelemetryCheck {
  readonly ok: boolean;
  readonly message: string;
}

const CHECK_TIMEOUT = "5 seconds";

/** Whether a TCP connection to `url` opens: all there is to check of a gRPC endpoint without a gRPC client. */
const tcpConnect = (url: URL) =>
  Effect.callback<void, Error>((resume) => {
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.void);
    });
    socket.once("error", (err) => resume(Effect.fail(err)));
    return Effect.sync(() => socket.destroy());
  });

/** Where agents send OpenTelemetry, from kdCode.telemetry and the headers kept in the secret storage. */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    /** Fires when the saved headers change. */
    readonly onDidChange: vscode.Event<void>;
    /** Variables for agent `agentId` to send its telemetry; empty while telemetry is off. */
    env(agentId: string): Record<string, string>;
    /** Names of the saved headers, without their values. */
    readonly headerNames: Effect.Effect<ReadonlyArray<string>>;
    /** Saves the headers, an OTEL_EXPORTER_OTLP_HEADERS value; empty removes them. */
    setHeaders(value: string): Effect.Effect<void, VscodeError>;
    /** Sends an empty export to the endpoint, or opens a connection to it for gRPC. */
    readonly check: Effect.Effect<TelemetryCheck>;
  }
>()("kd-code/Telemetry") {
  static readonly layer = Layer.effect(
    Telemetry,
    Effect.gen(function* () {
      const secrets = (yield* ExtensionCtx).secrets;
      const http = yield* HttpClient.HttpClient;
      const changed = yield* Effect.acquireRelease(
        Effect.sync(() => new vscode.EventEmitter<void>()),
        (emitter) => Effect.sync(() => emitter.dispose()),
      );
      // Kept in memory: commands for agents are built synchronously.
      let headers = "";
      const load = thenable(() => secrets.get(HEADERS_KEY)).pipe(
        Effect.map((value) => (headers = value ?? "")),
        Effect.catch((err) => Effect.logWarning(`[telemetry] headers not read: ${err.message}`)),
      );
      yield* load;
      // Another window of VS Code can change them.
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          secrets.onDidChange((e) => {
            if (e.key === HEADERS_KEY) void Effect.runPromiseWith(services)(load).then(() => changed.fire());
          }),
        ),
        (listener) => Effect.sync(() => listener.dispose()),
      );

      const check = Effect.gen(function* () {
        const settings = readSettings().telemetry;
        const endpoint = telemetryEndpoint(settings);
        if (!endpoint) return { ok: false, message: t("telemetry.checkInvalidEndpoint") };
        const failed = (err: unknown) => ({ ok: false, message: t("telemetry.checkFailed", endpoint, messageOf(err)) });
        if (settings.protocol === "grpc") {
          return yield* tcpConnect(new URL(endpoint)).pipe(
            Effect.timeout(CHECK_TIMEOUT),
            Effect.as({ ok: true, message: t("telemetry.checkReachable", endpoint) }),
            Effect.catch((err) => Effect.succeed(failed(err))),
          );
        }
        // OTLP/HTTP receivers take JSON whatever protocol the agents use; an empty batch stores nothing.
        const request = HttpClientRequest.post(`${endpoint}/v1/logs`).pipe(
          HttpClientRequest.setHeaders(parseOtlpHeaders(headers) ?? {}),
          HttpClientRequest.bodyText(JSON.stringify({ resourceLogs: [] }), "application/json"),
        );
        return yield* http.execute(request).pipe(
          Effect.timeout(CHECK_TIMEOUT),
          Effect.map((res) =>
            res.status >= 200 && res.status < 300
              ? { ok: true, message: t("telemetry.checkOk", endpoint) }
              : { ok: false, message: t("telemetry.checkStatus", endpoint, res.status) },
          ),
          Effect.catch((err) => Effect.succeed(failed(err))),
        );
      });

      return Telemetry.of({
        onDidChange: changed.event,
        env: (agentId) => telemetryEnv(readSettings().telemetry, headers, agentId),
        headerNames: Effect.sync(() => Object.keys(parseOtlpHeaders(headers) ?? {})),
        setHeaders: (value) =>
          Effect.gen(function* () {
            const trimmed = value.trim();
            yield* trimmed
              ? thenable(() => secrets.store(HEADERS_KEY, trimmed))
              : thenable(() => secrets.delete(HEADERS_KEY));
            headers = trimmed;
            changed.fire();
          }),
        check: check.pipe(Effect.withSpan("Telemetry.check")),
      });
    }),
  );
}
