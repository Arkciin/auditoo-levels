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
    const fetchMock = answering(JSON.stringify({ lastMutationId: 4, epoch: EPOCH }));
    const transport = createHttpTransport({ fetch: fetchMock });

    await expect(transport.push({ clientId: CLIENT, mutations: [] })).resolves.toEqual({
      lastMutationId: 4,
      epoch: EPOCH,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/push", expect.anything());
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
    const transport = createHttpTransport({ fetch: hanging, timeoutMs: 10 });

    await expect(transport.pull({ clientId: CLIENT, cursor: 0 })).rejects.toThrow(
      new NetworkError("/api/pull timed out after 10 ms"),
    );
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
