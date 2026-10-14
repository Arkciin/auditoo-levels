import type { Snapshot } from "@repo/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncProvider, selectStructure, useView } from "@/sync";
import type { SyncClient } from "@/sync/sync-client";
import { MemoryServer, TestDevice, uuid } from "@/sync/test-support/harness";
import { AddSpace } from "./add-space";

const PROPERTY = uuid(1);
const RDC = uuid(2);
const R1 = uuid(3);

/** A level with its rooms and its room entry, the way the structure screen lays them out. */
function LevelUnderTest({ levelId }: { levelId: string }) {
  const structure = useView(useCallback((view: Snapshot) => selectStructure(view, PROPERTY), []));
  const [adding, setAdding] = useState(false);
  const group = structure.find((candidate) => candidate.level.id === levelId);
  if (!group) return null;
  return (
    <section aria-label={`Niveau ${group.level.name}`}>
      <ul aria-label={`Pièces du niveau ${group.level.name}`}>
        {group.spaces.map((space) => (
          <li key={space.id}>{space.name}</li>
        ))}
      </ul>
      <AddSpace
        propertyId={PROPERTY}
        level={group.level}
        spaces={group.spaces}
        open={adding}
        onOpenChange={setAdding}
      />
    </section>
  );
}

let device: TestDevice;
let client: SyncClient;

beforeEach(async () => {
  device = await TestDevice.create(new MemoryServer());
  client = device.client;
  // A house whose ground floor already has a bedroom: numbering counts the whole logement.
  await client.mutate("createProperty", { id: PROPERTY, name: "Maison" });
  await client.mutate("createLevel", {
    id: RDC,
    propertyId: PROPERTY,
    name: "RDC",
    position: "a0",
  });
  await client.mutate("createLevel", { id: R1, propertyId: PROPERTY, name: "R+1", position: "a1" });
  await client.mutate("createSpace", {
    id: uuid(4),
    levelId: RDC,
    name: "Chambre 1",
    position: "a0",
  });
});

afterEach(async () => {
  await device.close();
});

function renderLevel() {
  // No delay between keystrokes: typing outpaces saves, as fast thumbs do on a slow phone.
  const user = userEvent.setup({ delay: null });
  render(
    <SyncProvider client={client}>
      <LevelUnderTest levelId={R1} />
    </SyncProvider>,
  );
  return user;
}

const roomField = () => screen.getByRole("textbox", { name: "Nouvelle pièce au niveau R+1" });
const roomList = () => screen.getByRole("list", { name: "Pièces du niveau R+1" });
const roomNames = () =>
  within(roomList())
    .queryAllByRole("listitem")
    .map((item) => item.textContent);
const suggestion = (name: string) =>
  within(screen.getByRole("group", { name: "Suggestions de pièces" })).getByRole("button", {
    name,
  });

async function openRoomField(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Ajouter une pièce" }));
  expect(roomField()).toHaveFocus();
}

describe("AddSpace", () => {
  it("keeps rooms typed in a row in order, the field empty and focused after each", async () => {
    const user = renderLevel();
    await openRoomField(user);

    await user.type(roomField(), "Palier{Enter}Chambre parents{Enter}WC{Enter}");

    expect(roomField()).toHaveValue("");
    expect(roomField()).toHaveFocus();
    await waitFor(() => expect(roomNames()).toEqual(["Palier", "Chambre parents", "WC"]));
  });

  it("numbers bedrooms across the logement, even when tapped faster than they are saved", async () => {
    const user = renderLevel();
    await openRoomField(user);

    // Two taps before React re-renders, or the first room is even saved.
    fireEvent.click(suggestion("Chambre"));
    fireEvent.click(suggestion("Chambre"));

    await waitFor(() => expect(roomNames()).toEqual(["Chambre 2", "Chambre 3"]));
  });

  it("numbers a repeated room from its second occurrence", async () => {
    const user = renderLevel();
    await openRoomField(user);

    fireEvent.click(suggestion("WC"));
    fireEvent.click(suggestion("WC"));

    await waitFor(() => expect(roomNames()).toEqual(["WC", "WC 2"]));
  });

  it("keeps a typed room and a suggestion tapped right after in order", async () => {
    const user = renderLevel();
    await openRoomField(user);

    await user.type(roomField(), "Bureau{Enter}");
    fireEvent.click(suggestion("Chambre"));

    await waitFor(() => expect(roomNames()).toEqual(["Bureau", "Chambre 2"]));
  });

  it("only offers to add once something is typed", async () => {
    const user = renderLevel();
    await openRoomField(user);
    const add = screen.getByRole("button", { name: "Ajouter la pièce" });

    expect(add).toBeDisabled();
    await user.type(roomField(), "   ");
    expect(add).toBeDisabled();
    await user.keyboard("{Enter}");
    await user.type(roomField(), "Dressing");
    expect(add).toBeEnabled();

    await user.click(add);
    expect(roomField()).toHaveFocus(); // ready for the next room
    await waitFor(() => expect(roomNames()).toEqual(["Dressing"]));
  });

  it("closes with Escape or « Terminé »", async () => {
    const user = renderLevel();

    await openRoomField(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await openRoomField(user);
    await user.click(screen.getByRole("button", { name: "Terminé" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajouter une pièce" })).toBeVisible();
  });
});
