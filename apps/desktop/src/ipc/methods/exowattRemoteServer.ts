// Exowatt distro: IPC surface for the P3 remote-host flow. The renderer shows a
// one-click "stop the stock T3 server" action when a connection fails with
// EXOWATT_STOCK_REMOTE_SERVER_CODE, and dev builds can push the worktree's
// packed server to a remote (packages/ssh/src/exowattRemoteServer.ts).
import {
  DesktopSshEnvironmentTargetSchema,
  ExowattPushDevServerResultSchema,
  ExowattRemoteStockServerStopResultSchema,
} from "@t3tools/contracts";
import { SshLaunchError } from "@t3tools/ssh/errors";
import {
  installExowattRemoteServer,
  stopExowattRemoteStockServer,
} from "@t3tools/ssh/exowattRemoteServer";
import * as Effect from "effect/Effect";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import {
  EXOWATT_DEV_SERVER_RESOURCE_DIR,
  resolveExowattDevRemoteServerSource,
} from "../../ssh/ExowattRemoteServerSource.ts";

export const exowattStopRemoteStockServer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXOWATT_STOP_REMOTE_STOCK_SERVER_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: ExowattRemoteStockServerStopResultSchema,
  handler: Effect.fn("desktop.ipc.exowattRemoteServer.stopStockServer")(function* (target) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.runRemoteOperation(target, stopExowattRemoteStockServer);
  }),
});

/**
 * Dev-only: installs the worktree's packed `0.0.0-dev.<sha>` server into its
 * own `~/.t3/p3-server/versions/` entry on the remote. The release server
 * there is untouched; the next connect prefers the pushed build because it is
 * the dev desktop's exact source version.
 */
export const exowattPushDevServer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXOWATT_PUSH_DEV_SERVER_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: ExowattPushDevServerResultSchema,
  handler: Effect.fn("desktop.ipc.exowattRemoteServer.pushDevServer")(function* (target) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isDevelopment) {
      return yield* new SshLaunchError({
        message: "Pushing a dev server is only available in development builds of P3 Code.",
        stdout: "",
      });
    }
    const source = yield* resolveExowattDevRemoteServerSource({ rootDir: environment.rootDir });
    if (source._tag === "None") {
      return yield* new SshLaunchError({
        message: `No packed dev server found under ${EXOWATT_DEV_SERVER_RESOURCE_DIR}. Run 'pnpm exowatt:pack-dev-server' in the worktree first.`,
        stdout: "",
      });
    }
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.runRemoteOperation(target, (resolvedTarget, authOptions) =>
      installExowattRemoteServer(source.value, resolvedTarget, authOptions),
    );
  }),
});
