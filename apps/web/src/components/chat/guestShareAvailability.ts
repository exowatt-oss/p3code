import { type EnvironmentId, managedCapabilityDenial } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

const EXOWATT_GUEST_SHARING_AVAILABLE: boolean = false;

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Labs). The server refuses links while the beta is off.
 * Guests arrive through T3 Connect, so a policy that turns Connect off hides sharing too.
 */
export const canShareWithGuestAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const serverConfig = get(environmentPresentations.serverConfigsAtom).get(environmentId);
    return (
      // exowatt: guest sharing stays off in P3 (plan D4); this hides the menu, palette and header entries.
      EXOWATT_GUEST_SHARING_AVAILABLE &&
      get(serverEnvironment.createGuestShare.permissionAtom(environmentId)) &&
      serverConfig?.settings.guestSharingEnabled === true &&
      managedCapabilityDenial(serverConfig.managedPolicy, "connect") === undefined
    );
  }).pipe(Atom.withLabel(`guest-share:available:${environmentId}`)),
);
