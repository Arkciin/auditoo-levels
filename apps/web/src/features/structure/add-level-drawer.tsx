import { NAME_MAX_LENGTH } from "@repo/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  useHeldWhileClosing,
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
  // One level per opening: the sheet takes a moment to slide away, and a double tap would add
  // R+1, then R+2.
  const picked = useRef(false);
  useEffect(() => {
    if (open) picked.current = false;
  }, [open]);
  // And from the tap on, the suggestions hold still until the sheet opens again: the level just
  // added would turn « R+2 » into « R+3 » under the finger as the sheet slides away.
  const [picking, setPicking] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPicking(false);
  }
  const shown = useHeldWhileClosing(suggestions, open && !picking);

  async function add(name: string) {
    if (picked.current) return;
    picked.current = true;
    setPicking(true);
    const id = await addLevel(name);
    if (!id) {
      picked.current = false; // not saved, and the user was told why: let them try again
      setPicking(false);
      return;
    }
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
          {shown.map((name) => (
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
            if (!name || picked.current) return;
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
            maxLength={NAME_MAX_LENGTH}
          />
          <Button type="submit">Ajouter</Button>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
