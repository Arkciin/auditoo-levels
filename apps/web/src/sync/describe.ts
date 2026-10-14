/**
 * French texts for the UI: descriptions of mutations for the "Modifications en attente" panel,
 * and messages for failed actions.
 *
 * Names are looked up in the state the mutation applied to, so that a rename can show the former
 * name. The current view is not that state (it already includes the rename): to describe the
 * whole queue, use {@link describePendingMutations}, which walks it from the base.
 */
import { type Mutation, MutationRejectedError, type Snapshot } from "@repo/shared";
import { StorageClosedError } from "./storage";

type EntityKind = "property" | "level" | "space";

const NOUNS: Readonly<Record<EntityKind, string>> = {
  property: "Logement",
  level: "Niveau",
  space: "Pièce",
};

interface SpaceName {
  readonly name: string;
  readonly levelId: string;
}

/** The lookups descriptions need, as of just before the described mutation. */
interface NameLookup {
  property(id: string): string | undefined;
  level(id: string): string | undefined;
  space(id: string): SpaceName | undefined;
}

/**
 * Describes `mutation`, e.g. « Pièce « Cave » supprimée ». `before` is the state the mutation
 * applies to (falls back to a generic noun for entities it does not contain).
 */
export function describeMutation(mutation: Mutation, before: Snapshot): string {
  return describe(mutation, namesIn(before));
}

function namesIn(snapshot: Snapshot): NameLookup {
  return {
    property: (id) => snapshot.properties.get(id)?.name,
    level: (id) => snapshot.levels.get(id)?.name,
    space: (id) => snapshot.spaces.get(id),
  };
}

const pendingCache = new WeakMap<
  readonly Mutation[],
  { readonly base: Snapshot; readonly descriptions: readonly string[] }
>();

/**
 * Describes each pending mutation (same order), looking names up as they were just before it:
 * `base` plus the creations, renames and moves earlier in the queue. Memoized per
 * (`base`, `pending`), i.e. per state.
 */
export function describePendingMutations(
  base: Snapshot,
  pending: readonly Mutation[],
): readonly string[] {
  const cached = pendingCache.get(pending);
  if (cached?.base === base) return cached.descriptions;

  // Only names (and the level of spaces) matter here, so tracking them is enough: replaying the
  // mutators themselves would be asynchronous.
  const propertyNames = new Map<string, string>();
  const levelNames = new Map<string, string>();
  const spaces = new Map<string, SpaceName>();
  const names: NameLookup = {
    property: (id) => propertyNames.get(id) ?? base.properties.get(id)?.name,
    level: (id) => levelNames.get(id) ?? base.levels.get(id)?.name,
    space: (id) => spaces.get(id) ?? base.spaces.get(id),
  };

  const descriptions = pending.map((mutation) => {
    const description = describe(mutation, names);
    switch (mutation.name) {
      case "createProperty":
      case "renameProperty":
        propertyNames.set(mutation.args.id, mutation.args.name);
        break;
      case "createLevel":
      case "renameLevel":
        levelNames.set(mutation.args.id, mutation.args.name);
        break;
      case "createSpace":
        spaces.set(mutation.args.id, { name: mutation.args.name, levelId: mutation.args.levelId });
        break;
      case "renameSpace":
      case "moveSpace": {
        const space = names.space(mutation.args.id);
        if (space) {
          spaces.set(mutation.args.id, {
            name: mutation.name === "renameSpace" ? mutation.args.name : space.name,
            levelId: mutation.name === "moveSpace" ? mutation.args.levelId : space.levelId,
          });
        }
        break;
      }
      default:
        break;
    }
    return description;
  });
  pendingCache.set(pending, { base, descriptions });
  return descriptions;
}

