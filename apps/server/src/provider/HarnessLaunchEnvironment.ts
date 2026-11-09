import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

// Values that change how a harness process starts, stripped from EVERY base environment
// (login-shell capture and process.env fallback alike: the desktop runs this server with
// ELECTRON_RUN_AS_NODE=1). Not a NODE_*/BUN_* wildcard: certificate paths are user config.
export const HARNESS_ENVIRONMENT_DENYLIST = new Set([
  "ELECTRON_RUN_AS_NODE", // runs an Electron-backed harness as plain Node
  "NODE_OPTIONS", // injects runtime flags or a --preload into the child
  "BUN_OPTIONS", // phi is a Bun executable: --preload=x.js hijacks it
  "NODE_CHANNEL_FD", // attaches an inherited IPC channel the child did not ask for
  "ORIGINAL_XDG_CURRENT_DESKTOP", // Electron launcher implementation detail
  "PWD", // the login shell's directory, not the spawn cwd
  "OLDPWD",
]);

/** Strip the denylist from any candidate base environment. Names only; values untouched. */
export const sanitizeHarnessEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([name]) => !HARNESS_ENVIRONMENT_DENYLIST.has(name)),
  );

export class HarnessLaunchEnvironment extends Context.Service<
  HarnessLaunchEnvironment,
  {
    readonly forChild: (overlay?: Readonly<NodeJS.ProcessEnv>) => NodeJS.ProcessEnv;
  }
>()("t3/provider/HarnessLaunchEnvironment") {}

export function make(
  loginShellEnvironment: Readonly<Record<string, string>> | undefined,
  fallbackEnvironment: NodeJS.ProcessEnv = process.env,
): HarnessLaunchEnvironment["Service"] {
  const baseEnvironment = sanitizeHarnessEnvironment(
    loginShellEnvironment === undefined ? fallbackEnvironment : loginShellEnvironment,
  );

  return HarnessLaunchEnvironment.of({
    forChild: (overlay = {}) => ({ ...baseEnvironment, ...overlay }),
  });
}

// REQUIRES the service on purpose: an optional lookup with a process.env fallback
// once shipped wired where only the reactor saw it, so every harness spawn silently
// got the stripped desktop env. Requiring it makes a wiring mistake a type error.
export const forChild = Effect.fn("HarnessLaunchEnvironment.forChild")(function* (
  overlay: Readonly<NodeJS.ProcessEnv> = {},
) {
  const service = yield* HarnessLaunchEnvironment;
  return service.forChild(overlay);
});

export const layer = Layer.effect(
  HarnessLaunchEnvironment,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return make(config.harnessEnvironment, yield* HostProcess.Environment);
  }),
);

export const layerTest = (
  loginShellEnvironment: Readonly<Record<string, string>> | undefined,
  fallbackEnvironment: NodeJS.ProcessEnv = process.env,
) => Layer.succeed(HarnessLaunchEnvironment, make(loginShellEnvironment, fallbackEnvironment));
