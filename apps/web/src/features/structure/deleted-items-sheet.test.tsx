import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { SyncProvider, selectStructure } from "@/sync";
import type { SyncClient } from "@/sync/sync-client";
import { MemoryServer, TestDevice, uuid } from "@/sync/test-support/harness";
import { DeletedItemsSheet } from "./deleted-items-sheet";

const HOUSE = uuid(1);
const RDC = uuid(2);
const R1 = uuid(3);
const ENTREE = uuid(11);
const CUISINE = uuid(12);
const CHAMBRE_1 = uuid(13);
const CHAMBRE_2 = uuid(14);

let device: TestDevice;
let client: SyncClient;
/** The device's clock, which stamps mutations: a second passes before each deletion. */
let clock: number;

beforeEach(async () => {
  clock = Date.now();
  device = await TestDevice.create(new MemoryServer(), { now: () => clock });
  client = device.client;
  await client.mutate("createProperty", { id: HOUSE, name: "Maison" });
  await client.mutate("createLevel", { id: RDC, propertyId: HOUSE, name: "RDC", position: "a0" });
  await client.mutate("createLevel", { id: R1, propertyId: HOUSE, name: "R+1", position: "a1" });
  const rooms = [
    [ENTREE, RDC, "Entrée"],
    [CUISINE, RDC, "Cuisine"],
    [CHAMBRE_1, R1, "Chambre 1"],
    [CHAMBRE_2, R1, "Chambre 2"],
  ] as const;
  for (const [index, [id, levelId, name]] of rooms.entries()) {
    await client.mutate("createSpace", { id, levelId, name, position: `a${index}` });
  }
});

afterEach(async () => {
  await device.close();
});

async function remove(name: "deleteSpace" | "deleteLevel", id: string): Promise<void> {
  clock += 1_000;
  await client.mutate(name, { id });
}

/** The logement's screen, as far as the sheet is concerned: a way to open it, and toasts. */
function renderSheet() {
  function Screen() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Éléments supprimés
        </button>
        <DeletedItemsSheet propertyId={HOUSE} open={open} onOpenChange={setOpen} />
      </>
    );
  }
  render(
    <SyncProvider client={client}>
      <Screen />
      <Toaster />
    </SyncProvider>,
  );
  return userEvent.setup();
}

/**
 * Ends the slide-out of a closing sheet, which happy-dom never plays: until its animation ends,
 * Radix keeps the sheet, and the page hidden behind it.
 */
async function finishClosing(): Promise<void> {
  for (const element of document.querySelectorAll('[data-state="closed"]')) {
    fireEvent.animationEnd(element);
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const sheet = () => screen.getByRole("dialog", { name: "Éléments supprimés" });
/** The text of each entry of a section ("Niveaux", "Pièces"): name, details, button. */
const entries = (section: string) =>
  within(within(sheet()).getByRole("region", { name: section }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
const roomNames = (levelId: string) =>
  selectStructure(client.getState().view, HOUSE)
    .find((group) => group.level.id === levelId)
    ?.spaces.map((space) => space.name);

describe("DeletedItemsSheet", () => {
  it("lists deleted levels with the rooms they hide, and deleted rooms of levels still there", async () => {
    await remove("deleteSpace", CHAMBRE_2); // before its level: it does not come back with it
    await remove("deleteSpace", CUISINE);
    await remove("deleteLevel", R1);
    renderSheet();

    expect(within(sheet()).getByText("Un niveau restauré revient avec ses pièces.")).toBeVisible();
    expect(entries("Niveaux")).toEqual(["R+11\u00a0pièce · supprimé à l’instantRestaurer"]);
    expect(entries("Pièces")).toEqual(["CuisineNiveau RDC · supprimée à l’instantRestaurer"]);
  });

  it("restores a level with its rooms, then says so", async () => {
    await remove("deleteLevel", R1);
    const user = renderSheet();

    await user.click(within(sheet()).getByRole("button", { name: "Restaurer le niveau R+1" }));

    // Text queries match whitespace-normalized text: non-breaking spaces read as spaces.
    expect(await screen.findByText("Niveau « R+1 » restauré avec ses 2 pièces")).toBeVisible();
    await finishClosing();
    expect(roomNames(R1)).toEqual(["Chambre 1", "Chambre 2"]);
  });

  it("restores a room, last deleted first, then lists the rooms left", async () => {
    await remove("deleteSpace", CUISINE);
    await remove("deleteSpace", ENTREE);
    await remove("deleteSpace", CHAMBRE_1);
    const user = renderSheet();
    expect(entries("Pièces")).toEqual([
      "Chambre 1Niveau R+1 · supprimée à l’instantRestaurer",
      "EntréeNiveau RDC · supprimée à l’instantRestaurer",
      "CuisineNiveau RDC · supprimée à l’instantRestaurer",
    ]);

    await user.click(within(sheet()).getByRole("button", { name: "Restaurer la pièce Cuisine" }));
    expect(await screen.findByText("Pièce « Cuisine » restaurée")).toBeVisible();
    await finishClosing();
    expect(roomNames(RDC)).toEqual(["Cuisine"]);

    await user.click(screen.getByRole("button", { name: "Éléments supprimés" }));
    expect(entries("Pièces")).toHaveLength(2);
    expect(within(sheet()).queryByRole("region", { name: "Niveaux" })).toBeNull();
  });

  it("says when nothing is deleted", () => {
    renderSheet();

    expect(within(sheet()).getByText("Aucun élément supprimé")).toBeVisible();
    expect(within(sheet()).queryByRole("button", { name: /^Restaurer/ })).toBeNull();
  });
});