function describe(mutation: Mutation, names: NameLookup): string {
  switch (mutation.name) {
    case "createProperty":
      return `${subject("property", mutation.args.name)} créé`;
    case "renameProperty":
      return renamed("property", names.property(mutation.args.id), mutation.args.name);
    case "deleteProperty":
      return `${subject("property", names.property(mutation.args.id))} supprimé`;
    case "restoreProperty":
      return `${subject("property", names.property(mutation.args.id))} restauré`;

    case "createLevel":
      return `${subject("level", mutation.args.name)} ajouté`;
    case "renameLevel":
      return renamed("level", names.level(mutation.args.id), mutation.args.name);
    case "moveLevel":
      return `${subject("level", names.level(mutation.args.id))} déplacé`;
    case "deleteLevel":
      return `${subject("level", names.level(mutation.args.id))} supprimé`;
    case "restoreLevel":
      return `${subject("level", names.level(mutation.args.id))} restauré`;

    case "createSpace":
      return `${subject("space", mutation.args.name)} ajoutée`;
    case "renameSpace":
      return renamed("space", names.space(mutation.args.id)?.name, mutation.args.name);
    case "moveSpace": {
      const space = names.space(mutation.args.id);
      const moved = `${subject("space", space?.name)} déplacée`;
      if (!space || space.levelId === mutation.args.levelId) return moved;
      const level = names.level(mutation.args.levelId);
      return level === undefined
        ? `${moved} vers un autre niveau`
        : `${moved} vers ${quote(level)}`;
    }
    case "deleteSpace":
      return `${subject("space", names.space(mutation.args.id)?.name)} supprimée`;
    case "restoreSpace":
      return `${subject("space", names.space(mutation.args.id)?.name)} restaurée`;
  }
}

/**
 * User-facing message for a rejected `mutate()` call. Prefer it to `error.message`: Zod 4 puts a
 * JSON dump of the issues there, while the schemas' French messages are in `issues`.
 */
export function describeMutationError(error: unknown): string {
  if (isZodError(error)) {
    return error.issues[0]?.message ?? "Les informations saisies ne sont pas valides.";
  }
  if (error instanceof MutationRejectedError) {
    return "Cette action ne s'applique plus : les données ont changé entre-temps.";
  }
  // The page must be reloaded: the message says so.
  if (error instanceof StorageClosedError) return error.message;
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return "L'appareil n'a plus assez d'espace de stockage pour enregistrer la modification.";
  }
  return "La modification n'a pas pu être enregistrée sur l'appareil.";
}

/** Duck-typed: zod is a dependency of the shared package, not of the app. */
function isZodError(
  error: unknown,
): error is Error & { issues: ReadonlyArray<{ readonly message: string }> } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}

/**
 * Tells the user that one of their changes did not apply, and why, e.g. « La pièce « Cuisine »
 * n'a pas pu être déplacée vers « R+1 » : le niveau n'existe plus. ».
 *
 * @param before the state just before the mutation, for names (a rename shows the former name)
 * @param reason the server's code (`RejectionReason`, or one this version does not know);
 *   `not_applicable` for a change the device itself found no longer applies
 * @param against the state the mutation was refused on, as far as the device knows: tells which
 *   entity was missing
 */
export function describeRejection(
  mutation: Mutation,
  before: Snapshot,
  reason: string,
  against: Snapshot = before,
): string {
  return `${notDone(mutation, namesIn(before))}\u00a0: ${why(mutation, reason, against)}.`;
}

const THE: Readonly<Record<EntityKind, string>> = {
  property: "Le logement",
  level: "Le niveau",
  space: "La pièce",
};

