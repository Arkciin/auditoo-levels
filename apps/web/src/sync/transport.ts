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
  /**
   * Timeout of the first request after the server has been silent for `idleMs`: time for a
   * sleeping server to wake up (see `createHttpTransport`).
   * @defaultValue 60 000 ms
   */
  readonly wakeTimeoutMs?: number;
  /**
   * Silence (no answer from the server) after which it may have fallen asleep.
   * @defaultValue 10 minutes
   */
  readonly idleMs?: number;
  /**
   * Clock measuring that silence.
   * @defaultValue `Date.now`
   */
  readonly now?: () => number;
}

/**
 * Transport over HTTP: JSON `POST /api/push` and `POST /api/pull`, responses validated.
 *
 * The first request after a silence gets a longer timeout. Render's free instance sleeps after 15
 * idle minutes, and a request then waits, held by the platform, while it wakes: up to a minute.
 * With 15 s, every cold start (the app opened in the morning, or back from the background) would
 * time out a few times and say « Serveur injoignable » for most of that minute, although nothing
 * is wrong and the request is already queued at the server. So the first request after a silence
 * long enough for the server to have fallen asleep gets a minute; if even that times out, the
 * trouble is real and the next requests are back to 15 s. The price: a network that really hangs
 * is reported after a minute instead of 15 s, once per silence. Nothing waits on it meanwhile
 * (the app works from the device's data), only the indicator is late.
 */
export function createHttpTransport({
  baseUrl = "",
  // Kept in a local binding and called as a plain function: browsers throw "Illegal invocation"
  // when `fetch` is called as a method of another object.
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  wakeTimeoutMs = 60_000,
  // Below Render's 15 minutes: the device only knows its own silence, not the server's (other
  // devices may have kept it awake: the request is then simply quick).
  idleMs = 10 * 60_000,
  now = Date.now,
}: HttpTransportOptions = {}): Transport {
  /** When the server last answered, whatever it said: it was awake then. */
  let lastAnswerAt: number | undefined;
  /** A request given the wake-up timeout timed out since that answer: one minute is enough. */
  let wakeUpFailed = false;

  async function post<T>(
    path: string,
    body: unknown,
    parse: (data: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const mayBeAsleep = lastAnswerAt === undefined || now() - lastAnswerAt >= idleMs;
    const wakingUp = mayBeAsleep && !wakeUpFailed;
    const timeout = wakingUp ? wakeTimeoutMs : timeoutMs;
    // Our own controller combines the caller's signal with the timeout (`AbortSignal.any` and
    // `AbortSignal.timeout` are missing from the older Safari versions still found on tablets).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    const networkError = (error: unknown): unknown => {
      // A cancellation requested by the caller is not a connectivity problem: let it through.
      if (signal?.aborted) return error;
      const message = controller.signal.aborted
        ? `${path} timed out after ${timeout} ms`
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
        if (wakingUp && controller.signal.aborted && !signal?.aborted) wakeUpFailed = true;
        throw networkError(error);
      }
      lastAnswerAt = now();
      wakeUpFailed = false;
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
