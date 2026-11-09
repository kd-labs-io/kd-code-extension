/** Same as DEFAULT_TELEMETRY_ENDPOINT of telemetry.ts, which a webview can't import. */
export const DEFAULT_ENDPOINT = "http://localhost:4318";

export const TELEMETRY_PROTOCOLS = ["http/protobuf", "http/json", "grpc"] as const;

/** Whether `text` is an endpoint agents can send to: empty (the default one) or an http(s) URL. */
export function isEndpoint(text: string): boolean {
  if (!text) return true;
  if (!URL.canParse(text)) return false;
  const { protocol } = new URL(text);
  return protocol === "http:" || protocol === "https:";
}
