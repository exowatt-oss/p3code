import { createFileRoute } from "@tanstack/react-router";

import { ExowattCustomizeMcpPage } from "../components/exowatt-customize/ExowattCustomizeMcpPage";

export const Route = createFileRoute("/_chat/settings/customize/mcp")({
  component: ExowattCustomizeMcpPage,
});
