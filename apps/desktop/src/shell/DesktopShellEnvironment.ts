import { DesktopShellEnvironmentSnapshot, ShellEnvironmentPatch } from "@t3tools/contracts";
import {
  applyShellEnvironment,
  buildEnvironmentCaptureCommand,
  listLoginShellCandidates,
  setWindowsPath,
} from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

type EnvironmentPatch = Record<string, string>;

interface ShellEnvironmentConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

interface WindowsProbeOptions {
  readonly loadProfile: boolean;
}

const DesktopShellEnvironmentProbe = Schema.Literals([
  "login-shell",
  "launchctl-path",
  "powershell-profile",
  "powershell-no-profile",
]);
type DesktopShellEnvironmentProbe = typeof DesktopShellEnvironmentProbe.Type;

const desktopShellEnvironmentCommandFields = {
  probe: DesktopShellEnvironmentProbe,
  executable: Schema.String,
  argumentCount: Schema.Number,
};

export class DesktopShellEnvironmentCommandError extends Schema.TaggedError<DesktopShellEnvironmentCommandError>()(
  "DesktopShellEnvironmentCommandError",
  {
    ...desktopShellEnvironmentCommandFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) failed.`;
  }
}

export class DesktopShellEnvironmentCommandTimeoutError extends Schema.TaggedError<DesktopShellEnvironmentCommandTimeoutError>()(
  "DesktopShellEnvironmentCommandTimeoutError",
  {
    ...desktopShellEnvironmentCommandFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) timed out after ${this.timeoutMs}ms.`;
  }
}

export class DesktopShellEnvironment extends Context.Service<
  DesktopShellEnvironment,
  {
    // Desktop owns discovery, including on cache misses; the backend receives updates over fd4.
    readonly installIntoProcess: Effect.Effect<boolean>;
    readonly awaitDiscovery: Effect.Effect<boolean>;
    readonly updates: Stream.Stream<DesktopShellEnvironmentSnapshot>;
    // exowatt: the full login-shell capture for harness children; waits for discovery.
    readonly harnessEnvironment: Effect.Effect<EnvironmentPatch | undefined>;
  }
>()("@t3tools/desktop/shell/DesktopShellEnvironment") {}

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "T3CODE_TELEMETRY_ENABLED",
  "T3CODE_GITHUB_APP_CLIENT_ID",
  "__MISE_DIFF",
  "JAVA_HOME",
] as const;
const WINDOWS_PROFILE_ENV_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;
const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const FALLBACK_LC_CTYPE = "en_US.UTF-8";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const LOGIN_SHELL_TIMEOUT = Duration.seconds(5);
const LAUNCHCTL_TIMEOUT = Duration.seconds(2);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);

const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

const readEnvPath = (env: NodeJS.ProcessEnv): Option.Option<string> =>
  trimNonEmpty(env.PATH ?? env.Path ?? env.path);

const normalizeRuntimeDir = (value: string): string => value.replace(/\/+$/u, "");

const linuxRuntimeDirCandidates = (
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): ReadonlyArray<string> => {
  const candidates: string[] = [];
  const fromEnv = trimNonEmpty(env.XDG_RUNTIME_DIR);
  if (Option.isSome(fromEnv)) {
    candidates.push(normalizeRuntimeDir(fromEnv.value));
  }
  if (uid !== undefined) {
    candidates.push(`/run/user/${uid}`);
  }
  return candidates.filter((candidate) => candidate.length > 0);
};

