import type { Property } from "@repo/shared";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArchiveRestore, ArrowLeft, EllipsisVertical, Pencil, Plus, Trash } from "lucide-react";
import { type MouseEvent, useCallback, useRef, useState } from "react";

import {
  ActionBar,
  AppHeader,
  CompactTitle,
  ScreenBody,
  useLargeTitle,
} from "@/components/app-layout";
import { DatumMarker } from "@/components/datum-marker";
import { EditableText } from "@/components/editable-text";
import { Button } from "@/components/ui/button";
import { useOpenedOnce } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { quote, toastUndo, useSafeMutate } from "@/features/use-safe-mutate";
import { levelsAndRooms, suggestLevelNames } from "@/lib/suggestions";
import { selectProperty, selectStructure, useSyncClient, useSyncStatus, useView } from "@/sync";
import { AddLevelDrawer } from "./add-level-drawer";
import { DeletedItemsSheet } from "./deleted-items-sheet";
import { StructureBoard } from "./structure-board";
import { useAddLevel } from "./use-add-level";

/** A logement's structure: its levels, each with its rooms. */
export function StructureScreen({ propertyId }: { propertyId: string }) {
  const liveProperty = useView((view) => selectProperty(view, propertyId));
  const structure = useView((view) => selectStructure(view, propertyId));
  const status = useSyncStatus();
  const client = useSyncClient();
  const router = useRouter();
  const safeMutate = useSafeMutate();
  const addLevel = useAddLevel(propertyId);
  const [addingLevel, setAddingLevel] = useState(false);
  const [autoAddLevelId, setAutoAddLevelId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  /**
   * The logement as it was when deleted from this screen: it stays on screen until the list takes
   * its place, rather than « Logement introuvable » flashing in between.
   */
  const [leaving, setLeaving] = useState<Property | null>(null);
  const [deletedSheet, setDeletedSheet] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** What takes over once the menu has closed: the rename field, or the deleted items' sheet. */
  const afterMenu = useRef<"rename" | "deleted" | null>(null);
  const clearAutoAdd = useCallback(() => setAutoAddLevelId(null), []);
  const addLevelMounted = useOpenedOnce(addingLevel);
  const deletedSheetMounted = useOpenedOnce(deletedSheet);
  const { headerRef, titleRef, titleUnderHeader } = useLargeTitle();
  const property = liveProperty ?? leaving;

  if (!property) {
    // On a fresh device the logement may simply not have arrived yet.
    const loading = status.lastSyncedAt === null && status.connection === "online";
    return <MissingProperty loading={loading} />;
  }

  const propertyName = property.name;
  const spaceCount = structure.reduce((count, group) => count + group.spaces.length, 0);

  async function rename(name: string) {
    if (!(await safeMutate("renameProperty", { id: propertyId, name })))
      throw new Error("not saved");
  }

  async function remove(shown: Property) {
    setLeaving(shown);
    if (!(await safeMutate("deleteProperty", { id: propertyId }))) {
      setLeaving(null);
      return;
    }
    // In its place, not on top of it: the system back button must not lead to a deleted logement.
    // A replace, unlike going back, stays within this document whatever the history holds (after
    // a reload, the list's entry belongs to the previous one), so the undo toast survives it.
    await router.navigate({ to: "/", replace: true });
    toastUndo(`Logement ${quote(propertyName)} supprimé`, () => {
      void safeMutate("restoreProperty", { id: propertyId });
    });
  }

  async function quickAdd(name: string) {
    const id = await addLevel(name);
    if (id) setAutoAddLevelId(id);
  }

  return (
    <>
      <AppHeader
        ref={headerRef}
        leading={<BackToList />}
        title={<CompactTitle shown={titleUnderHeader}>{property.name}</CompactTitle>}
        actions={
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Actions du logement">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // The rename field keeps the focus it just received; the sheet only opens now
                // that the menu has let go of the focus (see SpaceRow).
                const next = afterMenu.current;
                afterMenu.current = null;
                if (next === null) return;
                event.preventDefault();
                if (next === "deleted") setDeletedSheet(true);
              }}
            >
              <DropdownMenuItem
                onSelect={(event) => {
                  // The menu closes in the same render as the field opens, so that it has let go
                  // of the focus when the field takes it: Radix would close it after this
                  // handler, and its focus trap would pull the focus back from the field.
                  event.preventDefault();
                  afterMenu.current = "rename";
                  setMenuOpen(false);
                  setRenaming(true);
                }}
              >
                <Pencil />
                Renommer le logement
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  afterMenu.current = "deleted";
                }}
              >
                <ArchiveRestore />
                Éléments supprimés
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(property)}>
                <Trash />
                Supprimer le logement
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <ScreenBody>
        {/* The name in full, however long (an address often is): too long for the header. */}
        <div className="px-4 pt-3">
          <h1 ref={titleRef} className="text-2xl font-bold">
            <EditableText
              value={property.name}
              label="Nom du logement"
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={rename}
              canSaveOnUnmount={() => !!selectProperty(client.getState().view, property.id)}
              // `text-clip` replaces the truncation of EditableText's button: the name wraps.
              className="block min-h-11 w-full text-clip whitespace-normal break-words"
              inputClassName="h-12 text-2xl font-bold"
            />
          </h1>
          {/* Without levels, the empty state below says « Aucun niveau » already. */}
          {structure.length > 0 ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {levelsAndRooms(structure.length, spaceCount)}
            </p>
          ) : null}
        </div>
        {structure.length === 0 ? (
          <NoLevels onPick={(name) => void quickAdd(name)} onOther={() => setAddingLevel(true)} />
        ) : (
          <StructureBoard
            propertyId={propertyId}
            structure={structure}
            autoAddLevelId={autoAddLevelId}
            onAutoAddHandled={clearAutoAdd}
          />
        )}
      </ScreenBody>
      <ActionBar>
        <Button size="lg" className="w-full" onClick={() => setAddingLevel(true)}>
          <Plus aria-hidden="true" />
          Ajouter un niveau
        </Button>
      </ActionBar>
      {addLevelMounted ? (
        <AddLevelDrawer
          propertyId={propertyId}
          open={addingLevel}
          onOpenChange={setAddingLevel}
          onCreated={setAutoAddLevelId}
        />
      ) : null}
      {deletedSheetMounted ? (
        <DeletedItemsSheet
          propertyId={propertyId}
          open={deletedSheet}
          onOpenChange={setDeletedSheet}
        />
      ) : null}
    </>
  );
}

