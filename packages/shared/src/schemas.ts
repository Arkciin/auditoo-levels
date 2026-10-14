import { z } from "zod";
import { isValidPosition } from "./positions";

export const NAME_MAX_LENGTH = 80;

export const idSchema = z.uuid();

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Le nom est obligatoire")
  .max(NAME_MAX_LENGTH, `Le nom ne doit pas dépasser ${NAME_MAX_LENGTH} caractères`);

export const positionSchema = z.string().refine(isValidPosition, "Invalid fractional index");

/** Epoch milliseconds. */
export const timestampSchema = z.number().int().nonnegative();

/** A housing unit being inspected (flat, house…). Groups levels. */
export const propertySchema = z.object({
  id: idSchema,
  name: nameSchema,
  createdAt: timestampSchema,
  /** Soft-delete marker. Deleted rows are kept so that deletes sync and can be undone. */
  deletedAt: timestampSchema.nullable(),
});
export type Property = z.infer<typeof propertySchema>;

/** A floor of a property ("RDC", "R+1", "Combles"…). */
export const levelSchema = z.object({
  id: idSchema,
  propertyId: idSchema,
  name: nameSchema,
  position: positionSchema,
  deletedAt: timestampSchema.nullable(),
});
export type Level = z.infer<typeof levelSchema>;

/** A room of a level ("Cuisine", "Chambre 1"…). Belongs to exactly one level. */
export const spaceSchema = z.object({
  id: idSchema,
  levelId: idSchema,
  name: nameSchema,
  position: positionSchema,
  deletedAt: timestampSchema.nullable(),
});
export type Space = z.infer<typeof spaceSchema>;