const pathComparisonKey = (entry: string, platform: NodeJS.Platform) => {
  const normalized = entry.trim().replace(/^"+|"+$/g, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

const sanitizePathEntry = (entry: string, platform: NodeJS.Platform) =>
  platform === "win32" ? entry.replaceAll('"', "") : entry;

const mergePaths = (
  platform: NodeJS.Platform,
  values: ReadonlyArray<Option.Option<string>>,
): Option.Option<string> => {
  const delimiter = pathDelimiter(platform);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (Option.isNone(value)) continue;

    for (const entry of value.value.split(delimiter)) {
      const sanitized = sanitizePathEntry(entry.trim(), platform);
      if (sanitized.length === 0) continue;

      const key = pathComparisonKey(sanitized, platform);
      if (key.length === 0 || seen.has(key)) continue;

      seen.add(key);
      entries.push(sanitized);
    }
  }

  return entries.length > 0 ? Option.some(entries.join(delimiter)) : Option.none();
};

const knownWindowsCliDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => [
  ...trimNonEmpty(env.APPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\npm`],
    }),
  ),
  ...trimNonEmpty(env.LOCALAPPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\Programs\\nodejs`, `${value}\\Volta\\bin`, `${value}\\pnpm`],
    }),
  ),
  ...trimNonEmpty(env.USERPROFILE).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\.local\\bin`, `${value}\\.bun\\bin`, `${value}\\scoop\\shims`],
    }),
  ),
];

const startMarker = (name: string) => `__T3CODE_ENV_${name}_START__`;
const endMarker = (name: string) => `__T3CODE_ENV_${name}_END__`;
const FULL_ENV_START_MARKER = "__T3CODE_FULL_ENV_START__";
const FULL_ENV_END_MARKER = "__T3CODE_FULL_ENV_END__";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const executableName = (command: string): string => command.split(/[\\/]/u).at(-1) ?? command;

const logShellEnvironmentCommandError = (
  error: DesktopShellEnvironmentCommandError | DesktopShellEnvironmentCommandTimeoutError,
) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-shell-environment",
      error,
    }),
  );

// exowatt: nushell has no `env -0`, so it gets only the allowlisted names.
const isNushell = (shell: string): boolean => executableName(shell).toLowerCase().startsWith("nu");

// exowatt: after upstream's allowlist capture, POSIX shells also dump the whole
// login environment (`env -0`) for harness children (Phi/MCP credentials).
const captureLoginShellEnvironmentCommand = (shell: string, names: ReadonlyArray<string>) =>
  isNushell(shell)
    ? buildEnvironmentCaptureCommand(shell, names)
    : [
        ...(names.length > 0 ? [buildEnvironmentCaptureCommand(shell, names)] : []),
        `printf '\\0%s\\0' '${FULL_ENV_START_MARKER}'`,
        "env -0",
        `printf '\\0%s\\0' '${FULL_ENV_END_MARKER}'`,
      ].join("; ");

const captureWindowsEnvironmentCommand = (names: ReadonlyArray<string>) =>
  [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      return [
        `Write-Output '${startMarker(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${endMarker(name)}'`,
      ];
    }),
  ].join("; ");

const extractEnvironment = (output: string, names: ReadonlyArray<string>): EnvironmentPatch => {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (value.length > 0) {
      environment[name] = value;
    }
  }

  return environment;
};

export const parseNullSeparatedEnvironment = (output: string): EnvironmentPatch => {
  const environment: EnvironmentPatch = {};

  for (const entry of output.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;

    const name = entry.slice(0, separator);
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) continue;
    environment[name] = entry.slice(separator + 1);
  }

  return environment;
};

const extractFullEnvironment = (output: string): EnvironmentPatch => {
  const startBoundary = `\0${FULL_ENV_START_MARKER}\0`;
  const endBoundary = `\0${FULL_ENV_END_MARKER}\0`;
  const start = output.indexOf(startBoundary);
  if (start === -1) return {};
  const valueStart = start + startBoundary.length;
  const end = output.indexOf(endBoundary, valueStart);
  return end === -1 ? {} : parseNullSeparatedEnvironment(output.slice(valueStart, end));
};

const runCommandOutput = Effect.fn("desktop.shellEnvironment.runCommandOutput")(function* (input: {
  readonly probe: DesktopShellEnvironmentProbe;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: Duration.Duration;
  readonly shell?: boolean;
}): Effect.fn.Return<string, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fiber = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.command, input.args, {
          shell: input.shell ?? false,
          env: input.env,
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        }),
      );
      return yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], {
        concurrency: 2,
      });
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopShellEnvironmentCommandError({
          probe: input.probe,
          executable: executableName(input.command),
          argumentCount: input.args.length,
          cause,
        }),
    ),
    Effect.filterOrFail(
      ([, exitCode]) => exitCode === 0,
      ([, exitCode]) =>
        new DesktopShellEnvironmentCommandError({
          probe: input.probe,
          executable: executableName(input.command),
          argumentCount: input.args.length,
          cause: { exitCode },
        }),
    ),
    Effect.map(([stdout]) => stdout),
    Effect.catchTags({
      DesktopShellEnvironmentCommandError: (error) =>
        logShellEnvironmentCommandError(error).pipe(Effect.as("")),
    }),
    Effect.forkDetach,
  );
  const output = yield* Fiber.join(fiber).pipe(
    Effect.timeoutOption(input.timeout),
    // Interrupting awaits the child's exit, which a shell stuck in the kernel never reaches.
    Effect.ensuring(Fiber.interrupt(fiber).pipe(Effect.forkDetach)),
  );
  if (Option.isSome(output)) {
    return output.value;
  }

  const error = new DesktopShellEnvironmentCommandTimeoutError({
    probe: input.probe,
    executable: executableName(input.command),
    argumentCount: input.args.length,
    timeoutMs: Duration.toMillis(input.timeout),
  });
  yield* logShellEnvironmentCommandError(error);
  return "";
});

interface LoginShellEnvironmentCapture {
  readonly allowlisted: EnvironmentPatch;
  readonly full: EnvironmentPatch;
}

const readLoginShellEnvironment = (
  shell: string,
  names: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<LoginShellEnvironmentCapture, never, ChildProcessSpawner.ChildProcessSpawner> =>
  names.length === 0 && isNushell(shell)
    ? Effect.succeed({ allowlisted: {}, full: {} })
    : runCommandOutput({
        probe: "login-shell",
        command: shell,
        args: ["-ilc", captureLoginShellEnvironmentCommand(shell, names)],
        env,
        timeout: LOGIN_SHELL_TIMEOUT,
      }).pipe(
        Effect.map((output) => ({
          allowlisted: extractEnvironment(output, names),
          full: extractFullEnvironment(output),
        })),
      );

const readLaunchctlPath = (env: NodeJS.ProcessEnv) =>
  runCommandOutput({
    env,
    probe: "launchctl-path",
    command: "/bin/launchctl",
    args: ["getenv", "PATH"],
    timeout: LAUNCHCTL_TIMEOUT,
  }).pipe(Effect.map(trimNonEmpty));

const readWindowsEnvironment = Effect.fn("desktop.shellEnvironment.readWindowsEnvironment")(
  function* (
    names: ReadonlyArray<string>,
    options: WindowsProbeOptions,
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> {
    if (names.length === 0) return {};

    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      captureWindowsEnvironmentCommand(names),
    ];

    for (const command of WINDOWS_SHELL_CANDIDATES) {
      const output = yield* runCommandOutput({
        probe: options.loadProfile ? "powershell-profile" : "powershell-no-profile",
        command,
        args,
        env,
        timeout: LOGIN_SHELL_TIMEOUT,
      });
      const environment = extractEnvironment(output, names);
      if (Object.keys(environment).length > 0) {
        return environment;
      }
    }

    return {};
  },
);

const installWindowsEnvironment = Effect.fn("desktop.shellEnvironment.installWindowsEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
    const [noProfile, profile] = yield* Effect.all(
      [
        readWindowsEnvironment(["PATH"], { loadProfile: false }, config.env),
        readWindowsEnvironment(WINDOWS_PROFILE_ENV_NAMES, { loadProfile: true }, config.env),
      ],
      { concurrency: 2 },
    );
    const mergedPath = mergePaths("win32", [
      trimNonEmpty(profile.PATH),
      trimNonEmpty(knownWindowsCliDirs(config.env).join(";")),
      trimNonEmpty(noProfile.PATH),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      setWindowsPath(config.env, mergedPath.value);
    }
    if (!config.env.FNM_DIR && profile.FNM_DIR) {
      config.env.FNM_DIR = profile.FNM_DIR;
    }
    if (!config.env.FNM_MULTISHELL_PATH && profile.FNM_MULTISHELL_PATH) {
      config.env.FNM_MULTISHELL_PATH = profile.FNM_MULTISHELL_PATH;
    }
    return Boolean(noProfile.PATH && profile.PATH);
  },
);

const installPosixEnvironment = Effect.fn("desktop.shellEnvironment.installPosixEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<
    ShellEnvironmentInstallation,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const shellEnvironment: EnvironmentPatch = {};
    const fullEnvironment: EnvironmentPatch = {};

    for (const shell of listLoginShellCandidates(config.platform, config.env.SHELL)) {
      const capture = yield* readLoginShellEnvironment(shell, LOGIN_SHELL_ENV_NAMES, config.env);
      Object.assign(shellEnvironment, capture.allowlisted);
      Object.assign(fullEnvironment, capture.full);
      if (shellEnvironment.PATH) break;
    }

    const launchctlPath =
      config.platform === "darwin" && !shellEnvironment.PATH
        ? yield* readLaunchctlPath(config.env)
        : Option.none<string>();
    const mergedPath = mergePaths(config.platform, [
      trimNonEmpty(shellEnvironment.PATH).pipe(Option.orElse(() => launchctlPath)),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      config.env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    const shellPreferredEnvNames = [
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_DESKTOP",
      "XDG_SESSION_TYPE",
      // Forward mise's PATH delta too, or mise x can rebuild PATH into a recursive same-named wrapper.
      "__MISE_DIFF",
    ] as const;
    for (const name of shellPreferredEnvNames) {
      if (shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    for (const name of [
      "DISPLAY",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "WAYLAND_DISPLAY",
      // Shell CA settings are required by Node/OpenSSL builds without bundled roots for registry TLS.
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "JAVA_HOME",
      "T3CODE_TELEMETRY_ENABLED",
      "T3CODE_GITHUB_APP_CLIENT_ID",
    ] as const) {
      if (!config.env[name] && shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    // Hydrate locale variables together; inherited LC_ALL can override LANG or LC_CTYPE.
    if (
      config.platform === "darwin" &&
      LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))
    ) {
      for (const name of LOCALE_ENV_NAMES) {
        const value = trimNonEmpty(shellEnvironment[name]);
        if (Option.isSome(value)) {
          config.env[name] = value.value;
        }
      }

      // launchd lacks locale; UTF-8 LC_CTYPE fixes pbcopy's MacRoman decoding without changing C formatting or collation.
      if (LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))) {
        config.env.LC_CTYPE = FALLBACK_LC_CTYPE;
      }
    }

    if (
      config.platform === "linux" &&
      Option.isNone(trimNonEmpty(config.env.DBUS_SESSION_BUS_ADDRESS))
    ) {
      for (const runtimeDir of linuxRuntimeDirCandidates(config.env, process.getuid?.())) {
        const dbusSessionBusPath = `${runtimeDir}/bus`;
        const busExists = yield* fileSystem
          .exists(dbusSessionBusPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (busExists) {
          config.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dbusSessionBusPath}`;
          break;
        }
      }
    }

    const harnessEnvironment = reconcileHarnessEnvironment(fullEnvironment, config.env);
    return {
      installed: Option.isSome(trimNonEmpty(shellEnvironment.PATH)),
      harnessEnvironment:
        Object.keys(harnessEnvironment).length > 0 ? harnessEnvironment : undefined,
    };
  },
);

