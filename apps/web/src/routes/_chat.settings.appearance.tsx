import { createFileRoute, redirect } from "@tanstack/react-router";

// exowatt: Appearance lives in Settings › Customize; keep old links and search anchors working.
export const Route = createFileRoute("/_chat/settings/appearance")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/customize", hash: location.hash, replace: true });
  },
});
