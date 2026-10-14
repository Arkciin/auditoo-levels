import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type MutationArgs, mutationNames } from "./mutators";
import {
  clientTag,
  MAX_MUTATIONS_PER_PUSH,
  type Mutation,
  type MutationEnvelope,
  mutationSchema,
  type PushRequest,
  type PushResponse,
  pushRequestSchema,
  pushResponseSchema,
  type ReceivedPushRequest,
} from "./protocol";
import { idSchema } from "./schemas";

const CLIENT = "0199f0a0-0000-7000-8000-0000000000a1";
const PROPERTY = "0199f0a0-0000-7000-8000-000000000001";

const valid: MutationEnvelope = {
  id: 1,
  name: "createProperty",
  args: { id: PROPERTY, name: "Maison" },
  timestamp: 1_000,
};
const invalidArgs: MutationEnvelope = {
  id: 2,
  name: "renameProperty",
  args: { id: PROPERTY, name: "" },
  timestamp: 1_000,
};
const unknownName: MutationEnvelope = { id: 3, name: "paintWalls", args: {}, timestamp: 1_000 };

describe("pushRequestSchema", () => {
  it("accepts a push whose mutations are invalid inside well-formed envelopes", () => {
    const request = pushRequestSchema.parse({
      clientId: CLIENT,
      mutations: [valid, invalidArgs, unknownName, { ...valid, id: 4, args: null }],
    });

    // Validation happens per mutation, on the server: one bad mutation cannot fail the others.
    const verdicts = request.mutations.map(
      (mutation) => mutationSchema.safeParse(mutation).success,
    );
    expect(verdicts).toEqual([true, false, false, false]);
  });

  it.each([
    ["an id that is not positive", { ...valid, id: 0 }],
    ["a fractional id", { ...valid, id: 1.5 }],
    ["a missing name", { id: 1, args: {}, timestamp: 1_000 }],
    [
      "missing args (any value is fine, even null, but the key must be there)",
      { id: 1, name: "createProperty", timestamp: 1_000 },
    ],
    ["a negative timestamp", { ...valid, timestamp: -1 }],
  ])("still refuses an envelope with %s", (_, mutation) => {
    expect(pushRequestSchema.safeParse({ clientId: CLIENT, mutations: [mutation] }).success).toBe(
      false,
    );
  });

  it(`still caps a push at ${MAX_MUTATIONS_PER_PUSH} mutations`, () => {
    const mutations = Array.from({ length: MAX_MUTATIONS_PER_PUSH + 1 }, (_, i) => ({
      ...valid,
      id: i + 1,
    }));
    expect(pushRequestSchema.safeParse({ clientId: CLIENT, mutations }).success).toBe(false);
  });

  it("is a superset of what devices send", () => {
    const sent: PushRequest = { clientId: CLIENT, mutations: [mutationSchema.parse(valid)] };
    const received: ReceivedPushRequest = sent; // Type-level: a device's push is always accepted.
    expect(pushRequestSchema.parse(received)).toEqual(sent);
  });
});

describe("mutationSchema", () => {
  it("has one envelope per mutation, discriminated by name", () => {
    expect(mutationSchema.options.map((option) => option.shape.name.value)).toEqual(mutationNames);
    // Type-level: each name still narrows the arguments.
    expectTypeOf<Extract<Mutation, { name: "moveSpace" }>["args"]>().toEqualTypeOf<
      MutationArgs<"moveSpace">
    >();
    expectTypeOf<Mutation["name"]>().toEqualTypeOf<(typeof mutationNames)[number]>();
  });
});

describe("clientTag", () => {
  it("is the start of the client id's SHA-256: the same on every runtime, one-way", async () => {
    // sha256("0199f0a0-0000-7000-8000-0000000000a1"), first 16 bytes.
    expect(await clientTag(CLIENT)).toBe("6daa395c5c800d178a977ea580c5fc97");
    expect(await clientTag("0199f0a0-0000-7000-8000-0000000000a2")).not.toBe(
      await clientTag(CLIENT),
    );
  });
});

describe("pushResponseSchema", () => {
  const EPOCH = "0199f0a0-0000-7000-8000-0000000000e1";

  it("reports rejected mutations by id and reason, without user data", () => {
    const response: PushResponse = {
      lastMutationId: 3,
      epoch: EPOCH,
      rejected: [{ id: 2, reason: "not_applicable" }],
    };
    expect(pushResponseSchema.parse(response)).toEqual(response);
  });

  it("stays readable by installed apps, whose schema predates rejection reports", () => {
    // The push response schema of the versions already installed on devices.
    const installed = z.object({ lastMutationId: z.number().int().nonnegative(), epoch: idSchema });
    const response: PushResponse = {
      lastMutationId: 3,
      epoch: EPOCH,
      rejected: [{ id: 2, reason: "invalid" }],
    };
    expect(installed.parse(JSON.parse(JSON.stringify(response)))).toEqual({
      lastMutationId: 3,
      epoch: EPOCH,
    });
  });

  it("reads a response from a server older than rejection reports as rejecting nothing", () => {
    expect(pushResponseSchema.parse({ lastMutationId: 3, epoch: EPOCH })).toEqual({
      lastMutationId: 3,
      epoch: EPOCH,
      rejected: [],
    });
  });

  it("accepts reasons this version does not know, so that a newer server cannot block a device", () => {
    const parsed = pushResponseSchema.parse({
      lastMutationId: 3,
      epoch: EPOCH,
      rejected: [{ id: 3, reason: "forbidden", detail: "ignored" }],
    });
    expect(parsed.rejected).toEqual([{ id: 3, reason: "forbidden" }]);
  });

  it("still refuses a rejection without a usable mutation id", () => {
    const response = { lastMutationId: 3, epoch: EPOCH, rejected: [{ id: 0, reason: "invalid" }] };
    expect(pushResponseSchema.safeParse(response).success).toBe(false);
  });
});