/**
 * Harness children get the raw login-shell capture with the allowlisted names replaced by
 * their reconciled desktop values (merged PATH, kept SSH_AUTH_SOCK, UTF-8 locale fallback),
 * so a phi found only through the launcher PATH still resolves.
 */
export const reconcileHarnessEnvironment = (
  fullEnvironment: EnvironmentPatch,
  reconciled: NodeJS.ProcessEnv,
): EnvironmentPatch => {
  if (Object.keys(fullEnvironment).length === 0) return fullEnvironment;
  const result: EnvironmentPatch = { ...fullEnvironment };
  for (const name of [...LOGIN_SHELL_ENV_NAMES, "LC_CTYPE"]) {
    const value = reconciled[name];
    if (value !== undefined && value !== "") result[name] = value;
  }
  return result;
};

interface ShellEnvironmentInstallation {
  /** Whether the login/profile environment was discovered; false leaves server hydration enabled. */
  readonly installed: boolean;
  /** exowatt: the full login-shell capture handed to harness children (MCP credentials). */
  readonly harnessEnvironment: EnvironmentPatch | undefined;
}

const installShellEnvironment = (
  config: ShellEnvironmentConfig,
): Effect.Effect<
  ShellEnvironmentInstallation,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> => {
  if (config.platform === "win32") {
    return installWindowsEnvironment(config).pipe(
      Effect.map((installed) => ({ installed, harnessEnvironment: undefined })),
    );
  }
  if (config.platform === "darwin" || config.platform === "linux") {
    return installPosixEnvironment(config);
  }
  return Effect.succeed({ installed: false, harnessEnvironment: undefined });
};

