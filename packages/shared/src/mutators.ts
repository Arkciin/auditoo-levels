/**
 * Isomorphic mutators: the single definition of what every user action does to the data.
 *
 * The same functions run in two places:
 * - on the device, against the local snapshot, to update the UI instantly (optimistic);
 * - on the server, inside a Postgres transaction, to produce the authoritative state.
 *
 * Because both sides execute identical code, the optimistic UI can only diverge from the
 * server when another device changed the same data in the meantime, and the next pull
 * reconciles that automatically (see `snapshot.ts` and the client sync engine).
 *
 * Mutators must be deterministic: they may only depend on the transaction contents, their
 * arguments and the mutation timestamp (no `Date.now()`, no randomness).
 *
 * Conflict policy, "edit wins over delete": writing to a soft-deleted entity (renaming it,
 * moving it, adding a room to it) brings it back, together with its parents. A user's input is
 * never silently discarded; the worst case is an item reappearing, which can be deleted again.
 */
import { z } from "zod";
import {
  idSchema,
  type Level,
  nameSchema,
  type Property,
  positionSchema,
  type Space,
} from "./schemas";

export interface MutatorTx {
  getProperty(id: string): Promise<Property | undefined>;
  getLevel(id: string): Promise<Level | undefined>;
  getSpace(id: string): Promise<Space | undefined>;
  putProperty(property: Property): Promise<void>;
  putLevel(level: Level): Promise<void>;
  putSpace(space: Space): Promise<void>;
}

export interface MutationContext {
  /** Device wall-clock time (epoch ms) at which the user performed the action. */
  readonly timestamp: number;
}

/**
 * Thrown when a mutation cannot apply to the current state (e.g. it targets an entity that does
 * not exist). The server records the mutation as processed and moves on, so one bad mutation can
 * never block a device's queue; the client simply drops it on the next pull.
 */
export class MutationRejectedError extends Error {
  override readonly name = "MutationRejectedError";
}

const entityRef = z.object({ id: idSchema });

export const mutationArgsSchemas = {
  createProperty: z.object({ id: idSchema, name: nameSchema }),
  renameProperty: z.object({ id: idSchema, name: nameSchema }),
  deleteProperty: entityRef,
  restoreProperty: entityRef,

  createLevel: z.object({
    id: idSchema,
    propertyId: idSchema,
    name: nameSchema,
    position: positionSchema,
  }),
  renameLevel: z.object({ id: idSchema, name: nameSchema }),
  moveLevel: z.object({ id: idSchema, position: positionSchema }),
  deleteLevel: entityRef,
  restoreLevel: entityRef,

  createSpace: z.object({
    id: idSchema,
    levelId: idSchema,
    name: nameSchema,
    position: positionSchema,
  }),
  renameSpace: z.object({ id: idSchema, name: nameSchema }),
  moveSpace: z.object({ id: idSchema, levelId: idSchema, position: positionSchema }),
  deleteSpace: entityRef,
  restoreSpace: entityRef,
} as const;

export type MutationName = keyof typeof mutationArgsSchemas;
export type MutationArgs<N extends MutationName> = z.infer<(typeof mutationArgsSchemas)[N]>;

export const mutationNames = Object.keys(mutationArgsSchemas) as MutationName[];

type Mutator<N extends MutationName> = (
  tx: MutatorTx,
  args: MutationArgs<N>,
  ctx: MutationContext,
) => Promise<void>;

