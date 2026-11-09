// Exowatt distro: Codex's own view of its MCP servers, through its CLI. `codex mcp list
// --json` prints every server in `~/.codex/config.toml` with an `auth_status` (`unsupported`,
// `bearer_token`, `oauth`, `not_logged_in`) read from Codex's credential store, so it is fast
// and health-checks nothing. `codex mcp login <name>` runs the OAuth flow for one server.
import type {
  ExowattHarnessMcpConnectResult,
  ExowattHarnessMcpStatusResult,
  ExowattMcpRuntimeStatus,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";

import * as HarnessLaunchEnvironment from "./provider/HarnessLaunchEnvironment.ts";
import { type CommandResult, spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

const DEFAULT_CODEX_BINARY = "codex";
/** `codex mcp list` reads config and the credential store; no network. */
const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;
/** Same ten minutes Phi's and Claude Code's logins get: the person has to finish in a browser. */
const CODEX_MCP_LOGIN_TIMEOUT_MS = 10 * 60_000;
const CODEX_MCP_FORCE_KILL_GRACE = "2 seconds";
const ERROR_MAX_LENGTH = 400;

/** How P3 finds the Codex CLI; from Settings › Providers › Codex. */
export interface CodexCliOptions {
  /** Path to the `codex` binary; the bare name when unset. */
  readonly binaryPath?: string | undefined;
}

const STATUS_UNAVAILABLE: ExowattHarnessMcpStatusResult = {
  available: false,
  supportsEnablement: false,
  servers: [],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The url of an HTTP server, or the command line of a stdio one, for the row's caption. */
function targetOf(transport: Record<string, unknown> | undefined): string | undefined {
  if (!transport) return undefined;
  const url = stringOf(transport.url);
  if (url) return url;
  const command = stringOf(transport.command);
  if (!command) return undefined;
  const args = Array.isArray(transport.args)
    ? transport.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [command, ...args].join(" ");
}

function parseServer(entry: unknown): ExowattMcpRuntimeStatus | null {
  const record = asRecord(entry);
  const name = stringOf(record?.name);
  if (!record || !name) return null;
  const transport = asRecord(record.transport);
  const transportType = stringOf(transport?.type)?.toLowerCase() ?? "";
  const target = targetOf(transport);
  const enabled = record.enabled !== false;
  // Older Codex builds print no `auth_status`; treat them like `unsupported`.
  const authStatus = stringOf(record.auth_status)?.toLowerCase() ?? "unsupported";
  const base = {
    name,
    transport:
      transportType === "stdio" || transportType === "" ? ("stdio" as const) : ("http" as const),
    enabled,
    loginInProgress: false,
    configError: null,
    ...(target ? { target } : {}),
  };
  switch (authStatus) {
    case "not_logged_in":
    case "notloggedin":
      return { ...base, authMode: "oauth", credential: "absent", needsLogin: true };
    case "oauth":
    case "o_auth":
      return { ...base, authMode: "oauth", credential: "valid", needsLogin: false };
    case "bearer_token":
    case "bearertoken":
      return { ...base, authMode: "static", credential: "n/a", needsLogin: false };
    default:
      return { ...base, authMode: "none", credential: "n/a", needsLogin: false };
  }
}

/**
 * Every server `codex mcp list --json` printed, in Codex's order. A stdout that
 * is not a JSON array (an older Codex printing a table, a warning line) reads
 * as "no answer" rather than as an empty inventory.
 */
export function parseCodexMcpListOutput(output: string): ExowattHarnessMcpStatusResult | null {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return {
    available: true,
    // Codex has `codex mcp add/remove`, but no enable/disable switch P3 drives.
    supportsEnablement: false,
    servers: parsed
      .map(parseServer)
      .filter((server): server is ExowattMcpRuntimeStatus => server !== null),
  };
}

const runCodexMcpCommand = Effect.fn("runCodexMcpCommand")(function* (
  options: CodexCliOptions,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) {
  const command = options.binaryPath?.trim() || DEFAULT_CODEX_BINARY;
  const environment = yield* HarnessLaunchEnvironment.forChild();
  const attempt = Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        // As for Phi and Claude Code: without a force-kill grace an interrupted
        // child that traps SIGTERM would make the timeout unenforceable.
        killSignal: "SIGTERM",
        forceKillAfter: CODEX_MCP_FORCE_KILL_GRACE,
      }),
    );
  });

  return yield* attempt.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.catchCause(() => Effect.succeed(Option.none<CommandResult>())),
    Effect.map(Option.getOrUndefined),
  );
});

/**
 * Codex's status for every MCP server in its config, from `codex mcp list
 * --json`. `available: false` when the CLI is missing, too old to print JSON,
 * or did not answer in time.
 */
export const getCodexMcpStatus = Effect.fn("getCodexMcpStatus")(function* (
  options: CodexCliOptions,
) {
  const result = yield* runCodexMcpCommand(
    options,
    ["mcp", "list", "--json"],
    CODEX_MCP_LIST_TIMEOUT_MS,
  );
  if (result === undefined || result.code !== 0) return STATUS_UNAVAILABLE;
  const parsed = parseCodexMcpListOutput(result.stdout);
  if (parsed === null) return STATUS_UNAVAILABLE;
  return {
    ...parsed,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies ExowattHarnessMcpStatusResult;
});

/**
 * `codex mcp login <name>`: Codex opens the authorization page in the browser
 * on this machine and waits for the callback. A running Codex app-server
 * session sees the new credential on its next `mcpServer/statusUpdated`; a
 * thread that already failed the server's tools needs a fresh session.
 */
export const connectCodexMcpServer = Effect.fn("connectCodexMcpServer")(function* (
  options: CodexCliOptions,
  name: string,
) {
  const result = yield* runCodexMcpCommand(
    options,
    ["mcp", "login", name],
    CODEX_MCP_LOGIN_TIMEOUT_MS,
  );
  if (result === undefined) {
    return {
      connected: false,
      error: "Codex MCP login did not complete.",
    } satisfies ExowattHarnessMcpConnectResult;
  }
  if (result.code === 0) {
    return { connected: true, error: null } satisfies ExowattHarnessMcpConnectResult;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return {
    connected: false,
    error: (stderr || stdout || `codex mcp login exited with code ${result.code}.`).slice(
      0,
      ERROR_MAX_LENGTH,
    ),
  } satisfies ExowattHarnessMcpConnectResult;
});
