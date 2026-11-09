import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type * as vscode from "vscode";
import { ExtensionCtx } from "../src/runtime";
import { isValidSetting } from "../src/settings";
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  parseOtlpHeaders,
  Telemetry,
  telemetryEndpoint,
  telemetryEnv,
} from "../src/telemetry";
import { DEFAULT_ENDPOINT, isEndpoint } from "../src/ui/settings/telemetry";
import { makeSecrets } from "./helpers";
import { __test } from "./stubs/vscode";

beforeEach(() => __test.reset());

describe("telemetryEnv", () => {
  it("sets nothing while telemetry is off", () => {
    assert.deepStrictEqual(telemetryEnv({}, "authorization=key", "claude"), {});
    assert.deepStrictEqual(telemetryEnv({ enabled: false, endpoint: "http://x:4318" }, "", "claude"), {});
  });

  it("points every signal at the default endpoint, and tells agents apart", () => {
    assert.deepStrictEqual(telemetryEnv({ enabled: true }, "", "custom:my agent"), {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_RESOURCE_ATTRIBUTES: "kd.agent.id=custom%3Amy%20agent",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    });
  });

  it("adds the headers, the protocol and the content options", () => {
    const env = telemetryEnv(
      {
        enabled: true,
        endpoint: " https://otel.example.com/ ",
        protocol: "grpc",
        logPrompts: true,
        logToolDetails: true,
      },
      "authorization=key",
      "claude",
    );
    assert.strictEqual(env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://otel.example.com");
    assert.strictEqual(env.OTEL_EXPORTER_OTLP_PROTOCOL, "grpc");
    assert.strictEqual(env.OTEL_EXPORTER_OTLP_HEADERS, "authorization=key");
    assert.strictEqual(env.OTEL_LOG_USER_PROMPTS, "1");
    assert.strictEqual(env.OTEL_LOG_ASSISTANT_RESPONSES, "1");
    assert.strictEqual(env.OTEL_LOG_TOOL_DETAILS, "1");
  });

  it("sets nothing for an endpoint that is no http(s) URL", () => {
    for (const endpoint of ["localhost:4318", "ftp://x", "file:///tmp/otel"]) {
      assert.isUndefined(telemetryEndpoint({ endpoint }), endpoint);
      assert.deepStrictEqual(telemetryEnv({ enabled: true, endpoint }, "", "claude"), {}, endpoint);
    }
  });

  it("has the same default endpoint, and the same idea of a valid one, as the Settings page", () => {
    assert.strictEqual(DEFAULT_ENDPOINT, DEFAULT_TELEMETRY_ENDPOINT);
    for (const endpoint of ["http://localhost:4318", "https://otel.example.com/x", "localhost:4318", "ftp://x"]) {
      assert.strictEqual(isEndpoint(endpoint), telemetryEndpoint({ endpoint }) !== undefined, endpoint);
    }
  });

  it("is a setting with a known protocol only", () => {
    assert.isTrue(isValidSetting("telemetry", { enabled: true, protocol: "http/json" }));
    assert.isFalse(isValidSetting("telemetry", { protocol: "udp" }));
    assert.isFalse(isValidSetting("telemetry", { enabled: "yes" }));
  });
});

describe("parseOtlpHeaders", () => {
  it("reads name=value pairs, decoding their values", () => {
    assert.deepStrictEqual(parseOtlpHeaders(" authorization=Bearer%20abc , x-team=a=b ,"), {
      authorization: "Bearer abc",
      "x-team": "a=b",
    });
    assert.deepStrictEqual(parseOtlpHeaders(""), {});
  });

  it("rejects pairs without a name or a value", () => {
    for (const value of ["authorization", "=key", "authorization=", "a=%E0%A4%A"]) {
      assert.isUndefined(parseOtlpHeaders(value), value);
    }
  });
});

/** The Telemetry service over in-memory secrets, with a real HTTP client. */
const withTelemetry = <A, E>(
  body: (secrets: ReturnType<typeof makeSecrets>) => Effect.Effect<A, E, Telemetry>,
  initial: Record<string, string> = {},
) => {
  const secrets = makeSecrets(initial);
  const ctx = { secrets } as unknown as vscode.ExtensionContext;
  return body(secrets).pipe(
    Effect.provide(
      Telemetry.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(ExtensionCtx, ctx), FetchHttpClient.layer))),
    ),
  );
};

