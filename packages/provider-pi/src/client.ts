import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient, type ProviderIcon } from "@t3tools/provider-core/client";

import { PiSettings } from "./settings.ts";

export const piClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("pi"),
  label: "Pi",
  acpRegistryAgentIds: ["pi-acp"],
  settingsSchema: PiSettings,
  icon: {
    viewBox: "165.29 165.29 469.43 469.43",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
        fillRule: "evenodd",
      },
      { d: "M517.36 400H634.72V634.72H517.36Z" },
    ],
  },
});

// exowatt: Phi's own mark, a Greek phi built from the same 117.36-unit blocks as
// Pi's icon on a 5x6 grid, centred in a square viewBox. Pi keeps its icon above.
export const phiIcon: ProviderIcon = {
  viewBox: "-58.68 0 704.16 704.16",
  fill: piClient.icon.fill,
  paths: [
    {
      d: "M234.72 0H352.08V117.36H234.72ZM117.36 117.36H469.44V234.72H117.36ZM0 234.72H117.36V352.08H0ZM234.72 234.72H352.08V352.08H234.72ZM469.44 234.72H586.8V352.08H469.44ZM0 352.08H117.36V469.44H0ZM234.72 352.08H352.08V469.44H234.72ZM469.44 352.08H586.8V469.44H469.44ZM117.36 469.44H469.44V586.8H117.36ZM234.72 586.8H352.08V704.16H234.72Z",
    },
  ],
};
