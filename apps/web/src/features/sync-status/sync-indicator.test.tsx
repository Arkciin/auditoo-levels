import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, SyncProvider, type SyncStatus, type Transport } from "@/sync";
import type { SyncClient } from "@/sync/sync-client";
import {
  deferred,
  MemoryServer,
  MemoryTransport,
  openTestClient,
  TestDevice,
  uuid,
} from "@/sync/test-support/harness";
import { presentStatus, SyncIndicator } from "./sync-indicator";

const RETRY_PROMISE =
  " Vos modifications restent sur cet appareil et Relevé réessaie automatiquement.";

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    connection: "online",
    phase: "idle",
    sending: false,
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("presentStatus", () => {
  it.each([
    ["nothing pending", status(), "synced", "À jour", "Tout est à jour"],
    [
      "changes waiting",
      status({ pendingCount: 2 }),
      "pending",
      "En attente",
      "Modifications en attente",
    ],
    [
      "changes being sent",
      status({ phase: "syncing", sending: true, pendingCount: 2 }),
      "syncing",
      "Envoi…",
      "Synchronisation en cours",
    ],
    // The periodic pull and the pull after a poke: nothing of the user's is moving.
    [
      "a pull, nothing to send",
      status({ phase: "syncing" }),
      "synced",
      "À jour",
      "Tout est à jour",
    ],
    [
      "a pull, changes already sent but not confirmed yet",
      status({ phase: "syncing", pendingCount: 2 }),
      "pending",
      "En attente",
      "Modifications en attente",
    ],
    ["a failed sync", status({ phase: "error" }), "error", "Erreur", "La synchronisation a échoué"],
    [
      "no network, whatever else is going on",
      status({ connection: "offline", phase: "error", pendingCount: 3 }),
      "offline",
      "Hors ligne",
      "Hors ligne",
    ],
  ])("presents %s", (_, input, tone, short, title) => {
    expect(presentStatus(input)).toMatchObject({ tone, short, title });
  });

  it("explains a failure with the engine's message and promises a retry", () => {
    const message = "Le serveur est momentanément indisponible (erreur 503).";

    expect(presentStatus(status({ phase: "error", lastError: message })).explanation).toBe(
      message + RETRY_PROMISE,
    );
    expect(presentStatus(status({ phase: "error" })).explanation).toBe(
      `Le serveur n’a pas accepté la requête.${RETRY_PROMISE}`,
    );
  });

  it("promises no retry when the message asks for a reload", () => {
    const message = "Les données de Relevé ont été effacées sur cet appareil. Rechargez la page.";

    expect(presentStatus(status({ phase: "error", lastError: message })).explanation).toBe(message);
  });
});

