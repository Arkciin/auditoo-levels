import { createFileRoute } from "@tanstack/react-router";

import { PropertiesScreen } from "@/features/properties/properties-screen";

export const Route = createFileRoute("/")({
  component: PropertiesScreen,
});
