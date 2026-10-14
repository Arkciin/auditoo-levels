import { newId, positionBetween } from "@repo/shared";

import type { SyncClient } from "@/sync";

const EXAMPLE: readonly (readonly [level: string, spaces: readonly string[]])[] = [
  ["Sous-sol", ["Cave", "Chaufferie", "Garage"]],
  ["RDC", ["Entrée", "Séjour", "Cuisine", "WC", "Cellier"]],
  ["R+1", ["Palier", "Chambre 1", "Chambre 2", "Chambre 3", "Salle de bain", "WC 2"]],
  ["Combles", ["Grenier"]],
];

/**
 * Creates a furnished example house, handy for a demo. It goes through the regular mutations,
 * so it is queued, synced and undoable like anything a user types.
 */
export async function createExampleProperty(mutate: SyncClient["mutate"]): Promise<string> {
  const propertyId = newId();
  await mutate("createProperty", { id: propertyId, name: "Maison exemple, 8 rue des Tilleuls" });

  let levelPosition: string | null = null;
  for (const [levelName, spaceNames] of EXAMPLE) {
    const levelId = newId();
    levelPosition = positionBetween(levelPosition, null);
    await mutate("createLevel", {
      id: levelId,
      propertyId,
      name: levelName,
      position: levelPosition,
    });

    let spacePosition: string | null = null;
    for (const name of spaceNames) {
      spacePosition = positionBetween(spacePosition, null);
      await mutate("createSpace", { id: newId(), levelId, name, position: spacePosition });
    }
  }
  return propertyId;
}
