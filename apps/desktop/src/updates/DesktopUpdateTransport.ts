import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export interface DesktopUpdateTransportCheckOptions {
  readonly force: boolean;
}

export class DesktopUpdateTransportCheckError extends Schema.TaggedError<DesktopUpdateTransportCheckError>()(
  "DesktopUpdateTransportCheckError",
  {
    cause: Schema.Defect(),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? "P3 Code could not check for updates.";
  }
}

export class DesktopUpdateTransportDownloadError extends Schema.TaggedError<DesktopUpdateTransportDownloadError>()(
  "DesktopUpdateTransportDownloadError",
  {
    cause: Schema.Defect(),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? "P3 Code could not prepare the available update.";
  }
}

export class DesktopUpdateTransportInstallError extends Schema.TaggedError<DesktopUpdateTransportInstallError>()(
  "DesktopUpdateTransportInstallError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "P3 Code could not start the update installer.";
  }
}

export const DesktopUpdateTransportError = Schema.Union([
  DesktopUpdateTransportCheckError,
  DesktopUpdateTransportDownloadError,
  DesktopUpdateTransportInstallError,
]);
export type DesktopUpdateTransportError = typeof DesktopUpdateTransportError.Type;

export class DesktopUpdateTransport extends Context.Service<
  DesktopUpdateTransport,
  {
    readonly disabledReason: Effect.Effect<string | null>;
    readonly previousInstallFailure: Effect.Effect<string | null>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly checkForUpdates: (
      options: DesktopUpdateTransportCheckOptions,
    ) => Effect.Effect<void, DesktopUpdateTransportCheckError>;
    readonly downloadUpdate: Effect.Effect<void, DesktopUpdateTransportDownloadError>;
    readonly quitAndInstall: Effect.Effect<void, DesktopUpdateTransportInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/updates/DesktopUpdateTransport") {}

/**
 * The transport for a build with no update source: the desktop offers no self-update (and never
 * falls back to upstream's electron-updater feed). A distribution provides its own layer.
 */
export const layerNone = Layer.succeed(DesktopUpdateTransport, {
  disabledReason: Effect.succeed("This build of P3 Code has no update source."),
  previousInstallFailure: Effect.succeed(null),
  setChannel: Effect.fn("DesktopUpdateTransport.none.setChannel")(function* () {}),
  checkForUpdates: Effect.fn("DesktopUpdateTransport.none.checkForUpdates")(function* () {}),
  downloadUpdate: Effect.void,
  quitAndInstall: Effect.void,
  on: Effect.fn("DesktopUpdateTransport.none.on")(function* () {}),
});
