/**
 * The levels and rooms of a property, reorderable by drag and drop (dnd-kit):
 * levels among themselves, rooms within a level, and rooms from one level to another.
 *
 * During a room drag, a local copy of the room order per level (`dragContainers`) follows the
 * pointer across levels; nothing is written until the drop. The drop then becomes ONE mutation
 * with a fractional position computed from the new neighbours, so a reorder is a single-row
 * change that syncs cleanly.
 */
import {
  type Active,
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  getFirstCollision,
  KeyboardSensor,
  MeasuringStrategy,
  type Over,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type Level, positionAtIndex, type Space } from "@repo/shared";
import {
  ArrowUpDown,
  Copy,
  EllipsisVertical,
  GripVertical,
  Pencil,
  Plus,
  Trash,
} from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DatumMarker } from "@/components/datum-marker";
import { EditableText } from "@/components/editable-text";
import { SwipeToDelete } from "@/components/swipe-to-delete";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { quote, toastUndo, useSafeMutate } from "@/features/use-safe-mutate";
import { haptic } from "@/lib/haptics";
import { plural } from "@/lib/suggestions";
import { cn } from "@/lib/utils";
import type { LevelStructure } from "@/sync";
import { AddSpace } from "./add-space";
import { HighlightProvider, HighlightTint, scrollBehavior, useHighlight } from "./highlight";
import { MoveSpaceDrawer } from "./move-space-drawer";
import { useDuplicateLevel } from "./use-duplicate-level";

type Containers = Readonly<Record<string, readonly string[]>>;

interface DragData {
  type: "level" | "space";
  name: string;
}

const dragData = (entry: Active | Over | null) => entry?.data.current as DragData | undefined;

function findContainer(containers: Containers, id: string): string | undefined {
  if (id in containers) return id;
  return Object.keys(containers).find((levelId) => containers[levelId]?.includes(id));
}

