import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: PropertiesScreen,
});

// Placeholder: the list of logements arrives with the data layer.
function PropertiesScreen() {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-rule bg-background pt-safe">
        <div className="flex h-14 items-center px-4">
          <h1 className="text-xl font-semibold">Logements</h1>
        </div>
      </header>
      <main className="flex-1 px-4 py-6">
        <p className="text-muted-foreground">Aucun logement pour l’instant.</p>
      </main>
    </>
  );
}
