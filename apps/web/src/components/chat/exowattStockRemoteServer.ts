// Exowatt distro: one-click remediation when an SSH remote still runs
// upstream's stock T3 Code server (packages/ssh/src/exowattRemoteServer.ts
// refuses to start the P3 server beside it and tags the error with
// EXOWATT_STOCK_REMOTE_SERVER_CODE).
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  isExowattStockRemoteServerError,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
  type ExowattRemoteStockServerStopResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export const EXOWATT_STOP_STOCK_REMOTE_SERVER_LABEL = "Stop the stock T3 server on this host";

export interface ExowattStockRemoteServerAction {
  readonly target: DesktopSshEnvironmentTarget;
  readonly stop: () => Promise<ExowattRemoteStockServerStopResult>;
}

/**
 * Offers the action only when every piece is present: the failure is the
 * stock-server refusal, the environment is an SSH remote (so we know which host
 * to reach), and the desktop bridge is a P3 build that exposes the IPC method.
 */
export function resolveExowattStockRemoteServerAction(input: {
  readonly environment: Pick<EnvironmentPresentation, "entry"> | null;
  readonly error: string | null | undefined;
  readonly bridge: Pick<DesktopBridge, "exowattStopRemoteStockServer"> | undefined;
}): ExowattStockRemoteServerAction | null {
  if (!isExowattStockRemoteServerError(input.error)) return null;
  const stop = input.bridge?.exowattStopRemoteStockServer;
  if (stop === undefined) return null;
  const profile = input.environment?.entry.profile;
  if (profile === undefined || Option.isNone(profile)) return null;
  if (profile.value._tag !== "SshConnectionProfile") return null;
  const target = profile.value.target;
  return { target, stop: () => stop(target) };
}

/** Toast copy after the remote reports what it stopped. */
export function describeExowattStockRemoteServerStop(
  result: ExowattRemoteStockServerStopResult,
): string {
  const parts: string[] = [];
  switch (result.service) {
    case "disabled":
      parts.push("Disabled the stock T3 background service");
      break;
    case "absent":
      parts.push("No stock T3 background service was installed");
      break;
    case "unsupported":
      parts.push("No systemd or launchd on the host");
      break;
  }
  if (result.stoppedPids.length > 0) {
    parts.push(
      `stopped ${String(result.stoppedPids.length)} running stock server process${
        result.stoppedPids.length === 1 ? "" : "es"
      }`,
    );
  }
  return `${parts.join("; ")}. Reconnecting with the P3 server.`;
}
