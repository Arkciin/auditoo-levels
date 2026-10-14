import type { Property } from "@repo/shared";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, EllipsisVertical, Pencil, Plus, Trash } from "lucide-react";
import { type MouseEvent, useCallback, useRef, useState } from "react";

import { ActionBar, AppHeader, ScreenBody } from "@/components/app-layout";
import { DatumMarker } from "@/components/datum-marker";
import { EditableText } from "@/components/editable-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { quote, toastUndo, useSafeMutate } from "@/features/use-safe-mutate";
import { levelsAndRooms, suggestLevelNames } from "@/lib/suggestions";
import { selectProperty, selectStructure, useSyncStatus, useView } from "@/sync";
import { AddLevelDrawer } from "./add-level-drawer";
import { StructureBoard } from "./structure-board";
import { useAddLevel } from "./use-add-level";

/** A logement's structure: its levels, each with its rooms. */
export function StructureScreen({ propertyId }: { propertyId: string }) {
  const liveProperty = useView((view) => selectProperty(view, propertyId));
  const structure = useView((view) => selectStructure(view, propertyId));
  const status = useSyncStatus();
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
  const focusRenameInput = useRef(false);
  const clearAutoAdd = useCallback(() => setAutoAddLevelId(null), []);
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
        leading={<BackToList />}
        title={
          <h1 className="min-w-0 flex-1">
            <EditableText
              value={property.name}
              label="Nom du logement"
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={rename}
              className="block max-w-full text-lg font-bold"
              inputClassName="h-10 text-lg font-bold"
            />
          </h1>
        }
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Actions du logement">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
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
                Renommer le logement
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
        {structure.length === 0 ? (
          // Its heading says « Aucun niveau » already: no summary above it.
          <NoLevels onPick={(name) => void quickAdd(name)} onOther={() => setAddingLevel(true)} />
        ) : (
          <>
            <p className="px-4 pt-3 text-sm text-muted-foreground tabular-nums">
              {levelsAndRooms(structure.length, spaceCount)}
            </p>
            <StructureBoard
              propertyId={propertyId}
              structure={structure}
              autoAddLevelId={autoAddLevelId}
              onAutoAddHandled={clearAutoAdd}
            />
          </>
        )}
      </ScreenBody>
      <ActionBar>
        <Button size="lg" className="w-full" onClick={() => setAddingLevel(true)}>
          <Plus aria-hidden="true" />
          Ajouter un niveau
        </Button>
      </ActionBar>
      <AddLevelDrawer
        propertyId={propertyId}
        open={addingLevel}
        onOpenChange={setAddingLevel}
        onCreated={setAutoAddLevelId}
      />
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
