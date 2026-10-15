/**
 * Naming helpers that make data entry fast on site: French housing vocabulary, smart numbering
 * ("Chambre 3") and a sensible default place for a new level ("Sous-sol" goes below "RDC").
 */
import { NAME_MAX_LENGTH } from "@repo/shared";

const BASEMENT_RANK = -1;
const GROUND_RANK = 0;
const ATTIC_RANK = 1000;

/** Lower-case, accent-free, single-spaced: "Rez-de-Chaussée " → "rez-de-chaussee". */
function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Vertical rank of a level from its name, following French conventions: "Sous-sol" -1,
 * "RDC" 0, "R+2" / "2e étage" 2, "Combles" on top. `null` when the name says nothing about height.
 */
export function levelRank(name: string): number | null {
  const n = normalize(name);
  const basement = /^(?:sous[- ]?sol|ss|cave)(?: ?-?(\d+))?$/.exec(n);
  if (basement) return basement[1] ? -Number(basement[1]) : BASEMENT_RANK;
  if (/^(?:rdc|rez[- ]de[- ](?:chaussee|jardin)|plain[- ]pied)$/.test(n)) return GROUND_RANK;
  const upper =
    /^r ?\+ ?(\d+)$/.exec(n) ??
    /^(\d+)(?:er|re|e|eme|ieme)? ?etage$/.exec(n) ??
    /^etage ?(\d+)$/.exec(n);
  if (upper) return Number(upper[1]);
  if (/^(?:combles?|grenier)(?: amenages?)?$/.test(n)) return ATTIC_RANK;
  return null;
}

/** Up to four level names worth one tap, given the levels already described. */
export function suggestLevelNames(existing: readonly string[]): string[] {
  const ranks = existing.map(levelRank);
  const has = (predicate: (rank: number) => boolean) =>
    ranks.some((rank) => rank !== null && predicate(rank));

  const suggestions: string[] = [];
  if (!has((rank) => rank === GROUND_RANK)) suggestions.push("RDC");
  const highestFloor = Math.max(
    GROUND_RANK,
    ...ranks.filter((rank): rank is number => rank !== null && rank < ATTIC_RANK),
  );
  suggestions.push(`R+${highestFloor + 1}`);
  if (!has((rank) => rank < GROUND_RANK)) suggestions.push("Sous-sol");
  if (!has((rank) => rank === ATTIC_RANK)) suggestions.push("Combles");
  return suggestions.slice(0, 4);
}

/**
 * Where a new level should go so that recognised levels stay in ascending order (lowest first):
 * right after the last recognised level below it. Unrecognised names go at the end.
 */
export function levelInsertIndex(levels: readonly { name: string }[], name: string): number {
  const rank = levelRank(name);
  if (rank === null) return levels.length;
  let index = -1;
  levels.forEach((level, i) => {
    const other = levelRank(level.name);
    if (other !== null && other <= rank) index = i;
  });
  if (index >= 0) return index + 1;
  const firstAbove = levels.findIndex((level) => {
    const other = levelRank(level.name);
    return other !== null && other > rank;
  });
  return firstAbove >= 0 ? firstAbove : levels.length;
}

/**
 * Name of a copy of the level `source`, given the property's level names. A floor becomes the next
 * free floor above it, in the source's spelling ("R+1" becomes "R+2", or "R+3" when "R+2" exists;
 * "1er étage" becomes "2e étage"): identical floors are what inspectors copy. Any other level
 * becomes "RDC (copie)", then "RDC (copie 2)"…
 */
export function duplicateLevelName(source: string, existing: readonly string[]): string {
  const rank = levelRank(source);
  if (rank === null || rank <= GROUND_RANK || rank >= ATTIC_RANK) return copyName(source, existing);
  const taken = new Set(existing.map(levelRank));
  let floor = rank + 1;
  while (taken.has(floor)) floor += 1;
  const respelled = source.replace(/\d+/, String(floor)).replace(/^(\d+)(?:er|re)(?=\s|$)/i, "$1e"); // "1er étage" → "2e étage"
  return levelRank(respelled) === floor ? respelled : `R+${floor}`;
}

/**
 * Where the copy of the level at `sourceIndex` goes among `levels`: a floor where floors belong
 * ("R+2" above "R+1", below the attic), anything else right after its source.
 */
export function duplicateLevelIndex(
  levels: readonly { name: string }[],
  sourceIndex: number,
  copy: string,
): number {
  return levelRank(copy) === null ? sourceIndex + 1 : levelInsertIndex(levels, copy);
}

const COPY_SUFFIX = / \(copie(?: \d+)?\)$/i;

