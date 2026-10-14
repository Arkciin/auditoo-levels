import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { suggestLevelNames } from "@/lib/suggestions";
import { selectStructure, useView } from "@/sync";
import { useAddLevel } from "./use-add-level";

/** Bottom sheet to add a level: the likely next names in one tap, or any custom name. */
export function AddLevelDrawer({
  propertyId,
  open,
  onOpenChange,
  onCreated,
}: {
  propertyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (levelId: string) => void;
}) {
  const structure = useView((view) => selectStructure(view, propertyId));
  const suggestions = useMemo(
    () => suggestLevelNames(structure.map((group) => group.level.name)),
    [structure],
  );
  const addLevel = useAddLevel(propertyId);

  async function add(name: string) {
    const id = await addLevel(name);
    if (!id) return;
    onOpenChange(false);
    onCreated(id);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Ajouter un niveau</DrawerTitle>
          <DrawerDescription>Touchez une suggestion ou saisissez un autre nom.</DrawerDescription>
        </DrawerHeader>
        <div className="grid grid-cols-2 gap-2 px-4">
          {suggestions.map((name) => (
            <Button key={name} variant="outline" size="lg" onClick={() => void add(name)}>
              {name}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = String(new FormData(form).get("name") ?? "").trim();
            if (!name) return;
            form.reset();
            void add(name);
          }}
        >
          <Input
            name="name"
            aria-label="Nom du niveau"
            placeholder="Autre nom : Mezzanine…"
            autoComplete="off"
            enterKeyHint="done"
            maxLength={80}
          />
          <Button type="submit">Ajouter</Button>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
