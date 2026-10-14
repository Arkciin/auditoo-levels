import type { PullResponse } from "@repo/shared";
import { describe, expect, it, vi } from "vitest";
import { uuid } from "./test-support/fixtures";
import { createHttpTransport, HttpError, NetworkError, ProtocolError } from "./transport";

const CLIENT = uuid(1);
const EPOCH = uuid(900);
const PULLED: PullResponse = {
  epoch: EPOCH,
  cursor: 3,
  lastMutationId: 2,
  reset: false,
  changes: {
    properties: [{ id: uuid(2), name: "Maison", createdAt: 1, deletedAt: null }],
    levels: [],
    spaces: [],
  },
};

function answering(body: string, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

/** A fetch that never answers, but honours its abort signal like the real one. */
const hanging = vi.fn<typeof fetch>(
  (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }),
);

describe("createHttpTransport", () => {
  it("POSTs JSON to the API and returns the validated response", async () => {
    const fetchMock = answering(JSON.stringify(PULLED));
    const transport = createHttpTransport({ baseUrl: "https://releve.example", fetch: fetchMock });

    const response = await transport.pull({ clientId: CLIENT, cursor: 1 });

    expect(response).toEqual(PULLED);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://releve.example/api/pull",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: CLIENT, cursor: 1 }),
      }),
    );
  });

  it("pushes to /api/push", async () => {
    const answer = { lastMutationId: 4, epoch: EPOCH, rejected: [{ id: 3, reason: "invalid" }] };
    const fetchMock = answering(JSON.stringify(answer));
    const transport = createHttpTransport({ fetch: fetchMock });

    await expect(transport.push({ clientId: CLIENT, mutations: [] })).resolves.toEqual(answer);
    expect(fetchMock).toHaveBeenCalledWith("/api/push", expect.anything());
  });

  it("reads the push answer of a server older than rejection reports", async () => {
    const transport = createHttpTransport({
      fetch: answering(JSON.stringify({ lastMutationId: 4, epoch: EPOCH })),
    });

    await expect(transport.push({ clientId: CLIENT, mutations: [] })).resolves.toEqual({
      lastMutationId: 4,
      epoch: EPOCH,
      rejected: [],
    });
  });

  it("reports a failed request as a NetworkError", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const transport = createHttpTransport({ fetch: offline });

    await expect(transport.pull({ clientId: CLIENT, cursor: 0 })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("gives up after the timeout with a NetworkError", async () => {
    const transport = createHttpTransport({ fetch: hanging, timeoutMs: 10, wakeTimeoutMs: 10 });

    await expect(transport.pull({ clientId: CLIENT, cursor: 0 })).rejects.toThrow(
      new NetworkError("/api/pull timed out after 10 ms"),
    );
  });

  it("waits longer for a server that may be asleep, once per silence", async () => {
    let clock = 0;
    let status: number | undefined; // the server's answer, or none: the request hangs
    const fetchMock = vi.fn<typeof fetch>((input, init) =>
      status === undefined
        ? hanging(input, init)
        : Promise.resolve(new Response(JSON.stringify(PULLED), { status })),
    );
    const transport = createHttpTransport({
      fetch: fetchMock,
      timeoutMs: 10,
      wakeTimeoutMs: 40,
      idleMs: 60_000,
      now: () => clock,
    });
    const pull = () => transport.pull({ clientId: CLIENT, cursor: 0 });
    const timedOut = (ms: number) => new NetworkError(`/api/pull timed out after ${ms} ms`);

    // Never heard from (the app just started): it may be waking up, which takes long.
    await expect(pull()).rejects.toThrow(timedOut(40));
    // Even that was not enough: the trouble is real, back to the usual timeout.
    await expect(pull()).rejects.toThrow(timedOut(10));

    // Any answer, an error status too, says the server is awake.
    status = 503;
    await expect(pull()).rejects.toBeInstanceOf(HttpError);
    status = undefined;
    clock += 59_999;
    await expect(pull()).rejects.toThrow(timedOut(10));
    // A minute without an answer: it may have fallen asleep again.
    clock += 1;
    await expect(pull()).rejects.toThrow(timedOut(40));
  });

  it("reports a non-2xx answer as an HttpError with its status", async () => {
    for (const status of [400, 503]) {
      const transport = createHttpTransport({ fetch: answering("Oops", status) });
      const failure = transport.pull({ clientId: CLIENT, cursor: 0 });
      await expect(failure).rejects.toBeInstanceOf(HttpError);
      await expect(failure).rejects.toMatchObject({ status });
    }
  });

  it("reports a payload outside the protocol as a ProtocolError", async () => {
    for (const body of ["<html>Portail captif</html>", JSON.stringify({ cursor: -1 })]) {
      const transport = createHttpTransport({ fetch: answering(body) });
      await expect(transport.pull({ clientId: CLIENT, cursor: 0 })).rejects.toBeInstanceOf(
        ProtocolError,
      );
    }
  });

  it("lets a cancellation through as is", async () => {
    const transport = createHttpTransport({ fetch: hanging });
    const controller = new AbortController();

    const request = transport.pull({ clientId: CLIENT, cursor: 0 }, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
