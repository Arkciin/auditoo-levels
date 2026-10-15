import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncProvider, selectStructure } from "@/sync";
import type { SyncClient } from "@/sync/sync-client";
import { MemoryServer, TestDevice, uuid } from "@/sync/test-support/harness";
import { AddLevelDrawer } from "./add-level-drawer";

const PROPERTY = uuid(1);

let device: TestDevice;
let client: SyncClient;

beforeEach(async () => {
  device = await TestDevice.create(new MemoryServer());
  client = device.client;
  await client.mutate("createProperty", { id: PROPERTY, name: "Maison" });
  await client.mutate("createLevel", {
    id: uuid(2),
    propertyId: PROPERTY,
    name: "RDC",
    position: "a0",
  });
});

afterEach(async () => {
  await device.close();
});

/**
 * The sheet as the structure screen opens it. With `stayOpen`, it ignores requests to close: the
 * sheet as it is while it slides away, still on screen and tappable.
 */
function Sheet({ stayOpen = false }: { stayOpen?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <AddLevelDrawer
      propertyId={PROPERTY}
      open={open}
      onOpenChange={(next) => {
        if (!stayOpen) setOpen(next);
      }}
      onCreated={vi.fn()}
    />
  );
}

function renderSheet(props: { stayOpen?: boolean } = {}) {
  render(
    <SyncProvider client={client}>
      <Sheet {...props} />
    </SyncProvider>,
  );
  return screen.getByRole("dialog", { name: "Ajouter un niveau" });
}

const levelNames = () =>
  selectStructure(client.getState().view, PROPERTY).map((group) => group.level.name);

/** Lets every add the taps queued run to completion. */
async function settled() {
  await waitFor(() => expect(client.getState().pending.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("AddLevelDrawer", () => {
  it("adds one level on a double tap, while the first add is on its way", async () => {
    const sheet = renderSheet();
    const suggestion = within(sheet).getByRole("button", { name: "R+1" });

    fireEvent.click(suggestion);
    fireEvent.click(suggestion);
    await settled();

    expect(levelNames()).toEqual(["RDC", "R+1"]);
  });

  it("holds its suggestions still once a level is added, and ignores taps, while it slides away", async () => {
    const sheet = renderSheet({ stayOpen: true });
    const suggestion = within(sheet).getByRole("button", { name: "R+1" });

    fireEvent.click(suggestion);
    await waitFor(() => expect(levelNames()).toEqual(["RDC", "R+1"]));
    // R+1 stays under the finger, rather than turning into the next floor.
    expect(suggestion).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "R+2" })).toBeNull();
    fireEvent.click(suggestion);
    await settled();

    expect(levelNames()).toEqual(["RDC", "R+1"]);
  });
});
