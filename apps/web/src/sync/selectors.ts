/**
 * Pure, memoized read models of a snapshot for the UI.
 *
 * Snapshots are immutable and replaced on every change, so results are cached per snapshot object
 * (in WeakMaps, collected with the snapshot): calling a selector again on the same view returns
 * the same instance, which keeps `useView` results stable and spares React needless renders.
 * Results are shared between callers and must not be mutated, hence the readonly types.
 */
import {
  compareByPosition,
  comparePositions,
  type Level,
  type Property,
  type Snapshot,
  type Space,
} from "@repo/shared";

/** A property of the list, with the size of its (non-deleted) structure. */
export interface PropertySummary {
  readonly property: Property;
  readonly levelCount: number;
  /** Spaces of non-deleted levels: a deleted level hides its spaces. */
  readonly spaceCount: number;
}

/** A level of a property with its spaces, both in display order. */
export interface LevelStructure {
  readonly level: Level;
  readonly spaces: readonly Space[];
}

const propertiesCache = new WeakMap<Snapshot, readonly PropertySummary[]>();
const structureCache = new WeakMap<Snapshot, Map<string, readonly LevelStructure[]>>();

/**
 * Non-deleted properties, newest first (`createdAt` descending, then id descending: ids are
 * UUIDv7, time-ordered, so the tie-break keeps "newest first" and is identical on every device).
 */
export function selectProperties(view: Snapshot): readonly PropertySummary[] {
  let summaries = propertiesCache.get(view);
  if (!summaries) {
    summaries = summarizeProperties(view);
    propertiesCache.set(view, summaries);
  }
  return summaries;
}

/** The property, or `undefined` when it does not exist or is deleted. */
export function selectProperty(view: Snapshot, id: string): Property | undefined {
  const property = view.properties.get(id);
  return property && property.deletedAt === null ? property : undefined;
}

/**
 * Non-deleted levels of a property in display order, each with its non-deleted spaces in display
 * order. Spaces of a deleted level are hidden with it.
 */
export function selectStructure(view: Snapshot, propertyId: string): readonly LevelStructure[] {
  let byProperty = structureCache.get(view);
  if (!byProperty) {
    byProperty = new Map();
    structureCache.set(view, byProperty);
  }
  let structure = byProperty.get(propertyId);
  if (!structure) {
    structure = buildStructure(view, propertyId);
    byProperty.set(propertyId, structure);
  }
  return structure;
}

function summarizeProperties(view: Snapshot): readonly PropertySummary[] {
  const summarize = summarizer(view);
  return [...view.properties.values()]
    .filter((property) => property.deletedAt === null)
    .sort((a, b) => b.createdAt - a.createdAt || comparePositions(b.id, a.id))
    .map(summarize);
}

