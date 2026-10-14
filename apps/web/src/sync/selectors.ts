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
  return [...view.properties.values()]
    .filter((property) => property.deletedAt === null)
    .sort((a, b) => b.createdAt - a.createdAt || comparePositions(b.id, a.id))
    .map((property) => ({
      property,
      levelCount: levelCounts.get(property.id) ?? 0,
      spaceCount: spaceCounts.get(property.id) ?? 0,
    }));
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