describe("SyncIndicator", () => {
  let client: SyncClient | undefined;

  afterEach(async () => {
    await client?.dispose();
    client = undefined;
    vi.restoreAllMocks();
  });

  function renderIndicator(syncClient: SyncClient) {
    client = syncClient;
    render(
      <SyncProvider client={syncClient}>
        <SyncIndicator />
      </SyncProvider>,
    );
    return userEvent.setup();
  }

  const pill = () => screen.getByRole("button", { name: /Voir le détail$/ });

  async function addHouse(syncClient: SyncClient, rooms: string[] = []) {
    await syncClient.mutate("createProperty", { id: uuid(1), name: "Maison" });
    await syncClient.mutate("createLevel", {
      id: uuid(2),
      propertyId: uuid(1),
      name: "RDC",
      position: "a0",
    });
    for (const [index, name] of rooms.entries()) {
      await syncClient.mutate("createSpace", {
        id: uuid(10 + index),
        levelId: uuid(2),
        name,
        position: `a${index}`,
      });
    }
  }

  it("says when everything is on the server", async () => {
    const { client: synced } = await TestDevice.create(new MemoryServer());
    await addHouse(synced);
    await synced.syncNow();
    renderIndicator(synced);

    expect(pill()).toHaveAccessibleName("Tout est à jour. Voir le détail");
    expect(pill()).toHaveTextContent("À jour");
  });

  it("stays quiet while it pulls, and says « Envoi… » only while changes are on their way", async () => {
    const network = new MemoryTransport(new MemoryServer());
    let held: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
    const hold = () => {
      held = { started: deferred(), release: deferred() };
      return held;
    };
    hold().release.resolve();
    const transport: Transport = {
      push: async (request) => {
        held.started.resolve();
        await held.release.promise;
        return network.push(request);
      },
      pull: async (request) => {
        held.started.resolve();
        await held.release.promise;
        return network.pull(request);
      },
    };
    const device = await openTestClient({ indexedDB: new IDBFactory(), transport });
    await device.syncNow();
    renderIndicator(device);

    // The periodic pull, or the one after a poke: nothing of the user's is moving. (`act` lets
    // React render the cycle's status before the pill is read.)
    const pull = hold();
    try {
      await act(async () => {
        void device.syncNow();
        await pull.started.promise;
      });
      expect(device.getState().status.phase).toBe("syncing");
      expect(pill()).toHaveTextContent("À jour");
    } finally {
      pull.release.resolve();
    }
    await waitFor(() => expect(device.getState().status.phase).toBe("idle"));

    await device.mutate("createProperty", { id: uuid(1), name: "Maison" });
    const push = hold();
    try {
      await act(async () => {
        void device.syncNow();
        await push.started.promise;
      });
      expect(pill()).toHaveTextContent("Envoi…");
    } finally {
      push.release.resolve();
    }
    await waitFor(() => expect(pill()).toHaveTextContent("À jour"));
  });

  // Counts are joined to their noun by a non-breaking space ("3 modifications"), as in French print.
  it("counts the changes waiting on the device, in its name and in a badge", async () => {
    const { client: device } = await TestDevice.create(new MemoryServer());
    await addHouse(device, ["Cuisine"]);
    renderIndicator(device);

    expect(pill()).toHaveAccessibleName(
      "Modifications en attente, 3\u00a0modifications en attente. Voir le détail",
    );
    expect(within(pill()).getByText("3")).toBeVisible();
  });

  it("says offline, with a singular for a single change", async () => {
    const { client: offline } = await TestDevice.create(new MemoryServer(), {
      isOnline: () => false,
    });
    await offline.mutate("createProperty", { id: uuid(1), name: "Maison" });
    renderIndicator(offline);

    expect(pill()).toHaveAccessibleName(
      "Hors ligne, 1\u00a0modification en attente. Voir le détail",
    );
    expect(pill()).toHaveTextContent("Hors ligne");
  });

  it("reports a failed sync", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the engine logs the failure
    const unavailable = () => Promise.reject(new HttpError(503));
    const failing: Transport = { push: unavailable, pull: unavailable };
    const broken = await openTestClient({ indexedDB: new IDBFactory(), transport: failing });
    await broken.syncNow();
    renderIndicator(broken);

    expect(pill()).toHaveAccessibleName("La synchronisation a échoué. Voir le détail");
    expect(pill()).toHaveTextContent("Erreur");
  });

  it("opens a sheet listing the pending changes, which syncs them on demand", async () => {
    const { client: device } = await TestDevice.create(new MemoryServer());
    await addHouse(device, ["Cuisine"]);
    const user = renderIndicator(device);

    await user.click(pill());
    const sheet = await screen.findByRole("dialog", { name: "Modifications en attente" });
    expect(
      within(sheet).getByRole("heading", { name: "3\u00a0modifications sur cet appareil" }),
    ).toBeVisible();
    // Plain French, in the order they were made (counts and quotes use non-breaking spaces).
    expect(
      within(sheet)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Logement «\u00a0Maison\u00a0» créé",
      "Niveau «\u00a0RDC\u00a0» ajouté",
      "Pièce «\u00a0Cuisine\u00a0» ajoutée",
    ]);
    expect(within(sheet).getByText("Pas encore synchronisé sur cet appareil.")).toBeVisible();

    await user.click(within(sheet).getByRole("button", { name: "Synchroniser maintenant" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Tout est à jour" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Aucune modification en attente" })).toBeVisible();
    expect(screen.getByText("Dernière synchronisation à l’instant.")).toBeVisible();
  });
});
