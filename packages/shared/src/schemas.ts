import { z } from "zod";
import { isValidPosition } from "./positions";

export const NAME_MAX_LENGTH = 80;

export const idSchema = z.uuid();

/**
 * Control characters (Unicode category Cc: C0, DEL and C1). None belongs in a name: they are
 * invisible or break the layout, and PostgreSQL refuses NUL in text outright.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A name typed by a user. Surrounding whitespace (line breaks included) is trimmed; control
 * characters left inside, typically from a paste, are refused.
 */
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Le nom est obligatoire")
  .max(NAME_MAX_LENGTH, `Le nom ne doit pas dépasser ${NAME_MAX_LENGTH} caractères`)
  .refine(
    (name) => !CONTROL_CHARACTER.test(name),
    "Le nom contient des caractères invisibles non autorisés (retour à la ligne, tabulation…)",
  );

/**
 * A name read back from the server. Deliberately looser than `nameSchema`, which validates input:
 * input rules may tighten over time, and a row saved under older rules must keep syncing (a pull
 * rejected because of one legacy row would block the device for good).
 */
const storedNameSchema = z.string();

export const positionSchema = z.string().refine(isValidPosition, "Invalid fractional index");

/** Epoch milliseconds. */
export const timestampSchema = z.number().int().nonnegative();

/** A housing unit being inspected (flat, house…). Groups levels. */
export const propertySchema = z.object({
  id: idSchema,
  name: storedNameSchema,
  createdAt: timestampSchema,
  /** Soft-delete marker. Deleted rows are kept so that deletes sync and can be undone. */
  deletedAt: timestampSchema.nullable(),
});
export type Property = z.infer<typeof propertySchema>;

/** A floor of a property ("RDC", "R+1", "Combles"…). */
export const levelSchema = z.object({
  id: idSchema,
  propertyId: idSchema,
  name: storedNameSchema,
  position: positionSchema,
  deletedAt: timestampSchema.nullable(),
});
export type Level = z.infer<typeof levelSchema>;

/** A room of a level ("Cuisine", "Chambre 1"…). Belongs to exactly one level. */
export const spaceSchema = z.object({
  id: idSchema,
  levelId: idSchema,
  name: storedNameSchema,
  position: positionSchema,
  deletedAt: timestampSchema.nullable(),
});
export type Space = z.infer<typeof spaceSchema>;
