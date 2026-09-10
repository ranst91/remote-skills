const NEVER_SNAPSHOT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

export interface SanitizedRequest {
  method: "GET";
  url: string;
  headers: Readonly<Record<string, string>>;
  sensitive_header_names: readonly string[];
}

export function sanitizeUrl(url: URL): string {
  const sanitized = new URL(url.href);
  sanitized.username = "";
  sanitized.password = "";
  sanitized.search = "";
  sanitized.hash = "";
  return sanitized.href;
}

export function sanitizeRequest(
  url: URL,
  headers: Readonly<Record<string, string>>,
  configuredSensitiveHeaderNames: readonly string[] = [],
): SanitizedRequest {
  const sensitive = new Set([
    ...NEVER_SNAPSHOT_HEADERS,
    ...configuredSensitiveHeaderNames.map((name) => name.toLowerCase()),
  ]);
  const visibleHeaders: Record<string, string> = {};
  const presentSensitive: string[] = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (sensitive.has(name)) presentSensitive.push(name);
    else visibleHeaders[name] = value;
  }
  return {
    method: "GET",
    url: sanitizeUrl(url),
    headers: visibleHeaders,
    sensitive_header_names: presentSensitive.sort(),
  };
}
