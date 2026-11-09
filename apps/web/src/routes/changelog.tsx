import { createFileRoute } from "@tanstack/react-router";

import { ExowattChangelogPage } from "../components/exowatt/ExowattChangelogPage";

export const Route = createFileRoute("/changelog")({
  component: ExowattChangelogPage,
});
