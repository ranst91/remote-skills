/** Browser request policy for the loopback-only development demo, not authentication. */
export function rejectChatRequest(
  request: Request,
  mode: string | undefined,
): Response | undefined {
  const deny = () => new Response("Chat is available only in local development", { status: 403 });
  if (mode !== "development") return deny();

  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!host) return deny();
  let authority: URL;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    return deny();
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"];
  if (
    url.protocol !== "http:" ||
    !loopback.includes(url.hostname) ||
    !loopback.includes(authority.hostname) ||
    authority.host !== host ||
    url.port !== authority.port ||
    // NextRequest normalizes loopback URL hostnames to localhost. Host retains
    // the browser authority, so Origin must match that exact hostname and port.
    (url.hostname !== authority.hostname && url.hostname !== "localhost") ||
    request.headers.get("origin") !== authority.origin
  )
    return deny();

  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return deny();
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return new Response("Expected application/json", { status: 415 });
  return undefined;
}
