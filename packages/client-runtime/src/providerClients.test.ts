import { ProviderDriverKind } from "@t3tools/contracts";
import { phiIcon, piClient } from "@t3tools/provider-pi/client";
import { describe, expect, it } from "vite-plus/test";

import { providerClients } from "./providerClients.ts";

// exowatt: Phi is registered beside upstream Pi with its own φ icon.
describe("providerClients icons", () => {
  it("gives Phi its own φ icon and keeps Pi's icon for upstream Pi", () => {
    expect(providerClients.get(ProviderDriverKind.make("phi"))?.icon).toBe(phiIcon);
    expect(providerClients.get(ProviderDriverKind.make("pi"))?.icon).toBe(piClient.icon);
  });
});
