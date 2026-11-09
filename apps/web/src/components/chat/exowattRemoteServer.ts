// Exowatt distro: renderer side of the loose-coupled P3 remote server flow
// (packages/ssh/src/exowattRemoteServer.ts): background-upgrade toasts and the
// dev-only "push the worktree's server to this host" action.
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  isExowattNoCompatibleRemoteServerError,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
  type ExowattPushDevServerResult,
  type ExowattRemoteServerEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export const EXOWATT_PUSH_DEV_SERVER_LABEL = "Push dev server to this host";

export interface ExowattPushDevServerAction {
  readonly target: DesktopSshEnvironmentTarget;
  readonly host: string;
  readonly push: () => Promise<ExowattPushDevServerResult>;
}

export function describeExowattSshTarget(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  return target.username ? `${target.username}@${destination}` : destination;
}

/**
 * Offered only in dev builds (the bridge exposes the method solely there in
 * practice, but the renderer's own dev flag gates it too) for SSH environments.
 */
export function resolveExowattPushDevServerAction(input: {
  readonly environment: Pick<EnvironmentPresentation, "entry"> | null;
  readonly bridge: Pick<DesktopBridge, "exowattPushDevServer"> | undefined;
  readonly isDevelopment: boolean;
}): ExowattPushDevServerAction | null {
  if (!input.isDevelopment) return null;
  const push = input.bridge?.exowattPushDevServer;
  if (push === undefined) return null;
  const profile = input.environment?.entry.profile;
  if (profile === undefined || Option.isNone(profile)) return null;
  if (profile.value._tag !== "SshConnectionProfile") return null;
  const target = profile.value.target;
  return { target, host: describeExowattSshTarget(target), push: () => push(target) };
}

/** The connection banner offers the push when the remote has nothing compatible. */
export function shouldOfferExowattPushDevServer(input: {
  readonly action: ExowattPushDevServerAction | null;
  readonly error: string | null | undefined;
}): boolean {
  return input.action !== null && isExowattNoCompatibleRemoteServerError(input.error);
}

export function describeExowattRemoteServerEvent(event: ExowattRemoteServerEvent): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
} {
  switch (event.type) {
    case "upgraded":
      return {
        type: "success",
        title: `Remote updated to ${event.version}`,
        description: `${event.host} was running ${event.previousVersion}; the new P3 server is installed and takes effect on the next reconnect.`,
      };
    case "upgrade-failed":
      return {
        type: "error",
        title: `Could not update the remote server on ${event.host}`,
        description: `${event.version}: ${event.message} The current server keeps working.`,
      };
  }
}
