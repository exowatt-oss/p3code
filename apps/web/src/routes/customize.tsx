import { createFileRoute, redirect } from "@tanstack/react-router";

import type { ExowattCustomizePath } from "../components/exowatt-customize/ExowattCustomizeLayout";

const CUSTOMIZE_SUBPAGES: Readonly<Record<string, ExowattCustomizePath>> = {
  pets: "/settings/customize/pets",
  mcp: "/settings/customize/mcp",
  skills: "/settings/customize/skills",
  plugins: "/settings/customize/plugins",
  extensions: "/settings/customize/extensions",
};

// exowatt: Customize moved into Settings; old /customize/* links land on the same page there.
export const Route = createFileRoute("/customize")({
  beforeLoad: ({ location }) => {
    const subpage = location.pathname.split("/")[2] ?? "";
    throw redirect({ to: CUSTOMIZE_SUBPAGES[subpage] ?? "/settings/customize", replace: true });
  },
});
