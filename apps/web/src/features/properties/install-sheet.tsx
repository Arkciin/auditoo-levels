import { type LucideIcon, Share, SquarePlus } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

/**
 * How to install Relevé on an iPhone or an iPad, where no browser prompt exists, and why it is
 * worth it there: iOS keeps the data of installed apps.
 */
export function InstallSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Installer Relevé</DrawerTitle>
          <DrawerDescription>
            Sur iPhone et iPad, l’installation passe par le menu Partager de Safari.
          </DrawerDescription>
        </DrawerHeader>
        <ol className="px-4">
          <Step number={1} icon={Share}>
            Touchez <strong>Partager</strong>, dans la barre de Safari ou dans son menu « ••• ».
          </Step>
          <Step number={2} icon={SquarePlus}>
            Choisissez <strong>Sur l’écran d’accueil</strong>.
          </Step>
          <Step number={3}>
            Touchez <strong>Ajouter</strong>.
          </Step>
        </ol>
        <section aria-labelledby="install-why" className="mx-4 mt-2 border-t border-rule pt-4">
          <h3 id="install-why" className="font-semibold">
            Pourquoi l’installer ?
          </h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>Relevé s’ouvre instantanément depuis son icône, même sans réseau.</li>
            <li>
              iOS conserve les données des applications installées. Dans Safari, celles d’un site
              inutilisé quelques jours peuvent être effacées, modifications pas encore envoyées
              comprises.
            </li>
          </ul>
        </section>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button size="lg">Compris</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Step({
  number,
  icon: Icon,
  children,
}: {
  number: number;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-rule py-3 last:border-b-0">
      {/* The list already tells the order to screen readers. */}
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-input text-sm font-bold tabular-nums"
      >
        {number}
      </span>
      <p className="flex-1">{children}</p>
      {Icon ? <Icon aria-hidden="true" className="size-6 shrink-0 text-primary" /> : null}
    </li>
  );
}