/** « La pièce « Cuisine » n'a pas pu être déplacée vers « R+1 » ». */
function notDone(mutation: Mutation, names: NameLookup): string {
  const fail = (kind: EntityKind, name: string | undefined, participle: string) =>
    `${name === undefined ? THE[kind] : `${THE[kind]} ${quote(name)}`} n'a pas pu être ${participle}`;
  switch (mutation.name) {
    case "createProperty":
      return fail("property", mutation.args.name, "créé");
    case "renameProperty":
      return fail(
        "property",
        names.property(mutation.args.id),
        `renommé en ${quote(mutation.args.name)}`,
      );
    case "deleteProperty":
      return fail("property", names.property(mutation.args.id), "supprimé");
    case "restoreProperty":
      return fail("property", names.property(mutation.args.id), "restauré");

    case "createLevel":
      return fail("level", mutation.args.name, "ajouté");
    case "renameLevel":
      return fail(
        "level",
        names.level(mutation.args.id),
        `renommé en ${quote(mutation.args.name)}`,
      );
    case "moveLevel":
      return fail("level", names.level(mutation.args.id), "déplacé");
    case "deleteLevel":
      return fail("level", names.level(mutation.args.id), "supprimé");
    case "restoreLevel":
      return fail("level", names.level(mutation.args.id), "restauré");

    case "createSpace":
      return fail("space", mutation.args.name, "ajoutée");
    case "renameSpace":
      return fail(
        "space",
        names.space(mutation.args.id)?.name,
        `renommée en ${quote(mutation.args.name)}`,
      );
    case "moveSpace": {
      const space = names.space(mutation.args.id);
      if (!space || space.levelId === mutation.args.levelId) {
        return fail("space", space?.name, "déplacée");
      }
      const level = names.level(mutation.args.levelId);
      const target = level === undefined ? "un autre niveau" : quote(level);
      return fail("space", space.name, `déplacée vers ${target}`);
    }
    case "deleteSpace":
      return fail("space", names.space(mutation.args.id)?.name, "supprimée");
    case "restoreSpace":
      return fail("space", names.space(mutation.args.id)?.name, "restaurée");
  }
}

function why(mutation: Mutation, reason: string, against: Snapshot): string {
  switch (reason) {
    case "not_applicable":
      return missingEntity(mutation, against) ?? "les données ont changé entre-temps";
    case "invalid":
      return "le serveur a jugé la modification invalide";
    case "refused_by_database":
      return "le serveur a refusé de l'enregistrer";
    default:
      // A code from a newer server: what matters is that it said no.
      return "le serveur a refusé la modification";
  }
}

/**
 * What `mutation` needs that `state` lacks, in French, following the checks of its mutator
 * (`packages/shared/src/mutators.ts`); undefined when nothing is missing.
 */
function missingEntity(mutation: Mutation, state: Snapshot): string | undefined {
  const property = (id: string) =>
    state.properties.has(id) ? undefined : "le logement n'existe plus";
  const level = (id: string) => {
    const found = state.levels.get(id);
    return found ? property(found.propertyId) : "le niveau n'existe plus";
  };
  switch (mutation.name) {
    case "createProperty":
    case "deleteProperty":
    case "deleteLevel":
    case "deleteSpace":
      return undefined; // Their mutators never refuse.
    case "renameProperty":
    case "restoreProperty":
      return state.properties.has(mutation.args.id) ? undefined : "il n'existe plus";
    case "createLevel":
      return property(mutation.args.propertyId);
    case "renameLevel":
    case "moveLevel":
    case "restoreLevel": {
      const found = state.levels.get(mutation.args.id);
      return found ? property(found.propertyId) : "il n'existe plus";
    }
    case "createSpace":
      return level(mutation.args.levelId);
    case "renameSpace":
    case "restoreSpace": {
      const space = state.spaces.get(mutation.args.id);
      return space ? level(space.levelId) : "elle n'existe plus";
    }
    case "moveSpace": {
      const space = state.spaces.get(mutation.args.id);
      if (!space) return "elle n'existe plus";
      const target = state.levels.get(mutation.args.levelId);
      if (!target) return "le niveau n'existe plus";
      const source = state.levels.get(space.levelId);
      if (source && source.propertyId !== target.propertyId) {
        return "une pièce ne peut pas changer de logement";
      }
      return property(target.propertyId);
    }
  }
}

/** « Pièce « Cuisine » », or just « Pièce » when the name is unknown. */
function subject(kind: EntityKind, name: string | undefined): string {
  return name === undefined ? NOUNS[kind] : `${NOUNS[kind]} ${quote(name)}`;
}

function renamed(kind: EntityKind, before: string | undefined, after: string): string {
  const verb = kind === "space" ? "renommée" : "renommé";
  const renamedEntity = before === undefined ? NOUNS[kind] : quote(before);
  return `${renamedEntity} ${verb} en ${quote(after)}`;
}

/** French quotation marks, with the non-breaking spaces French typography requires inside. */
function quote(text: string): string {
  return `«\u00a0${text}\u00a0»`;
}