/** A local server answering every request with `status`; gives the headers and body of the last one. */
const withServer = <A, E, R>(
  status: number,
  body: (
    url: string,
    last: { headers?: http.IncomingHttpHeaders; path?: string; body?: string },
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{
          server: http.Server;
          last: { headers?: http.IncomingHttpHeaders; path?: string; body?: string };
        }>((resolve) => {
          const last: { headers?: http.IncomingHttpHeaders; path?: string; body?: string } = {};
          const server = http.createServer((req, res) => {
            let text = "";
            req.on("data", (chunk) => (text += chunk));
            req.on("end", () => {
              Object.assign(last, { headers: req.headers, path: req.url, body: text });
              res.writeHead(status).end();
            });
          });
          server.listen(0, "127.0.0.1", () => resolve({ server, last }));
        }),
    ),
    ({ server, last }) => body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, last),
    ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

describe("Telemetry", () => {
  it.live("keeps the headers in the secret storage, and gives only their names", () =>
    withTelemetry((secrets) =>
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        assert.deepStrictEqual(yield* telemetry.headerNames, []);
        yield* telemetry.setHeaders(" authorization=key,x-team=a ");
        assert.strictEqual(secrets.values.get("kdCode.telemetry.headers"), "authorization=key,x-team=a");
        assert.deepStrictEqual(yield* telemetry.headerNames, ["authorization", "x-team"]);
        __test.setSetting("kdCode.telemetry", { enabled: true });
        assert.strictEqual(telemetry.env("claude").OTEL_EXPORTER_OTLP_HEADERS, "authorization=key,x-team=a");
        yield* telemetry.setHeaders("");
        assert.isFalse(secrets.values.has("kdCode.telemetry.headers"));
        assert.isUndefined(telemetry.env("claude").OTEL_EXPORTER_OTLP_HEADERS);
      }),
    ),
  );

  it.live("reads the headers saved before", () =>
    withTelemetry(
      () =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* Telemetry.use((telemetry) => telemetry.headerNames), ["authorization"]);
        }),
      { "kdCode.telemetry.headers": "authorization=key" },
    ),
  );

  it.live("checks an HTTP endpoint with an empty export and the saved headers", () =>
    withServer(200, (url, last) =>
      withTelemetry(
        () =>
          Effect.gen(function* () {
            __test.setSetting("kdCode.telemetry", { endpoint: url });
            const result = yield* Telemetry.use((telemetry) => telemetry.check);
            assert.isTrue(result.ok);
            assert.include(result.message, url);
            assert.strictEqual(last.path, "/v1/logs");
            assert.strictEqual(last.headers?.authorization, "Bearer abc");
            assert.deepStrictEqual(JSON.parse(last.body ?? ""), { resourceLogs: [] });
          }),
        { "kdCode.telemetry.headers": "authorization=Bearer%20abc" },
      ),
    ),
  );

  it.live("reports the status of an endpoint that refuses the export", () =>
    withServer(401, (url) =>
      withTelemetry(() =>
        Effect.gen(function* () {
          __test.setSetting("kdCode.telemetry", { endpoint: url });
          const result = yield* Telemetry.use((telemetry) => telemetry.check);
          assert.isFalse(result.ok);
          assert.include(result.message, "401");
        }),
      ),
    ),
  );

  it.live("checks that a gRPC endpoint accepts connections", () =>
    withServer(200, (url) =>
      withTelemetry(() =>
        Effect.gen(function* () {
          __test.setSetting("kdCode.telemetry", { endpoint: url, protocol: "grpc" });
          assert.isTrue((yield* Telemetry.use((telemetry) => telemetry.check)).ok);
        }),
      ),
    ),
  );

  it.live("fails the check of an invalid or unreachable endpoint", () =>
    withTelemetry(() =>
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        __test.setSetting("kdCode.telemetry", { endpoint: "localhost:4318" });
        assert.isFalse((yield* telemetry.check).ok);
        // Port 9 (discard) is closed on test machines.
        __test.setSetting("kdCode.telemetry", { endpoint: "http://127.0.0.1:9", protocol: "grpc" });
        assert.isFalse((yield* telemetry.check).ok);
      }),
    ),
  );
});
