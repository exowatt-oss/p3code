import { Outlet, createFileRoute } from "@tanstack/react-router";

import { ExowattCustomizeLayout } from "../components/exowatt-customize/ExowattCustomizeLayout";

export const Route = createFileRoute("/_chat/settings/customize")({
  component: () => (
    <ExowattCustomizeLayout>
      <Outlet />
    </ExowattCustomizeLayout>
  ),
});
