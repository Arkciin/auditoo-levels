/**
 * Network layer of the sync engine: the push/pull endpoints, and typed errors that tell the
 * client what kind of failure happened (and therefore how to report it).
 */
import {
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  pullResponseSchema,
  pushResponseSchema,
} from "@repo/shared";

/** Options of a single request. */
export interface RequestOptions {
  /** Cancels the request; the client aborts in-flight requests when it is disposed. */
  readonly signal?: AbortSignal;
}

/** How the sync client talks to the server. Tests inject an in-memory implementation. */
export interface Transport {
  /** Sends mutations, oldest first. Resolves with the last mutation id the server processed. */
  push(request: PushRequest, options?: RequestOptions): Promise<PushResponse>;
  /** Fetches the rows changed since `request.cursor`. */
  pull(request: PullRequest, options?: RequestOptions): Promise<PullResponse>;
}

/** The server could not be reached (no connectivity, DNS failure, timeout…). */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
}

/** The server answered with a non-2xx status: 400 for an invalid request, 5xx when transient. */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

/** The server answered 2xx with a payload that does not follow the protocol. */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

/** Options of {@link createHttpTransport}. */
export interface HttpTransportOptions {
  /**
   * Prefix of the API URLs.
   * @defaultValue `""` (same origin)
   */
  readonly baseUrl?: string;
  /**
   * Fetch implementation.
   * @defaultValue `globalThis.fetch`
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Time after which a request (body included) is abandoned and reported as a `NetworkError`.
   * Weak mobile connections tend to hang rather than fail, so this bounds every attempt.
   * @defaultValue 15 000 ms
   */
  readonly timeoutMs?: number;
}

/** Transport over HTTP: JSON `POST /api/push` and `POST /api/pull`, responses validated. */
export function createHttpTransport({
  baseUrl = "",
  // Kept in a local binding and called as a plain function: browsers throw "Illegal invocation"
  // when `fetch` is called as a method of another object.
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}: HttpTransportOptions = {}): Transport {
  async function post<T>(
    path: string,
    body: unknown,
    parse: (data: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    // Our own controller combines the caller's signal with the timeout (`AbortSignal.any` and
    // `AbortSignal.timeout` are missing from the older Safari versions still found on tablets).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    const networkError = (error: unknown): unknown => {
      // A cancellation requested by the caller is not a connectivity problem: let it through.
      if (signal?.aborted) return error;
      const message = controller.signal.aborted
        ? `${path} timed out after ${timeoutMs} ms`
        : `${path} could not reach the server`;
      return new NetworkError(message, { cause: error });
    };

    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw networkError(error);
      }
      if (!response.ok) {
        throw new HttpError(response.status, `${path} answered ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        // A body that is not JSON is the server's fault; a body cut short is the network's.
        if (error instanceof SyntaxError) {
          throw new ProtocolError(`${path} answered invalid JSON`, { cause: error });
        }
        throw networkError(error);
      }
      try {
        return parse(data);
      } catch (error) {
        throw new ProtocolError(`${path} answered an unexpected payload`, { cause: error });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return {
    push: (request, options) =>
      post("/api/push", request, (data) => pushResponseSchema.parse(data), options?.signal),
    pull: (request, options) =>
      post("/api/pull", request, (data) => pullResponseSchema.parse(data), options?.signal),
  };
}
