import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/pets")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/customize/pets", replace: true });
  },
});
