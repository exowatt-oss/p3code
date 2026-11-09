// Exowatt distro: IPC surface for the sidebar "Logs" button. The renderer never
// supplies a path; the main process reveals its own log directory (desktop
// trace, server-child logs, server trace, provider logs), so this cannot be
// used to open arbitrary folders.
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const exowattOpenLogsDirectory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXOWATT_OPEN_LOGS_DIRECTORY_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.exowattLogs.openLogsDirectory")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // shell.openPath resolves to "" on success and an error message otherwise.
    const failure = yield* Effect.promise(() =>
      Electron.shell.openPath(environment.logDir).catch((error: unknown) => String(error)),
    );
    if (failure.length > 0) {
      yield* Effect.logWarning("exowatt: failed to open logs directory").pipe(
        Effect.annotateLogs({ logDir: environment.logDir, failure }),
      );
      return false;
    }
    return true;
  }),
});
