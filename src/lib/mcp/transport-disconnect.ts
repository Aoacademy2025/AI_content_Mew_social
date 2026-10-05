/**
 * transport-disconnect.ts — an MCP client hanging up mid-request is not a server error (HERO-70).
 *
 * mcp-handler 1.1.0 runs every request in a detached promise (`void fn(res)` in its
 * createServerResponseAdapter), so nothing awaits it and two ordinary client disconnects became
 * `unhandledRejection` in the web process (Sentry WEB-J and WEB-1E, 2026-10-04/05, while slow
 * SQLite transactions kept MCP calls open for 20-40 s):
 *
 *  1. Request side — the client leaves while its body is still arriving. The handler's own
 *     `req.json()` rejects with `Error: aborted` (ECONNRESET). Fix: read the body here first,
 *     through a clone (the request object, its `auth` and its signal stay exactly the same;
 *     the original keeps the buffered bytes for the handler). A disconnect ends the request
 *     with a quiet 499 before the handler starts; any other read error is rethrown.
 *
 *  2. Response side — the client leaves while a tool is still running. Next cancels the response
 *     stream, and the handler's next `res.write` throws `Invalid state: Controller is already
 *     closed`. Fix: hand Next a pass-through stream. When Next cancels it, the handler's own
 *     stream is NOT cancelled but drained in the background, so the handler finishes writing
 *     into a stream that is still open. The tool's work runs to completion either way — exactly
 *     as before; only the bytes nobody can receive are dropped.
 *
 * Only the disconnect class is swallowed. A handler exception, a non-disconnect body error, or a
 * handler stream that errors while the client is still connected surfaces exactly as before.
 * Same pattern as mediaWebStream's cancel handling (HERO-7), except the source here must be
 * drained rather than destroyed, because its writer is code we do not own.
 *
 * Logs never include headers, bodies or tokens.
 */

/** Node and undici codes for a peer that went away. */
const DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ABORT_ERR",
  "UND_ERR_ABORTED",
  "UND_ERR_SOCKET",
]);

/** HTTP status nginx uses for "client closed request". Nobody receives it; it reads well in logs. */
const CLIENT_CLOSED_REQUEST = 499;

function looksLikeDisconnect(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof code === "string" && DISCONNECT_CODES.has(code)) return true;
  if (name === "AbortError") return true;
  // Node's IncomingMessage raises `new Error("aborted")` (code ECONNRESET) on a dropped upload.
  return message === "aborted";
}

/**
 * True when `error` means the client is gone: the request's own signal has aborted, or the error
 * (or its direct cause — undici wraps socket errors) carries a peer-went-away code/name.
 */
export function isClientDisconnectError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (looksLikeDisconnect(error)) return true;
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  return looksLikeDisconnect(cause);
}

function detachOnCancel(inner: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = inner.getReader();
  let cancelled = false;

  async function drain(): Promise<void> {
    while (!(await reader.read()).done) {
      // Discard: the client that would have received these bytes is gone.
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        const next = await reader.read();
        // The consumer may have cancelled while that read was in flight.
        if (cancelled) return;
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (cancelled) return;
        // The handler's stream failed while the client was still here: surface it unchanged.
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      console.warn("[mcp-transport] client disconnected before the response finished; draining it");
      void drain().catch((error: unknown) => {
        if (isClientDisconnectError(error)) return;
        // Not a disconnect: let it surface as an unhandled rejection, as it did before this guard.
        throw error;
      });
    },
  });
}

/**
 * Wraps an MCP route handler so a client disconnect cannot leave an unhandled rejection behind.
 * Place it INSIDE withMcpAuth: an unauthenticated request must still be refused without its body
 * ever being read.
 */
export function withClientDisconnectGuard(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.body) {
      try {
        await req.clone().arrayBuffer();
      } catch (error) {
        if (!isClientDisconnectError(error, req.signal)) throw error;
        console.warn("[mcp-transport] client disconnected before its request body arrived");
        return new Response(null, { status: CLIENT_CLOSED_REQUEST });
      }
    }
    const response = await handler(req);
    if (!response.body) return response;
    return new Response(detachOnCancel(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
