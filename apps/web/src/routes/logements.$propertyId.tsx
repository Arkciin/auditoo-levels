import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/logements/$propertyId")({
  component: PropertyScreen,
});

// Placeholder: the levels and spaces of the logement arrive with the data layer.
function PropertyScreen() {
  const { propertyId } = Route.useParams();

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-rule bg-background pt-safe">
        <div className="flex h-14 items-center gap-1 px-1">
          <Button asChild variant="ghost" size="icon">
            <Link to="/" aria-label="Retour aux logements">
              <ArrowLeftIcon />
            </Link>
          </Button>
          <h1 className="truncate text-xl font-semibold">Logement</h1>
        </div>
      </header>
      <main className="flex-1 px-4 py-6">
        <p className="break-all text-muted-foreground">Identifiant&nbsp;: {propertyId}</p>
      </main>
    </>
  );
}