function NoLevels({ onPick, onOther }: { onPick: (name: string) => void; onOther: () => void }) {
  return (
    <div className="flex flex-col gap-5 px-4 pt-8">
      <div className="border-b-[1.5px] border-foreground pb-1">
        <DatumMarker className="h-4.5 w-6" />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">Aucun niveau pour l’instant</h2>
        <p className="text-muted-foreground">
          Commencez par le niveau d’entrée, puis ajoutez ses pièces.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {suggestLevelNames([]).map((name) => (
          <Button key={name} variant="outline" size="lg" onClick={() => onPick(name)}>
            {name}
          </Button>
        ))}
      </div>
      <Button variant="link" className="self-start px-0" onClick={onOther}>
        Autre nom
      </Button>
    </div>
  );
}

function MissingProperty({ loading }: { loading: boolean }) {
  const leaveToList = useLeaveToList();
  return (
    <>
      <AppHeader
        leading={<BackToList />}
        title={<h1 className="truncate text-lg font-bold">Logement</h1>}
      />
      <main className="flex flex-1 flex-col gap-4 px-4 py-10">
        {loading ? (
          <p className="text-muted-foreground">Récupération du logement…</p>
        ) : (
          <>
            <h2 className="text-xl font-bold">Logement introuvable</h2>
            <p className="text-muted-foreground">
              Il a peut-être été supprimé, ou n’a pas encore été synchronisé sur cet appareil.
            </p>
            <Button asChild size="lg" className="self-start">
              <Link to="/" onClick={(event) => leaveOnPlainClick(event, leaveToList)}>
                Retour aux logements
              </Link>
            </Button>
          </>
        )}
      </main>
    </>
  );
}

/**
 * Leaves a logement for the list without stacking a history entry, so that the system back button
 * then leaves the list rather than reopening the logement. Within the app, a logement is only ever
 * opened from the list: an earlier entry of the app's history is the list, and going back to it
 * takes the logement off the stack, as the system back button would. Without one (a link opened
 * from elsewhere, a new tab), the list replaces the logement.
 */
function useLeaveToList(): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return useCallback(() => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/", replace: true });
  }, [router, canGoBack]);
}

/** A link's plain click leaves with `leave`; a modified one (new tab…) keeps the link's way. */
function leaveOnPlainClick(event: MouseEvent, leave: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  leave();
}

/** The header's back arrow: a real link to the list, which leaves the way `useLeaveToList` says. */
function BackToList() {
  const leaveToList = useLeaveToList();
  return (
    <Button asChild variant="ghost" size="icon">
      <Link
        to="/"
        aria-label="Retour aux logements"
        onClick={(event) => leaveOnPlainClick(event, leaveToList)}
      >
        <ArrowLeft />
      </Link>
    </Button>
  );
}