export function StructureBoard({
  propertyId,
  structure,
  autoAddLevelId,
  onAutoAddHandled,
}: {
  propertyId: string;
  structure: readonly LevelStructure[];
  /** A level just created: open its room input and scroll to it. */
  autoAddLevelId: string | null;
  onAutoAddHandled: () => void;
}) {
  const safeMutate = useSafeMutate();
  const [active, setActive] = useState<{ id: string; type: DragData["type"] } | null>(null);
  const [dragContainers, setDragContainers] = useState<Containers | null>(null);
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewContainer = useRef(false);
  // One « Déplacer vers… » sheet for every room; the room stays set while the sheet closes.
  const [move, setMove] = useState<{ space: Space; open: boolean } | null>(null);
  const openMoveSheet = useCallback((space: Space) => setMove({ space, open: true }), []);

  const levels = useMemo(() => structure.map((group) => group.level), [structure]);
  const levelIds = useMemo(() => levels.map((level) => level.id), [levels]);
  const spacesById = useMemo(
    () => new Map(structure.flatMap((group) => group.spaces.map((s) => [s.id, s] as const))),
    [structure],
  );
  const committed = useMemo<Containers>(
    () =>
      Object.fromEntries(structure.map((group) => [group.level.id, group.spaces.map((s) => s.id)])),
    [structure],
  );
  const containers = dragContainers ?? committed;

  useEffect(() => {
    // Reset once the browser has painted the room in its new level (see collisionDetection).
    const frame = requestAnimationFrame(() => {
      movedToNewContainer.current = false;
    });
    return () => cancelAnimationFrame(frame);
  });

  const sensors = useSensors(
    // Handles have `touch-action: none`, so a few pixels are enough to tell a drag from a tap.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Adapted from dnd-kit's "multiple containers" recipe.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (active?.type === "level") {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) => c.id in containers),
        });
      }
      const pointerHits = pointerWithin(args);
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
      let overId = getFirstCollision(hits, "id");
      if (overId != null) {
        const rooms = containers[String(overId)];
        if (rooms && rooms.length > 0) {
          // Over a level that has rooms: aim at its closest room so the drop lands between rooms.
          overId =
            closestCenter({
              ...args,
              droppableContainers: args.droppableContainers.filter(
                (c) => c.id !== overId && rooms.includes(String(c.id)),
              ),
            })[0]?.id ?? overId;
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      // Right after a room changes level the layout shifts and nothing is under the pointer for
      // a frame: keep the previous target instead of flickering.
      if (movedToNewContainer.current) lastOverId.current = active?.id ?? null;
      return lastOverId.current != null ? [{ id: lastOverId.current }] : [];
    },
    [active, containers],
  );

  function handleDragStart({ active: dragged }: DragStartEvent) {
    const data = dragData(dragged);
    if (!data) return;
    setActive({ id: String(dragged.id), type: data.type });
    if (data.type === "space") setDragContainers(committed);
    haptic(8);
  }

  function handleDragOver({ active: dragged, over }: DragOverEvent) {
    if (!over || dragData(dragged)?.type !== "space") return;
    const activeId = String(dragged.id);
    const overId = String(over.id);
    setDragContainers((previous) => {
      const current = previous ?? committed;
      const from = findContainer(current, activeId);
      const to = findContainer(current, overId);
      if (!from || !to || from === to) return previous;
      const target = current[to] ?? [];
      let index = target.length; // dropped on the level itself: at the end
      if (!(overId in current)) {
        const overIndex = target.indexOf(overId);
        const translated = dragged.rect.current.translated;
        const below = translated !== null && translated.top > over.rect.top + over.rect.height / 2;
        index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
      }
      movedToNewContainer.current = true;
      return {
        ...current,
        [from]: (current[from] ?? []).filter((id) => id !== activeId),
        [to]: [...target.slice(0, index), activeId, ...target.slice(index)],
      };
    });
  }

  async function handleDragEnd({ active: dragged, over }: DragEndEvent) {
    const activeId = String(dragged.id);
    const type = dragData(dragged)?.type;
    setActive(null);

    if (type === "level") {
      const from = levelIds.indexOf(activeId);
      const to = over ? levelIds.indexOf(String(over.id)) : -1;
      if (from >= 0 && to >= 0 && from !== to) {
        const siblings = arrayMove(levels, from, to).filter((level) => level.id !== activeId);
        if (
          await safeMutate("moveLevel", { id: activeId, position: positionAtIndex(siblings, to) })
        )
          haptic(8);
      }
      return;
    }

    const current = dragContainers ?? committed;
    const container = findContainer(current, activeId);
    const space = spacesById.get(activeId);
    if (over && container && space) {
      let ids = current[container] ?? [];
      const from = ids.indexOf(activeId);
      const to = ids.indexOf(String(over.id));
      if (to >= 0 && from !== to) ids = arrayMove([...ids], from, to);
      const index = ids.indexOf(activeId);
      const moved =
        space.levelId !== container || committed[container]?.indexOf(activeId) !== index;
      if (moved) {
        // Neighbours keep their committed relative order, so their positions are sorted.
        const siblings = ids
          .filter((id) => id !== activeId)
          .map((id) => spacesById.get(id))
          .filter((s): s is Space => s !== undefined);
        const position = positionAtIndex(siblings, index);
        if (await safeMutate("moveSpace", { id: activeId, levelId: container, position }))
          haptic(8);
      }
    }
    // Cleared after the mutation so the room does not jump back for a frame.
    setDragContainers(null);
  }

  function handleDragCancel() {
    setActive(null);
    setDragContainers(null);
  }

  return (
    <HighlightProvider>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={(event) => void handleDragEnd(event)}
        onDragCancel={handleDragCancel}
        accessibility={{ announcements, screenReaderInstructions }}
      >
        <SortableContext items={levelIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col">
            {levels.map((level) => (
              <LevelSection
                key={level.id}
                propertyId={propertyId}
                level={level}
                spaceIds={containers[level.id] ?? []}
                spacesById={spacesById}
                autoAdd={autoAddLevelId === level.id}
                onAutoAddHandled={onAutoAddHandled}
                onMoveSpace={levels.length > 1 ? openMoveSheet : undefined}
              />
            ))}
          </div>
        </SortableContext>
        {createPortal(
          <DragOverlay>
            {active ? (
              <DragPreview
                active={active}
                levels={levels}
                spacesById={spacesById}
                containers={containers}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <MoveSpaceDrawer
        propertyId={propertyId}
        space={move?.space ?? null}
        open={move?.open ?? false}
        onOpenChange={(open) => setMove((current) => current && { ...current, open })}
      />
    </HighlightProvider>
  );
}

/** « avec ses 3 pièces », « avec sa pièce », or nothing: how toasts mention a level's rooms. */
function withRooms(count: number): string {
  if (count === 0) return "";
  return count === 1 ? " avec sa pièce" : ` avec ses ${count} pièces`;
}

function LevelSection({
  propertyId,
  level,
  spaceIds,
  spacesById,
  autoAdd,
  onAutoAddHandled,
  onMoveSpace,
}: {
  propertyId: string;
  level: Level;
  spaceIds: readonly string[];
  spacesById: ReadonlyMap<string, Space>;
  autoAdd: boolean;
  onAutoAddHandled: () => void;
  /** Opens « Déplacer vers… »; undefined when there is no other level to move a room to. */
  onMoveSpace: ((space: Space) => void) | undefined;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: level.id,
    data: { type: "level", name: level.name } satisfies DragData,
  });
  const safeMutate = useSafeMutate();
  const duplicateLevel = useDuplicateLevel(propertyId);
  const highlight = useHighlight();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const focusRenameInput = useRef(false);
  const spaces = useMemo(
    () => spaceIds.map((id) => spacesById.get(id)).filter((s): s is Space => s !== undefined),
    [spaceIds, spacesById],
  );

  useEffect(() => {
    if (!autoAdd) return;
    setAdding(true);
    sectionRef.current?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    onAutoAddHandled();
  }, [autoAdd, onAutoAddHandled]);

  async function rename(name: string) {
    if (!(await safeMutate("renameLevel", { id: level.id, name }))) throw new Error("not saved");
  }

  async function remove() {
    if (!(await safeMutate("deleteLevel", { id: level.id }))) return;
    toastUndo(`Niveau ${quote(level.name)} supprimé${withRooms(spaces.length)}`, () => {
      void safeMutate("restoreLevel", { id: level.id });
    });
  }

  async function duplicate() {
    const copy = await duplicateLevel(level.id);
    if (!copy) return;
    haptic(8);
    // Its name first: a copy can be taller than the screen.
    highlight(copy.id, { reveal: "start" });
    const rooms = withRooms(copy.spaces.length);
    toastUndo(`Niveau ${quote(level.name)} dupliqué en ${quote(copy.name)}${rooms}`, () => {
      void safeMutate("deleteLevel", { id: copy.id });
    });
  }

  return (
    <section
      ref={(node) => {
        setNodeRef(node);
        sectionRef.current = node;
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`Niveau ${level.name}`}
      data-highlight-id={level.id}
      className={cn("relative scroll-mt-6 pt-5", isDragging && "opacity-40")}
    >
      <SwipeToDelete onDelete={() => void remove()} disabled={renaming}>
        {/* The floor line: the datum marker's apex rests on it, as on a building section. */}
        <div className="flex h-12 items-end gap-2 border-b-[1.5px] border-foreground pr-1 pl-4">
          <DatumMarker className="mb-px" />
          <div className="flex min-w-0 flex-1 items-baseline gap-2 pb-1.5">
            <h2 className="min-w-0">
              <EditableText
                value={level.name}
                label="Nom du niveau"
                editing={renaming}
                onEditingChange={setRenaming}
                onSave={rename}
                className="block max-w-full text-lg leading-tight font-bold"
                inputClassName="h-9 text-lg font-bold"
              />
            </h2>
            {renaming ? null : (
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {plural(spaces.length, "pièce", "pièces")}
              </span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions du niveau ${level.name}`}
                className="text-muted-foreground"
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // Let the rename field keep the focus it just received.
                if (focusRenameInput.current) event.preventDefault();
                focusRenameInput.current = false;
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  focusRenameInput.current = true;
                  setRenaming(true);
                }}
              >
                <Pencil />
                Renommer
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding(true)}>
                <Plus />
                Ajouter une pièce
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void duplicate()}>
                <Copy />
                Dupliquer le niveau
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash />
                Supprimer le niveau
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DragHandle
            ref={setActivatorNodeRef}
            label={`Déplacer le niveau ${level.name}`}
            {...attributes}
            {...listeners}
          />
        </div>
      </SwipeToDelete>
      <SortableContext items={[...spaceIds]} strategy={verticalListSortingStrategy}>
        <ul aria-label={`Pièces du niveau ${level.name}`}>
          {spaces.map((space) => (
            <SpaceRow key={space.id} space={space} onMove={onMoveSpace} />
          ))}
        </ul>
      </SortableContext>
      {/* An empty level shows no list to aim at: say that rooms can come from elsewhere too. */}
      {spaces.length === 0 && !adding && onMoveSpace ? (
        <p className="pt-3 pr-4 pl-10 text-sm text-muted-foreground">
          {"Aucune pièce\u00a0: ajoutez-en une, ou déplacez-en une ici."}
        </p>
      ) : null}
      <AddSpace
        propertyId={propertyId}
        level={level}
        spaces={spaces}
        open={adding}
        onOpenChange={setAdding}
      />
      {/* Last, so that it paints over the rows, which are positioned too. */}
      <HighlightTint id={level.id} className="top-5" />
    </section>
  );
}

function SpaceRow({
  space,
  onMove,
}: {
  space: Space;
  /** Opens « Déplacer vers… »; undefined when there is no other level. */
  onMove: ((space: Space) => void) | undefined;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: space.id,
    data: { type: "space", name: space.name } satisfies DragData,
  });
  const safeMutate = useSafeMutate();
  const [renaming, setRenaming] = useState(false);
  /** What to do once the menu has closed and let go of the focus. */
  const afterMenu = useRef<"rename" | "move" | null>(null);

  async function rename(name: string) {
    if (!(await safeMutate("renameSpace", { id: space.id, name }))) throw new Error("not saved");
  }

  async function remove() {
    if (!(await safeMutate("deleteSpace", { id: space.id }))) return;
    toastUndo(`Pièce ${quote(space.name)} supprimée`, () => {
      void safeMutate("restoreSpace", { id: space.id });
    });
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-highlight-id={space.id}
      className={cn("relative", isDragging && "z-10 opacity-40")}
    >
      <SwipeToDelete onDelete={() => void remove()} disabled={renaming}>
        {/* gap-2, as in the level header: the ⋮ buttons line up in one column. */}
        <div className="flex h-12 items-center gap-2 border-b border-rule pr-1 pl-10">
          <EditableText
            value={space.name}
            label="Nom de la pièce"
            editing={renaming}
            onEditingChange={setRenaming}
            onSave={rename}
            className="h-full flex-1"
            inputClassName="h-9"
          />
          {/* Every action without a gesture (keyboard, screen reader, one thumb): the menu. */}
          {renaming ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions de la pièce ${space.name}`}
                  className="text-muted-foreground"
                  data-no-swipe
                >
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  // The rename field or the sheet takes the focus, not the menu button. The sheet
                  // only opens now: a dialog opened while the menu still holds the focus can lose
                  // it, and close at once.
                  const next = afterMenu.current;
                  afterMenu.current = null;
                  if (next === null) return;
                  event.preventDefault();
                  if (next === "move") onMove?.(space);
                }}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    afterMenu.current = "rename";
                    setRenaming(true);
                  }}
                >
                  <Pencil />
                  Renommer
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={onMove === undefined}
                  onSelect={() => {
                    afterMenu.current = "move";
                  }}
                >
                  <ArrowUpDown />
                  Déplacer vers…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                  <Trash />
                  Supprimer la pièce
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DragHandle
            ref={setActivatorNodeRef}
            label={`Déplacer ${space.name}`}
            {...attributes}
            {...listeners}
          />
        </div>
      </SwipeToDelete>
      <HighlightTint id={space.id} />
    </li>
  );
}

/** The only place a drag can start: keeps taps (rename) and swipes (delete) unambiguous. */
function DragHandle({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-no-swipe
      className={cn(
        "flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground active:cursor-grabbing",
        className,
      )}
      {...props}
    >
      <GripVertical aria-hidden="true" className="size-5" />
    </button>
  );
}

function DragPreview({
  active,
  levels,
  spacesById,
  containers,
}: {
  active: { id: string; type: DragData["type"] };
  levels: readonly Level[];
  spacesById: ReadonlyMap<string, Space>;
  containers: Containers;
}) {
  if (active.type === "level") {
    const level = levels.find((candidate) => candidate.id === active.id);
    if (!level) return null;
    return (
      <div className="flex h-12 cursor-grabbing items-end gap-2 rounded-lg border-b-[1.5px] border-foreground bg-card pr-1 pl-4 shadow-drag">
        <DatumMarker className="mb-px" />
        <span className="flex-1 truncate pb-1.5 text-lg font-bold">{level.name}</span>
        <span className="pb-2 text-sm text-muted-foreground tabular-nums">
          {plural(containers[level.id]?.length ?? 0, "pièce", "pièces")}
        </span>
        <GripVertical aria-hidden="true" className="m-3 size-5 text-muted-foreground" />
      </div>
    );
  }
  const space = spacesById.get(active.id);
  if (!space) return null;
  return (
    <div className="flex h-12 cursor-grabbing items-center rounded-lg bg-card pr-1 pl-10 shadow-drag">
      <span className="flex-1 truncate">{space.name}</span>
      <GripVertical aria-hidden="true" className="m-3 size-5 text-muted-foreground" />
    </div>
  );
}

const nameOf = (entry: Active | Over | null) => quote(dragData(entry)?.name ?? "l’élément");

const announcements: Announcements = {
  onDragStart: ({ active }) => `${nameOf(active)} saisi.`,
  onDragOver: ({ active, over }) =>
    over ? `${nameOf(active)} près de ${nameOf(over)}.` : `${nameOf(active)} hors de la liste.`,
  onDragEnd: ({ active, over }) =>
    over ? `${nameOf(active)} déposé près de ${nameOf(over)}.` : `${nameOf(active)} relâché.`,
  onDragCancel: ({ active }) => `Déplacement de ${nameOf(active)} annulé.`,
};

const screenReaderInstructions = {
  draggable:
    "Pour déplacer cet élément, appuyez sur Espace ou Entrée, utilisez les flèches haut et bas, puis Espace ou Entrée pour le déposer. Échap annule.",
};
