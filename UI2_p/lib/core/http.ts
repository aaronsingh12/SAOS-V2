import "server-only";

export function assertLocalMutation(request: Request) {
  const url = new URL(request.url);
  const isLoopback = (host: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!isLoopback(url.hostname)) throw new Error("Local access only");
  const origin = request.headers.get("origin");
  if (origin) {
    let source: URL;
    try {
      source = new URL(origin);
    } catch {
      throw new Error("Cross-origin mutation blocked");
    }
    // Next can hand a route localhost while a browser sends 127.0.0.1.
    // They are the same device, but the protocol and port must still match.
    if (
      !isLoopback(source.hostname) ||
      source.protocol !== url.protocol ||
      source.port !== url.port ||
      source.username ||
      source.password ||
      source.pathname !== "/" ||
      source.search ||
      source.hash
    )
      throw new Error("Cross-origin mutation blocked");
  }
}

export function errorResponse(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Unexpected error" },
    { status: 400 },
  );
}
