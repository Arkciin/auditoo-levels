import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { SyncProvider, selectProperties } from "@/sync";
import type { SyncClient } from "@/sync/sync-client";
import { MemoryServer, TestDevice, uuid } from "@/sync/test-support/harness";
import { DeletedPropertiesSheet } from "./deleted-properties-sheet";

const HOUSE = uuid(1);
const FLAT = uuid(2);

let device: TestDevice;
let client: SyncClient;
/** The device's clock, which stamps mutations: a second passes before each deletion. */
let clock: number;

beforeEach(async () => {
  clock = Date.now();
  device = await TestDevice.create(new MemoryServer(), { now: () => clock });
  client = device.client;
  await client.mutate("createProperty", { id: HOUSE, name: "Maison Dupont" });
  await client.mutate("createLevel", {
    id: uuid(3),
    propertyId: HOUSE,
    name: "RDC",
    position: "a0",
  });
  for (const [index, name] of ["Entrée", "Cuisine"].entries()) {
    await client.mutate("createSpace", {
      id: uuid(10 + index),
      levelId: uuid(3),
      name,
      position: `a${index}`,
    });
  }
  await client.mutate("createProperty", { id: FLAT, name: "12 rue des Lilas" });
});

afterEach(async () => {
  await device.close();
});

async function deleteProperty(id: string): Promise<void> {
  clock += 1_000;
  await client.mutate("deleteProperty", { id });
}

function renderSheet() {
  function Screen() {
    const [open, setOpen] = useState(true);
    return <DeletedPropertiesSheet open={open} onOpenChange={setOpen} />;
  }
  render(
    <SyncProvider client={client}>
      <Screen />
      <Toaster />
    </SyncProvider>,
  );
  return userEvent.setup();
}

const sheet = () => screen.getByRole("dialog", { name: "Logements supprimés" });

describe("DeletedPropertiesSheet", () => {
  it("lists deleted logements, last deleted first, with what restoring brings back", async () => {
    await deleteProperty(HOUSE);
    await deleteProperty(FLAT);
    renderSheet();

    expect(
      within(sheet()).getByText("Un logement restauré revient avec ses niveaux et ses pièces."),
    ).toBeVisible();
    expect(
      within(sheet())
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "12 rue des LilasAucun niveau · supprimé à l’instantRestaurer",
      "Maison Dupont1\u00a0niveau, 2\u00a0pièces · supprimé à l’instantRestaurer",
    ]);
  });

  it("restores a logement, then says so", async () => {
    await deleteProperty(HOUSE);
    const user = renderSheet();

    await user.click(
      within(sheet()).getByRole("button", { name: "Restaurer le logement Maison Dupont" }),
    );

    // Text queries match whitespace-normalized text: non-breaking spaces read as spaces.
    expect(await screen.findByText("Logement « Maison Dupont » restauré")).toBeVisible();
    // The sheet slides out (happy-dom plays no animation: end it), and is gone.
    for (const element of document.querySelectorAll('[data-state="closed"]')) {
      fireEvent.animationEnd(element);
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selectProperties(client.getState().view).map(({ property }) => property.id)).toEqual([
      FLAT,
      HOUSE,
    ]);
  });

  it("says when no logement is deleted", () => {
    renderSheet();

    expect(within(sheet()).getByText("Aucun logement supprimé")).toBeVisible();
    expect(within(sheet()).queryByRole("listitem")).toBeNull();
  });
});