function buildStructure(view: Snapshot, propertyId: string): readonly LevelStructure[] {
  const levels = [...view.levels.values()]
    .filter((level) => level.propertyId === propertyId && level.deletedAt === null)
    .sort(compareByPosition);
  const spacesByLevel = new Map<string, Space[]>(levels.map((level) => [level.id, []]));
  for (const space of view.spaces.values()) {
    if (space.deletedAt === null) spacesByLevel.get(space.levelId)?.push(space);
  }
  return levels.map((level) => ({
    level,
    spaces: (spacesByLevel.get(level.id) ?? []).sort(compareByPosition),
  }));
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Summarizes properties, deleted or not, with the structure they show (or would show again once
 * restored): their non-deleted levels and the non-deleted spaces of those.
 */
function summarizer(view: Snapshot): (property: Property) => PropertySummary {
  const levelCounts = new Map<string, number>();
  const propertyOfLiveLevel = new Map<string, string>();
  for (const level of view.levels.values()) {
    if (level.deletedAt !== null) continue;
    propertyOfLiveLevel.set(level.id, level.propertyId);
    increment(levelCounts, level.propertyId);
  }
  const spaceCounts = new Map<string, number>();
  for (const space of view.spaces.values()) {
    if (space.deletedAt !== null) continue;
    const propertyId = propertyOfLiveLevel.get(space.levelId);
    if (propertyId !== undefined) increment(spaceCounts, propertyId);
  }
  return (property) => ({
    property,
    levelCount: levelCounts.get(property.id) ?? 0,
    spaceCount: spaceCounts.get(property.id) ?? 0,
  });
}

// --- Deleted entities, which « Récemment supprimés » offers to restore ---------------------------

/** A deleted property, with the structure restoring it brings back: deleting it left it as is. */
export interface DeletedPropertySummary extends PropertySummary {
  readonly deletedAt: number;
}

/** A deleted level, with the spaces it hides: deleting it left them as they were. */
export interface DeletedLevel {
  readonly level: Level;
  readonly deletedAt: number;
  /** Its non-deleted spaces, which restoring it brings back. */
  readonly spaceCount: number;
}

/** A deleted space of a non-deleted level. */
export interface DeletedSpace {
  readonly space: Space;
  readonly deletedAt: number;
  readonly level: Level;
}

/** What a property's deleted levels and spaces are, last deleted first. */
export interface DeletedStructure {
  readonly levels: readonly DeletedLevel[];
  readonly spaces: readonly DeletedSpace[];
}

const deletedPropertiesCache = new WeakMap<Snapshot, readonly DeletedPropertySummary[]>();
const deletedStructureCache = new WeakMap<Snapshot, Map<string, DeletedStructure>>();

/** Deleted properties, last deleted first, counted like `selectProperties` counts live ones. */
export function selectDeletedProperties(view: Snapshot): readonly DeletedPropertySummary[] {
  let deleted = deletedPropertiesCache.get(view);
  if (!deleted) {
    const summarize = summarizer(view);
    deleted = lastDeletedFirst(
      [...view.properties.values()].flatMap((property) =>
        property.deletedAt === null
          ? []
          : [{ ...summarize(property), deletedAt: property.deletedAt }],
      ),
      (entry) => entry.property.id,
    );
    deletedPropertiesCache.set(view, deleted);
  }
  return deleted;
}

/**
 * A property's deleted levels, and the deleted spaces of its non-deleted levels, last deleted
 * first. The spaces of a deleted level are left out: restoring one would revive the level with
 * all its spaces (`restoreSpace` revives its parents), and they are listed again once it is back.
 */
export function selectDeletedStructure(view: Snapshot, propertyId: string): DeletedStructure {
  let byProperty = deletedStructureCache.get(view);
  if (!byProperty) {
    byProperty = new Map();
    deletedStructureCache.set(view, byProperty);
  }
  let deleted = byProperty.get(propertyId);
  if (!deleted) {
    deleted = buildDeletedStructure(view, propertyId);
    byProperty.set(propertyId, deleted);
  }
  return deleted;
}

function buildDeletedStructure(view: Snapshot, propertyId: string): DeletedStructure {
  const levels = new Map<string, Level>();
  for (const level of view.levels.values()) {
    if (level.propertyId === propertyId) levels.set(level.id, level);
  }
  const liveSpaceCounts = new Map<string, number>();
  const spaces: DeletedSpace[] = [];
  for (const space of view.spaces.values()) {
    const level = levels.get(space.levelId);
    if (!level) continue;
    if (space.deletedAt === null) increment(liveSpaceCounts, level.id);
    else if (level.deletedAt === null) spaces.push({ space, deletedAt: space.deletedAt, level });
  }
  const deletedLevels = [...levels.values()].flatMap((level) =>
    level.deletedAt === null
      ? []
      : [{ level, deletedAt: level.deletedAt, spaceCount: liveSpaceCounts.get(level.id) ?? 0 }],
  );
  return {
    levels: lastDeletedFirst(deletedLevels, (entry) => entry.level.id),
    spaces: lastDeletedFirst(spaces, (entry) => entry.space.id),
  };
}

/** Sorts in place, last deleted first; equal times by id, descending, identically everywhere. */
function lastDeletedFirst<T extends { readonly deletedAt: number }>(
  entries: T[],
  id: (entry: T) => string,
): T[] {
  return entries.sort((a, b) => b.deletedAt - a.deletedAt || comparePositions(id(b), id(a)));
}
