import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, EllipsisVertical, Pencil, Plus, Trash } from "lucide-react";
import { useCallback, useRef, useState } from "react";

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
import { plural, suggestLevelNames } from "@/lib/suggestions";
import { selectProperty, selectStructure, useSyncStatus, useView } from "@/sync";
import { AddLevelDrawer } from "./add-level-drawer";
import { StructureBoard } from "./structure-board";
import { useAddLevel } from "./use-add-level";

/** A logement's structure: its levels, each with its rooms. */
export function StructureScreen({ propertyId }: { propertyId: string }) {
  const property = useView((view) => selectProperty(view, propertyId));
  const structure = useView((view) => selectStructure(view, propertyId));
  const status = useSyncStatus();
  const navigate = useNavigate();
  const safeMutate = useSafeMutate();
  const addLevel = useAddLevel(propertyId);
  const [addingLevel, setAddingLevel] = useState(false);
  const [autoAddLevelId, setAutoAddLevelId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const focusRenameInput = useRef(false);
  const clearAutoAdd = useCallback(() => setAutoAddLevelId(null), []);

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

  async function remove() {
    if (!(await safeMutate("deleteProperty", { id: propertyId }))) return;
    await navigate({ to: "/" });
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
        leading={
          <Button asChild variant="ghost" size="icon">
            <Link to="/" aria-label="Retour aux logements">
              <ArrowLeft />
            </Link>
          </Button>
        }
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
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash />
                Supprimer le logement
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <ScreenBody>
        <p className="px-4 pt-3 text-sm text-muted-foreground tabular-nums">
          {plural(structure.length, "niveau", "niveaux")}, {plural(spaceCount, "pièce", "pièces")}
        </p>
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
  return (
    <>
      <AppHeader
        leading={
          <Button asChild variant="ghost" size="icon">
            <Link to="/" aria-label="Retour aux logements">
              <ArrowLeft />
            </Link>
          </Button>
        }
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
              <Link to="/">Retour aux logements</Link>
            </Button>
          </>
        )}
      </main>
    </>
  );
}
