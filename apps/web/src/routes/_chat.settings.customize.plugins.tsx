import { createFileRoute } from "@tanstack/react-router";

import { ExowattCustomizeCategoryPlaceholder } from "../components/exowatt-customize/ExowattCustomizeCategoryPlaceholder";

export const Route = createFileRoute("/_chat/settings/customize/plugins")({
  component: () => <ExowattCustomizeCategoryPlaceholder category="Plugins" />,
});
