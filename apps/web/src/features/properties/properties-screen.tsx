import { NAME_MAX_LENGTH, newId, type Property } from "@repo/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ChevronRight,
  Download,
  EllipsisVertical,
  Plus,
  Sparkles,
  Trash,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ActionBar, AppHeader, ScreenBody } from "@/components/app-layout";
import { DatumMarker } from "@/components/datum-marker";
import { SwipeToDelete } from "@/components/swipe-to-delete";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  useOpenedOnce,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { quote, toastUndo, useSafeMutate } from "@/features/use-safe-mutate";
import { promptInstall, useInstallOffer } from "@/install";
import { levelsAndRooms } from "@/lib/suggestions";
import {
  describeMutationError,
  type PropertySummary,
  selectProperties,
  useMutate,
  useSyncStatus,
  useView,
} from "@/sync";
import { DeletedPropertiesSheet } from "./deleted-properties-sheet";
import { createExampleProperty } from "./example-property";
import { InstallSheet } from "./install-sheet";

/** Home: every logement on this device, newest first. */
export function PropertiesScreen() {
  const properties = useView(selectProperties);
  const status = useSyncStatus();
  const mutate = useMutate();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const install = useInstallOffer();
  const [installSheet, setInstallSheet] = useState(false);
  const [deletedSheet, setDeletedSheet] = useState(false);
  /** The sheet to open once the menu has closed: the iOS instructions, or deleted logements. */
  const sheetAfterMenu = useRef<"install" | "deleted" | null>(null);
  const newPropertyMounted = useOpenedOnce(creating);
  const installSheetMounted = useOpenedOnce(installSheet);
  const deletedSheetMounted = useOpenedOnce(deletedSheet);

  const openProperty = (propertyId: string) =>
    navigate({ to: "/logements/$propertyId", params: { propertyId } });

  async function createExample() {
    try {
      await openProperty(await createExampleProperty(mutate));
    } catch (error) {
      toast.error(describeMutationError(error));
    }
  }

  const firstLoad = status.lastSyncedAt === null && status.phase === "syncing";

  return (
    <>
      <AppHeader
        title={<h1 className="truncate text-xl font-bold">Logements</h1>}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Plus d’actions">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // A sheet opens once the menu has let go of the focus (see SpaceRow).
                const sheet = sheetAfterMenu.current;
                if (sheet === null) return;
                sheetAfterMenu.current = null;
                event.preventDefault();
                if (sheet === "install") setInstallSheet(true);
                else setDeletedSheet(true);
              }}
            >
              {install ? (
                <DropdownMenuItem
                  onSelect={() => {
                    if (install === "ios") sheetAfterMenu.current = "install";
                    else void promptInstall();
                  }}
                >
                  <Download />
                  Installer l’application
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void createExample()}>
                <Sparkles />
                Ajouter un logement d’exemple
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  sheetAfterMenu.current = "deleted";
                }}
              >
                <ArchiveRestore />
                Logements supprimés
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <ScreenBody>
        {properties.length > 0 ? (
          <ul aria-label="Logements">
            {properties.map((summary) => (
              <PropertyRow key={summary.property.id} summary={summary} />
            ))}
          </ul>
        ) : firstLoad ? (
          <p className="px-4 py-10 text-center text-muted-foreground">
            Récupération des logements…
          </p>
        ) : (
          <EmptyState onCreate={() => setCreating(true)} onExample={() => void createExample()} />
        )}
      </ScreenBody>
      <ActionBar>
        <Button size="lg" className="w-full" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          Nouveau logement
        </Button>
      </ActionBar>
      {newPropertyMounted ? (
        <NewPropertyDrawer open={creating} onOpenChange={setCreating} onCreated={openProperty} />
      ) : null}
      {installSheetMounted ? (
        <InstallSheet open={installSheet} onOpenChange={setInstallSheet} />
      ) : null}
      {deletedSheetMounted ? (
        <DeletedPropertiesSheet open={deletedSheet} onOpenChange={setDeletedSheet} />
      ) : null}
    </>
  );
}

function PropertyRow({ summary }: { summary: PropertySummary }) {
  const { property, levelCount, spaceCount } = summary;
  const safeMutate = useSafeMutate();

  async function remove() {
    if (await safeMutate("deleteProperty", { id: property.id })) {
      toastUndo(`Logement ${quote(property.name)} supprimé`, () => {
        void safeMutate("restoreProperty", { id: property.id });
      });
    }
  }

  return (
    <li>
      <SwipeToDelete onDelete={() => void remove()}>
        <div className="flex items-center border-b border-rule">
          <Link
            to="/logements/$propertyId"
            params={{ propertyId: property.id }}
            className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 outline-offset-[-2px]"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{property.name}</p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {levelsAndRooms(levelCount, spaceCount)}
              </p>
            </div>
            <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          </Link>
          <DeleteButton property={property} onDelete={() => void remove()} />
        </div>
      </SwipeToDelete>
    </li>
  );
}

/** Mouse and keyboard alternative to swiping; touch screens use the swipe. */
function DeleteButton({ property, onDelete }: { property: Property; onDelete: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="mr-1 hidden text-muted-foreground pointer-fine:inline-flex"
      aria-label={`Supprimer ${property.name}`}
      onClick={onDelete}
    >
      <Trash />
    </Button>
  );
}

function EmptyState({ onCreate, onExample }: { onCreate: () => void; onExample: () => void }) {
  return (
    <div className="flex flex-col items-start gap-6 px-4 pt-12">
      <div className="w-full border-b-[1.5px] border-foreground pb-1">
        <DatumMarker className="h-4.5 w-6" />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">Aucun logement pour l’instant</h2>
        <p className="text-muted-foreground">
          Créez un logement, puis décrivez ses niveaux et ses pièces. Tout fonctionne sans réseau.
        </p>
      </div>
      <div className="flex w-full flex-col gap-3">
        <Button size="lg" onClick={onCreate}>
          <Plus aria-hidden="true" />
          Nouveau logement
        </Button>
        <Button size="lg" variant="outline" onClick={onExample}>
          <Sparkles aria-hidden="true" />
          Essayer avec un exemple
        </Button>
      </div>
    </div>
  );
}

function NewPropertyDrawer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (propertyId: string) => void;
}) {
  const safeMutate = useSafeMutate();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) return;
    const id = newId();
    if (await safeMutate("createProperty", { id, name })) {
      form.reset();
      onOpenChange(false);
      onCreated(id);
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <form onSubmit={(event) => void submit(event)}>
          <DrawerHeader>
            <DrawerTitle>Nouveau logement</DrawerTitle>
            <DrawerDescription>
              L’adresse suffit, vous pourrez la modifier ensuite.
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4">
            <Input
              name="name"
              aria-label="Adresse ou nom du logement"
              placeholder="12 rue des Lilas, Lyon"
              autoComplete="off"
              enterKeyHint="done"
              maxLength={NAME_MAX_LENGTH}
              required
              autoFocus
            />
          </div>
          <DrawerFooter>
            <Button type="submit" size="lg">
              Créer le logement
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
