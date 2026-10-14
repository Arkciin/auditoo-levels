import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SyncProvider, useMutate, useSyncClient, useSyncStatus, useView } from "./react";
import { selectProperties } from "./selectors";
import type { SyncClient } from "./sync-client";
import { MemoryServer, TestDevice, uuid } from "./test-support/harness";

let client: SyncClient | undefined;

afterEach(async () => {
  await client?.dispose();
  client = undefined;
});

function PropertyList() {
  const properties = useView(selectProperties);
  const { pendingCount } = useSyncStatus();
  return (
    <p>
      {`${properties.map(({ property }) => property.name).join(", ")} (${pendingCount} en attente)`}
    </p>
  );
}

describe("React bindings", () => {
  it("render the view and the status of the provided client", async () => {
    client = (await TestDevice.create(new MemoryServer())).client;
    await client.mutate("createProperty", { id: uuid(1), name: "Maison" });
    await client.mutate("createProperty", { id: uuid(2), name: "Appartement" });

    const html = renderToString(
      <SyncProvider client={client}>
        <PropertyList />
      </SyncProvider>,
    );

    expect(html).toContain("Appartement, Maison (2 en attente)");
  });

  it("expose the bound mutate function", async () => {
    client = (await TestDevice.create(new MemoryServer())).client;
    let mutate: SyncClient["mutate"] | undefined;
    function Probe() {
      mutate = useMutate();
      return null;
    }
    renderToString(
      <SyncProvider client={client}>
        <Probe />
      </SyncProvider>,
    );

    await mutate?.("createProperty", { id: uuid(1), name: "Maison" });

    expect(client.getState().view.properties.has(uuid(1))).toBe(true);
  });

  it("fail loudly outside a provider", () => {
    function Orphan() {
      useSyncClient();
      return null;
    }
    expect(() => renderToString(<Orphan />)).toThrow(/SyncProvider/);
  });
});
