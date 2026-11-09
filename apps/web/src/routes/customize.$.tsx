import { createFileRoute } from "@tanstack/react-router";

// Matches /customize/<anything> so the parent's redirect runs for every old link.
export const Route = createFileRoute("/customize/$")({});