export const mutators: { readonly [N in MutationName]: Mutator<N> } = {
  async createProperty(tx, { id, name }, { timestamp }) {
    await tx.putProperty({ id, name, createdAt: timestamp, deletedAt: null });
  },

  async renameProperty(tx, { id, name }) {
    const property = await requireProperty(tx, id);
    await tx.putProperty({ ...property, name, deletedAt: null });
  },

  async deleteProperty(tx, { id }, { timestamp }) {
    const property = await tx.getProperty(id);
    if (!property || property.deletedAt !== null) return;
    await tx.putProperty({ ...property, deletedAt: timestamp });
  },

  async restoreProperty(tx, { id }) {
    await reviveProperty(tx, id);
  },

  async createLevel(tx, { id, propertyId, name, position }) {
    await reviveProperty(tx, propertyId);
    await tx.putLevel({ id, propertyId, name, position, deletedAt: null });
  },

  async renameLevel(tx, { id, name }) {
    const level = await requireLevel(tx, id);
    await reviveProperty(tx, level.propertyId);
    await tx.putLevel({ ...level, name, deletedAt: null });
  },

  async moveLevel(tx, { id, position }) {
    const level = await requireLevel(tx, id);
    await reviveProperty(tx, level.propertyId);
    await tx.putLevel({ ...level, position, deletedAt: null });
  },

  async deleteLevel(tx, { id }, { timestamp }) {
    // The level's spaces are left untouched: they are hidden with their level and come back
    // with it on undo, without having to remember which ones were deleted together.
    const level = await tx.getLevel(id);
    if (!level || level.deletedAt !== null) return;
    await tx.putLevel({ ...level, deletedAt: timestamp });
  },

  async restoreLevel(tx, { id }) {
    await reviveLevel(tx, id);
  },

  async createSpace(tx, { id, levelId, name, position }) {
    await reviveLevel(tx, levelId);
    await tx.putSpace({ id, levelId, name, position, deletedAt: null });
  },

  async renameSpace(tx, { id, name }) {
    const space = await requireSpace(tx, id);
    await reviveLevel(tx, space.levelId);
    await tx.putSpace({ ...space, name, deletedAt: null });
  },

  async moveSpace(tx, { id, levelId, position }) {
    const space = await requireSpace(tx, id);
    const [source, target] = await Promise.all([
      tx.getLevel(space.levelId),
      requireLevel(tx, levelId),
    ]);
    if (source && source.propertyId !== target.propertyId) {
      throw new MutationRejectedError("A space cannot be moved to another property");
    }
    await reviveLevel(tx, levelId);
    await tx.putSpace({ ...space, levelId, position, deletedAt: null });
  },

  async deleteSpace(tx, { id }, { timestamp }) {
    const space = await tx.getSpace(id);
    if (!space || space.deletedAt !== null) return;
    await tx.putSpace({ ...space, deletedAt: timestamp });
  },

  async restoreSpace(tx, { id }) {
    const space = await requireSpace(tx, id);
    await reviveLevel(tx, space.levelId);
    if (space.deletedAt !== null) await tx.putSpace({ ...space, deletedAt: null });
  },
};

async function requireProperty(tx: MutatorTx, id: string): Promise<Property> {
  const property = await tx.getProperty(id);
  if (!property) throw new MutationRejectedError(`Unknown property ${id}`);
  return property;
}

async function requireLevel(tx: MutatorTx, id: string): Promise<Level> {
  const level = await tx.getLevel(id);
  if (!level) throw new MutationRejectedError(`Unknown level ${id}`);
  return level;
}

async function requireSpace(tx: MutatorTx, id: string): Promise<Space> {
  const space = await tx.getSpace(id);
  if (!space) throw new MutationRejectedError(`Unknown space ${id}`);
  return space;
}

/** Ensures the property exists and is not deleted ("edit wins over delete"). */
async function reviveProperty(tx: MutatorTx, id: string): Promise<Property> {
  const property = await requireProperty(tx, id);
  if (property.deletedAt === null) return property;
  const revived = { ...property, deletedAt: null };
  await tx.putProperty(revived);
  return revived;
}

/** Ensures the level and its property exist and are not deleted. */
async function reviveLevel(tx: MutatorTx, id: string): Promise<Level> {
  const level = await requireLevel(tx, id);
  await reviveProperty(tx, level.propertyId);
  if (level.deletedAt === null) return level;
  const revived = { ...level, deletedAt: null };
  await tx.putLevel(revived);
  return revived;
}