const ShellEnvironmentCache = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    key: Schema.String,
    environment: ShellEnvironmentPatch,
  }),
);
const encodeCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeCache = Schema.decodeUnknownEffect(ShellEnvironmentCache);
const encodeCache = Schema.encodeEffect(ShellEnvironmentCache);
const CACHED_ENV_NAMES = [
  "PATH",
  "__MISE_DIFF",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "JAVA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const env = process.env;
  const inherited = { ...env };
  const key = encodeCacheKey([
    environment.platform,
    environment.homeDirectory,
    inherited.SHELL ?? "",
    inherited.ZDOTDIR ?? "",
  ]);
  const cachePath = path.join(environment.stateDir, "shell-environment-cache.json");
  const changes = yield* PubSub.unbounded<DesktopShellEnvironmentSnapshot>();
  const latest = yield* Ref.make<Option.Option<DesktopShellEnvironmentSnapshot>>(Option.none());
  const discovered = yield* Deferred.make<boolean>();
  // exowatt: never persisted to the cache file (it holds credentials).
  const capturedHarnessEnvironment = yield* Ref.make<EnvironmentPatch | undefined>(undefined);
  const publish = Effect.fn("desktop.shellEnvironment.publish")(function* (
    patch: ShellEnvironmentPatch,
    discovered = false,
  ) {
    applyShellEnvironment(env, patch, environment.platform);
    const message: DesktopShellEnvironmentSnapshot = {
      version: 1,
      type: "shellEnvironment",
      discovered,
      platform: environment.platform,
      environment: patch,
    };
    yield* Ref.set(latest, Option.some(message));
    yield* PubSub.publish(changes, message);
  });
  const refresh = Effect.gen(function* () {
    // Refresh from the inherited baseline so removed cached paths and values do not survive.
    const fresh = { ...inherited };
    const installation = yield* installShellEnvironment({
      env: fresh,
      platform: environment.platform,
    });
    const prepared = installation.installed;
    yield* Ref.set(capturedHarnessEnvironment, installation.harnessEnvironment);
    const patch = Object.fromEntries(
      Object.keys(ShellEnvironmentPatch.fields).map((name) => [name, fresh[name] ?? null]),
    );
    if (prepared || Option.isNone(yield* Ref.get(latest))) yield* publish(patch, prepared);
    if (prepared) {
      const cached = Object.fromEntries(
        CACHED_ENV_NAMES.flatMap((name) => (fresh[name] ? [[name, fresh[name]]] : [])),
      );
      const persist = Effect.gen(function* () {
        const encoded = yield* encodeCache({ version: 1, key, environment: cached });
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(cachePath + ".tmp", encoded, { mode: 0o600 });
        yield* fileSystem.rename(cachePath + ".tmp", cachePath);
      });
      yield* persist.pipe(
        Effect.catch(() => Effect.logWarning("Could not cache shell environment")),
      );
    }
    return prepared;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.withSpan("desktop.shellEnvironment.refresh"),
    Effect.onExit((exit) => Deferred.done(discovered, exit)),
  );
  const installIntoProcess = yield* Effect.cached(
    Effect.gen(function* () {
      const cache = yield* fileSystem
        .readFileString(cachePath)
        .pipe(Effect.flatMap(decodeCache), Effect.option);
      if (Option.isSome(cache) && cache.value.key === key) {
        const cached = Object.fromEntries(
          CACHED_ENV_NAMES.flatMap((name) => {
            const value = cache.value.environment[name];
            // mise's metadata must describe the cached PATH entries restored alongside it.
            if (name !== "PATH" && name !== "__MISE_DIFF" && inherited[name] !== undefined)
              return [];
            return typeof value === "string" ? [[name, value]] : [];
          }),
        );
        const baseline = { ...inherited };
        const cachedPath = cached.PATH;
        if (cachedPath) {
          cached.PATH = Option.getOrElse(
            mergePaths(environment.platform, [Option.some(cachedPath), readEnvPath(inherited)]),
            () => cachedPath,
          );
        }
        applyShellEnvironment(baseline, cached, environment.platform);
        yield* publish(
          Object.fromEntries(
            Object.keys(ShellEnvironmentPatch.fields).map((name) => [name, baseline[name] ?? null]),
          ),
        );
      }
      yield* Effect.forkIn(refresh, scope);
      return true;
    }).pipe(Effect.withSpan("desktop.shellEnvironment.installIntoProcess")),
  );
  const updates = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* Ref.get(latest);
      return Stream.concat(
        Option.isSome(snapshot) ? Stream.make(snapshot.value) : Stream.empty,
        Stream.fromSubscription(subscription),
      );
    }),
  );
  return DesktopShellEnvironment.of({
    installIntoProcess,
    awaitDiscovery: installIntoProcess.pipe(Effect.andThen(Deferred.await(discovered))),
    updates,
    // The backend bootstrap waits for this; the window does not.
    harnessEnvironment: installIntoProcess.pipe(
      Effect.andThen(Deferred.await(discovered)),
      Effect.andThen(Ref.get(capturedHarnessEnvironment)),
      Effect.map((captured) => (captured === undefined ? undefined : { ...captured })),
    ),
  });
});

export const layer = Layer.effect(DesktopShellEnvironment, make);
