import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";

export const Route = createFileRoute("/_chat/settings/customize/")({
  component: AppearanceSettingsPanel,
});
