import { createFileRoute } from "@tanstack/react-router";

import { P3PetsSettings } from "../components/exowatt-pets/P3PetsSettings";

export const Route = createFileRoute("/_chat/settings/customize/pets")({
  component: P3PetsSettings,
});