function copyName(source: string, existing: readonly string[]): string {
  const base = source.replace(COPY_SUFFIX, "");
  const taken = new Set(existing.map(normalize));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copie)" : ` (copie ${n})`;
    const name = `${truncate(base, NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(normalize(name))) return name;
  }
}

/** At most `max` UTF-16 code units, never splitting a character (an emoji, say) in two. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let result = "";
  for (const character of text) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result.trimEnd();
}

/**
 * Names of the rooms of a level copy, in order, given every room name of the property. Rooms
 * always numbered ("Chambre 2") take the next free numbers, so that each bedroom of the logement
 * keeps its own; the others keep their name, so that the copy reads like its source.
 */
export function duplicateSpaceNames(
  source: readonly string[],
  propertyNames: readonly string[],
): string[] {
  const names = [...propertyNames];
  return source.map((name) => {
    const bare = normalize(name).replace(/ \d+$/, "");
    const base = [...ALWAYS_NUMBERED].find((numbered) => normalize(numbered) === bare);
    if (base === undefined) return name;
    const renumbered = nextSpaceName(base, names);
    names.push(renumbered);
    return renumbered;
  });
}

const SPACES_BY_KIND = {
  basement: ["Cave", "Chaufferie", "Garage", "Buanderie", "Cellier", "Local technique"],
  ground: ["Entrée", "Séjour", "Cuisine", "WC", "Salle d’eau", "Chambre", "Cellier", "Garage"],
  upper: ["Chambre", "Salle de bain", "WC", "Dégagement", "Bureau", "Dressing", "Salle d’eau"],
  attic: ["Grenier", "Chambre", "Salle d’eau", "Rangement"],
  other: ["Chambre", "Séjour", "Cuisine", "Salle de bain", "WC", "Entrée", "Dégagement", "Bureau"],
} as const;

/** Rooms usually counted with a number, even when there is only one so far. */
const ALWAYS_NUMBERED = new Set(["Chambre"]);

/**
 * Room names for a level, most likely first. Names already used on the level move to the end,
 * except the always-numbered ones (a floor often has several bedrooms).
 */
export function suggestSpaceNames(levelName: string, siblingNames: readonly string[]): string[] {
  const rank = levelRank(levelName);
  const kind =
    rank === null
      ? "other"
      : rank < GROUND_RANK
        ? "basement"
        : rank === GROUND_RANK
          ? "ground"
          : rank === ATTIC_RANK
            ? "attic"
            : "upper";
  const used = new Set(siblingNames.map((name) => normalize(name).replace(/ \d+$/, "")));
  const candidates: readonly string[] = SPACES_BY_KIND[kind];
  const fresh = candidates.filter((c) => ALWAYS_NUMBERED.has(c) || !used.has(normalize(c)));
  const seen = candidates.filter((c) => !fresh.includes(c));
  return [...fresh, ...seen];
}

/**
 * The name to give a room typed in full, given every room name of the property: as typed, unless
 * it is a room always numbered, which gets the number its suggestion would ("chambre" becomes
 * "Chambre 3", as tapping « Chambre » would). Case and accents do not matter; a name typed with
 * its own number ("Chambre 5") or more words ("Chambre parentale") is kept.
 */
export function typedSpaceName(typed: string, existing: readonly string[]): string {
  const base = [...ALWAYS_NUMBERED].find((numbered) => normalize(numbered) === normalize(typed));
  return base === undefined ? typed : nextSpaceName(base, existing);
}

/**
 * The name to give a new room of type `base` given every room name of the property:
 * "Cuisine", then "Cuisine 2"; bedrooms are always numbered ("Chambre 1", "Chambre 2"…).
 */
export function nextSpaceName(base: string, existing: readonly string[]): string {
  const pattern = new RegExp(`^${escapeRegExp(normalize(base))}(?: (\\d+))?$`);
  let count = 0;
  let highest = 0;
  for (const name of existing) {
    const match = pattern.exec(normalize(name));
    if (!match) continue;
    count += 1;
    highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  if (count === 0) return ALWAYS_NUMBERED.has(base) ? `${base} 1` : base;
  return `${base} ${highest + 1}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "1 pièce", "3 pièces" (French plural rules: 0 and 1 are singular). */
export function plural(count: number, singular: string, pluralForm: string): string {
  const rule = new Intl.PluralRules("fr-FR").select(count);
  return `${count} ${rule === "one" ? singular : pluralForm}`;
}

/**
 * The size of a logement, as its row and its screen give it: « 2 niveaux, 5 pièces », « 1 niveau,
 * aucune pièce », or « Aucun niveau » (rooms only exist within levels): zero reads as a word.
 */
export function levelsAndRooms(levelCount: number, roomCount: number): string {
  if (levelCount === 0) return "Aucun niveau";
  return `${plural(levelCount, "niveau", "niveaux")}, ${howManyRooms(roomCount)}`;
}

/** « aucune pièce », « 1 pièce », « 3 pièces »: zero reads as a word, as in `levelsAndRooms`. */
export function howManyRooms(count: number): string {
  return count === 0 ? "aucune pièce" : plural(count, "pièce", "pièces");
}
