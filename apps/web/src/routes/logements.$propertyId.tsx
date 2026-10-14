import { createFileRoute } from "@tanstack/react-router";

import { StructureScreen } from "@/features/structure/structure-screen";

export const Route = createFileRoute("/logements/$propertyId")({
  component: PropertyRoute,
});

function PropertyRoute() {
  const { propertyId } = Route.useParams();
  // Keyed so that switching logements resets all local UI state (drag, open inputs…).
  return <StructureScreen key={propertyId} propertyId={propertyId} />;
}
