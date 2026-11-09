// @effect-diagnostics nodeBuiltinImport:off - server-owned filesystem boundary for harness configs.
// @effect-diagnostics globalDate:off - Date.now only makes atomic-write temp names unique.
import {
  type ExowattHarnessId,
  type ExowattHarnessAsset,
  type ExowattHarnessAssetInventory,
  type ExowattHarnessAssetInventoryResult,
  type ExowattHarnessAssetKind,
  type ExowattHarnessAssetListInput,
  type ExowattHarnessAssetToggleInput,
  type ExowattHarnessMcpAddInput,
  type ExowattHarnessMcpConnectInput,
  type ExowattHarnessMcpInventory,
  type ExowattHarnessMcpInventoryResult,
  type ExowattHarnessMcpStatusInput,
  type ExowattHarnessMcpStatusResult,
  type ExowattHarnessMcpToggleInput,
  ExowattHarnessConfigError,
  ExowattMcpRuntimeStatus,
  type ExowattMcpServer,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";
// Import the package root: under plain Node (`node src/bin.ts`) that is the UMD build, which
// loads through CJS `require`. The ESM build cannot run unbundled and the UMD build cannot be
// bundled, so the pack config aliases `jsonc-parser` to the ESM entry for the bundle only
// (apps/server/vite.config.ts).
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ExowattClaudeMcp from "./exowattClaudeMcp.ts";
import * as ExowattCodexMcp from "./exowattCodexMcp.ts";
import * as HarnessLaunchEnvironment from "./provider/HarnessLaunchEnvironment.ts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

/** Phi's CLI on PATH when settings carry no explicit binary (mirrors the phi driver default). */
const DEFAULT_PHI_BINARY = "phi";

export type HarnessFormat = "json-mcpServers" | "toml-mcp-servers" | "opencode-json";

interface HarnessLocation {
  readonly harness: ExowattHarnessId;
  readonly label: string;
  readonly rootPath: string;
  readonly configPath: string;
  readonly alternateConfigPath?: string;
  readonly format: HarnessFormat;
  readonly supportsToggle: boolean;
}

const HARNESSES: ReadonlyArray<ExowattHarnessId> = [
  "phi",
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
];

const LABELS: Readonly<Record<ExowattHarnessId, string>> = {
  phi: "Phi",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor Agent",
  grok: "Grok",
  opencode: "OpenCode",
};

const CONFIG_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Every harness P3 writes to can carry a bearer token on an HTTP server: the JSON harnesses
 * and OpenCode take a `headers` object beside `url`; Codex spells it `http_headers` and Grok
 * `headers` in `config.toml` (see `tomlHeaderKey`). Kept as a function because it is the one
 * place the inventory's `supportsHttpHeaders` comes from.
 */
export function formatSupportsHttpHeaders(_format: HarnessFormat): boolean {
  return true;
}

/**
 * Codex reads an HTTP server's headers from `http_headers`, Grok from
 * `headers`. Both are inline tables of string values; both harnesses also
 * expand `${VAR}` inside them, which is why P3 writes the literal token and
 * never a shell expansion it cannot escape.
 */
function tomlHeaderKey(harness: ExowattHarnessId): string {
  return harness === "codex" ? "http_headers" : "headers";
}

/** Both TOML spellings, so a config written by either harness reads back. */
const TOML_HEADER_KEYS = ["http_headers", "headers"] as const;
const isHarnessConfigError = Schema.is(ExowattHarnessConfigError);
const PhiMcpStatusEnvelope = Schema.Struct({
  schema: Schema.Literal(1),
  capabilities: Schema.optionalKey(
    Schema.Struct({ enablement: Schema.optionalKey(Schema.Boolean) }),
  ),
  servers: Schema.Array(ExowattMcpRuntimeStatus),
});
const PhiMcpErrorEnvelope = Schema.Struct({ error: Schema.String });
const decodePhiMcpStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PhiMcpStatusEnvelope),
);
const decodePhiMcpErrorJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PhiMcpErrorEnvelope),
);
const MCP_STATUS_UNAVAILABLE: ExowattHarnessMcpStatusResult = {
  available: false,
  supportsEnablement: false,
  servers: [],
};
const MCP_STATUS_TIMEOUT_MS = 10_000;
const MCP_TOGGLE_TIMEOUT_MS = 10_000;
const MCP_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Grace period between SIGTERM and SIGKILL when a phi MCP command is interrupted. */
const PHI_MCP_FORCE_KILL_GRACE = "2 seconds";

function error(operation: string, reason: string, path?: string): ExowattHarnessConfigError {
  return new ExowattHarnessConfigError({
    operation,
    reason,
    ...(path ? { path } : {}),
  });
}

export function resolveHarnessLocations(
  home = NodeOS.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<ExowattHarnessId, HarnessLocation>> {
  const phiRoot = env.PI_CODING_AGENT_DIR || NodePath.join(home, ".pi", "agent");
  const codexRoot = env.CODEX_HOME || NodePath.join(home, ".codex");
  const claudeRoot = env.CLAUDE_CONFIG_DIR || NodePath.join(home, ".claude");
  const claudeConfigPath = env.CLAUDE_CONFIG_DIR
    ? NodePath.join(claudeRoot, ".claude.json")
    : NodePath.join(home, ".claude.json");
  const cursorRoot = NodePath.join(home, ".cursor");
  const grokRoot = env.GROK_HOME || NodePath.join(home, ".grok");
  const openCodeRoot = NodePath.join(
    env.XDG_CONFIG_HOME || NodePath.join(home, ".config"),
    "opencode",
  );
  const openCodeConfigPath = env.OPENCODE_CONFIG || NodePath.join(openCodeRoot, "opencode.json");

  return {
    phi: {
      harness: "phi",
      label: LABELS.phi,
      rootPath: phiRoot,
      configPath: env.PHI_MCP_CONFIG || NodePath.join(phiRoot, "mcp.json"),
      format: "json-mcpServers",
      // Phi owns effective enablement in its locked sidecar; P3 toggles it only
      // through `phi mcp enable|disable`, never by editing this JSON file.
      supportsToggle: true,
    },
    codex: {
      harness: "codex",
      label: LABELS.codex,
      rootPath: codexRoot,
      configPath: NodePath.join(codexRoot, "config.toml"),
      format: "toml-mcp-servers",
      supportsToggle: true,
    },
    claude: {
      harness: "claude",
      label: LABELS.claude,
      rootPath: claudeRoot,
      configPath: claudeConfigPath,
      format: "json-mcpServers",
      supportsToggle: false,
    },
    cursor: {
      harness: "cursor",
      label: LABELS.cursor,
      rootPath: cursorRoot,
      configPath: NodePath.join(cursorRoot, "mcp.json"),
      format: "json-mcpServers",
      supportsToggle: false,
    },
    grok: {
      harness: "grok",
      label: LABELS.grok,
      rootPath: grokRoot,
      configPath: NodePath.join(grokRoot, "config.toml"),
      format: "toml-mcp-servers",
      supportsToggle: true,
    },
    opencode: {
      harness: "opencode",
      label: LABELS.opencode,
      rootPath: openCodeRoot,
      configPath: openCodeConfigPath,
      ...(env.OPENCODE_CONFIG
        ? {}
        : { alternateConfigPath: NodePath.join(openCodeRoot, "opencode.jsonc") }),
      format: "opencode-json",
      supportsToggle: true,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function envNames(value: unknown): ReadonlyArray<string> {
  const valueRecord = record(value);
  return valueRecord ? Object.keys(valueRecord).sort() : [];
}

function serverFromRecord(input: {
  readonly name: string;
  readonly sourcePath: string;
  readonly value: Record<string, unknown>;
  readonly openCode?: boolean;
}): ExowattMcpServer {
  const commandValue = input.value.command;
  const commandParts = input.openCode ? stringArray(commandValue) : [];
  const command =
    typeof commandValue === "string" ? commandValue : input.openCode ? commandParts[0] : undefined;
  const args = input.openCode ? commandParts.slice(1) : stringArray(input.value.args);
  const url = typeof input.value.url === "string" ? input.value.url : undefined;
  const status =
    input.value.enabled === false || input.value.disabled === true ? "disabled" : "enabled";
  const environment = input.openCode ? input.value.environment : input.value.env;

  return {
    id: `${input.sourcePath}:${input.name}`,
    name: input.name,
    status,
    sourcePath: input.sourcePath,
    transport: url ? "http" : "stdio",
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    args: [...args],
    envNames: [...envNames(environment)],
  };
}

export function parseJsonMcpConfig(
  raw: string,
  sourcePath: string,
): { readonly servers: ReadonlyArray<ExowattMcpServer>; readonly warnings: ReadonlyArray<string> } {
  if (raw.trim() === "") return { servers: [], warnings: [] };
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  const root = record(parsed);
  if (!root || errors.length > 0) {
    return { servers: [], warnings: ["The MCP config is not valid JSON."] };
  }
  const mcpServers = record(root.mcpServers);
  if (!mcpServers) return { servers: [], warnings: [] };
  return {
    servers: Object.entries(mcpServers)
      .flatMap(([name, value]) => {
        const valueRecord = record(value);
        return valueRecord ? [serverFromRecord({ name, sourcePath, value: valueRecord })] : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    warnings: [],
  };
}

export function parseTomlMcpConfig(
  raw: string,
  sourcePath: string,
): { readonly servers: ReadonlyArray<ExowattMcpServer>; readonly warnings: ReadonlyArray<string> } {
  if (raw.trim() === "") return { servers: [], warnings: [] };
  try {
    const root = record(parseToml(raw));
    const mcpServers = record(root?.mcp_servers);
    if (!mcpServers) return { servers: [], warnings: [] };
    return {
      servers: Object.entries(mcpServers)
        .flatMap(([name, value]) => {
          const valueRecord = record(value);
          return valueRecord ? [serverFromRecord({ name, sourcePath, value: valueRecord })] : [];
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      warnings: [],
    };
  } catch {
    return { servers: [], warnings: ["The MCP config is not valid TOML."] };
  }
}

export function parseOpenCodeMcpConfig(
  raw: string,
  sourcePath: string,
): { readonly servers: ReadonlyArray<ExowattMcpServer>; readonly warnings: ReadonlyArray<string> } {
  if (raw.trim() === "") return { servers: [], warnings: [] };
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  const root = record(parsed);
  if (!root || errors.length > 0) {
    return { servers: [], warnings: ["The OpenCode config is not valid JSON or JSONC."] };
  }
  const mcpServers = record(root.mcp);
  if (!mcpServers) return { servers: [], warnings: [] };
  return {
    servers: Object.entries(mcpServers)
      .flatMap(([name, value]) => {
        const valueRecord = record(value);
        return valueRecord
          ? [serverFromRecord({ name, sourcePath, value: valueRecord, openCode: true })]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    warnings: [],
  };
}

function validateAddInput(input: ExowattHarnessMcpAddInput): void {
  if (!CONFIG_NAME_PATTERN.test(input.name)) {
    throw error(
      "add",
      "Server names must begin with a letter and use only letters, numbers, dashes, or underscores.",
    );
  }
  if (input.transport === "stdio" && !input.command?.trim()) {
    throw error("add", "A command is required for a stdio MCP server.");
  }
  if (input.transport === "http" && !input.url?.trim()) {
    throw error("add", "A URL is required for an HTTP MCP server.");
  }
  for (const variable of input.env) {
    if (!ENV_NAME_PATTERN.test(variable.name)) {
      throw error("add", `Invalid environment variable name '${variable.name}'.`);
    }
  }
  for (const header of input.headers ?? []) {
    if (!HEADER_NAME_PATTERN.test(header.name)) {
      throw error("add", `Invalid HTTP header name '${header.name}'.`);
    }
  }
}

function headerRecord(input: ExowattHarnessMcpAddInput): Record<string, unknown> {
  const headers = input.headers ?? [];
  return headers.length > 0
    ? { headers: Object.fromEntries(headers.map((header) => [header.name, header.value])) }
    : {};
}

function jsonFormatting(raw: string) {
  return {
    insertSpaces: !raw.includes("\t"),
    tabSize: 2,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  };
}

function jsonServer(input: ExowattHarnessMcpAddInput): Record<string, unknown> {
  return input.transport === "http"
    ? // Claude Code's `.mcp.json` needs the transport spelled out; Cursor and
      // Phi accept it and infer the same thing from `url` when it is absent.
      { type: "http", url: input.url, ...headerRecord(input) }
    : {
        command: input.command,
        args: [...input.args],
        ...(input.env.length > 0
          ? {
              env: Object.fromEntries(input.env.map((variable) => [variable.name, variable.value])),
            }
          : {}),
      };
}

function openCodeServer(input: ExowattHarnessMcpAddInput): Record<string, unknown> {
  return input.transport === "http"
    ? { type: "remote", url: input.url, enabled: true, ...headerRecord(input) }
    : {
        type: "local",
        command: [input.command, ...input.args],
        enabled: true,
        ...(input.env.length > 0
          ? {
              environment: Object.fromEntries(
                input.env.map((variable) => [variable.name, variable.value]),
              ),
            }
          : {}),
      };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlServerBlock(input: ExowattHarnessMcpAddInput): string {
  const lines = [`[mcp_servers.${input.name}]`, "enabled = true"];
  if (input.transport === "http") {
    lines.push(`url = ${tomlString(input.url ?? "")}`);
    const headers = input.headers ?? [];
    if (headers.length > 0) {
      lines.push(
        `${tomlHeaderKey(input.harness)} = { ${headers
          .map((header) => `${tomlString(header.name)} = ${tomlString(header.value)}`)
          .join(", ")} }`,
      );
    }
  } else {
    lines.push(`command = ${tomlString(input.command ?? "")}`);
    if (input.args.length > 0) {
      lines.push(`args = [${input.args.map(tomlString).join(", ")}]`);
    }
    if (input.env.length > 0) {
      lines.push(
        `env = { ${input.env
          .map((variable) => `${variable.name} = ${tomlString(variable.value)}`)
          .join(", ")} }`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function addMcpServerToContents(
  format: HarnessFormat,
  raw: string,
  input: ExowattHarnessMcpAddInput,
): string {
  validateAddInput(input);
  const base = raw.trim() === "" ? "{}\n" : raw;
  if (format === "toml-mcp-servers") {
    const parsed = parseTomlMcpConfig(raw, "config.toml");
    if (parsed.warnings.length > 0) throw error("add", parsed.warnings[0] ?? "Invalid TOML.");
    if (parsed.servers.some((server) => server.name === input.name)) {
      throw error("add", `An MCP server named '${input.name}' already exists.`);
    }
    return `${raw.trimEnd()}${raw.trim() ? "\n\n" : ""}${tomlServerBlock(input)}`;
  }

  const parsed =
    format === "opencode-json"
      ? parseOpenCodeMcpConfig(base, "opencode.json")
      : parseJsonMcpConfig(base, "mcp.json");
  if (parsed.warnings.length > 0) throw error("add", parsed.warnings[0] ?? "Invalid JSON.");
  if (parsed.servers.some((server) => server.name === input.name)) {
    throw error("add", `An MCP server named '${input.name}' already exists.`);
  }
  const property = format === "opencode-json" ? "mcp" : "mcpServers";
  const value = format === "opencode-json" ? openCodeServer(input) : jsonServer(input);
  return applyEdits(
    base,
    modify(base, [property, input.name], value, {
      formattingOptions: jsonFormatting(base),
    }),
  );
}

/**
 * Drop `[mcp_servers.<name>]` and the lines belonging to it (up to the next table header or
 * the end of the file) so the fresh block can be appended without leaving the old one behind.
 * Comments and settings outside the block are untouched; a comment inside the old block goes
 * with it.
 */
function removeTomlServerBlock(raw: string, name: string): string {
  const sectionPattern = new RegExp(
    `^\\[mcp_servers\\.${name}\\][^\\r\\n]*(?:\\r?\\n(?!\\[)[^\\r\\n]*)*(?:\\r?\\n)?`,
    "m",
  );
  return raw.replace(sectionPattern, "");
}

/**
 * Write an MCP server into a harness config, replacing an entry of the same
 * name instead of refusing it. This is what the auto-connect reconciler needs:
 * a `p3` entry whose token has rotated or whose server moved port has to be
 * overwritten in place, and the harness only ever wants one entry per name.
 */
export function upsertMcpServerToContents(
  format: HarnessFormat,
  raw: string,
  input: ExowattHarnessMcpAddInput,
): string {
  validateAddInput(input);
  const base = raw.trim() === "" ? "{}\n" : raw;
  if (format === "toml-mcp-servers") {
    const parsed = parseTomlMcpConfig(raw, "config.toml");
    if (parsed.warnings.length > 0) throw error("upsert", parsed.warnings[0] ?? "Invalid TOML.");
    const remaining = removeTomlServerBlock(raw, input.name);
    return `${remaining.trimEnd()}${remaining.trim() ? "\n\n" : ""}${tomlServerBlock(input)}`;
  }

  const parsed =
    format === "opencode-json"
      ? parseOpenCodeMcpConfig(base, "opencode.json")
      : parseJsonMcpConfig(base, "mcp.json");
  if (parsed.warnings.length > 0) throw error("upsert", parsed.warnings[0] ?? "Invalid JSON.");
  const property = format === "opencode-json" ? "mcp" : "mcpServers";
  const value = format === "opencode-json" ? openCodeServer(input) : jsonServer(input);
  return applyEdits(
    base,
    modify(base, [property, input.name], value, {
      formattingOptions: jsonFormatting(base),
    }),
  );
}

/**
 * One configured MCP server, with the header values the inventory deliberately
 * leaves out. Server-side only: the auto-connect reconciler has to read the
 * bearer token it wrote last time to decide whether it is still good, and that
 * token must never cross the wire to a client.
 */
export interface HarnessMcpEntry {
  readonly name: string;
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

function headersFromRecord(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): Readonly<Record<string, string>> {
  for (const key of keys) {
    const headers = record(value[key]);
    if (!headers) continue;
    return Object.fromEntries(
      Object.entries(headers).flatMap(([name, headerValue]) =>
        typeof headerValue === "string" ? [[name, headerValue] as const] : [],
      ),
    );
  }
  return {};
}

function entriesFromRecord(
  servers: Record<string, unknown>,
  headerKeys: ReadonlyArray<string>,
): ReadonlyArray<HarnessMcpEntry> {
  return Object.entries(servers).flatMap(([name, value]) => {
    const valueRecord = record(value);
    if (!valueRecord) return [];
    return [
      {
        name,
        url: typeof valueRecord.url === "string" ? valueRecord.url : null,
        headers: headersFromRecord(valueRecord, headerKeys),
      } satisfies HarnessMcpEntry,
    ];
  });
}

/**
 * The configured servers of one harness config, headers included. Returns an
 * empty list for a config P3 cannot parse: the reconciler treats that the same
 * as "no entry", and refuses to write over a file it does not understand.
 */
export function parseHarnessMcpEntries(
  format: HarnessFormat,
  raw: string,
): ReadonlyArray<HarnessMcpEntry> {
  if (raw.trim() === "") return [];
  if (format === "toml-mcp-servers") {
    try {
      const root = record(parseToml(raw));
      const servers = record(root?.mcp_servers);
      return servers ? entriesFromRecord(servers, TOML_HEADER_KEYS) : [];
    } catch {
      return [];
    }
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  const root = record(parsed);
  if (!root || errors.length > 0) return [];
  const servers = record(format === "opencode-json" ? root.mcp : root.mcpServers);
  return servers ? entriesFromRecord(servers, ["headers"]) : [];
}

export function toggleMcpServerInContents(
  format: HarnessFormat,
  raw: string,
  name: string,
  enabled: boolean,
): string {
  if (!CONFIG_NAME_PATTERN.test(name)) throw error("toggle", "Invalid server name.");
  if (format === "opencode-json") {
    const parsed = parseOpenCodeMcpConfig(raw, "opencode.json");
    if (!parsed.servers.some((server) => server.name === name)) {
      throw error("toggle", `No MCP server named '${name}' exists.`);
    }
    return applyEdits(
      raw,
      modify(raw, ["mcp", name, "enabled"], enabled, {
        formattingOptions: jsonFormatting(raw),
      }),
    );
  }
  if (format !== "toml-mcp-servers") {
    throw error("toggle", "This harness does not expose a stable MCP enable/disable setting.");
  }
  const parsed = parseTomlMcpConfig(raw, "config.toml");
  if (!parsed.servers.some((server) => server.name === name)) {
    throw error("toggle", `No MCP server named '${name}' exists.`);
  }
  const sectionPattern = new RegExp(
    `(^\\[mcp_servers\\.${name}\\][^\\r\\n]*(?:\\r?\\n(?!\\[)[^\\r\\n]*)*)`,
    "m",
  );
  return raw.replace(sectionPattern, (section: string) => {
    const enabledPattern = /^enabled\s*=.*$/m;
    return enabledPattern.test(section)
      ? section.replace(enabledPattern, `enabled = ${String(enabled)}`)
      : section.replace(/\r?\n/, `\nenabled = ${String(enabled)}\n`);
  });
}

async function existingConfigPath(location: HarnessLocation): Promise<string> {
  if (!location.alternateConfigPath) return location.configPath;
  try {
    await NodeFSP.access(location.configPath);
    return location.configPath;
  } catch {
    try {
      await NodeFSP.access(location.alternateConfigPath);
      return location.alternateConfigPath;
    } catch {
      return location.configPath;
    }
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw cause;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporaryPath = `${path}.p3-${process.pid}-${Date.now()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, contents.endsWith("\n") ? contents : `${contents}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    const existing = await NodeFSP.stat(path);
    await NodeFSP.chmod(temporaryPath, existing.mode);
  } catch {
    // A new config intentionally keeps the restrictive mode supplied above.
  }
  await NodeFSP.rename(temporaryPath, path);
}

async function inventoryFor(location: HarnessLocation): Promise<ExowattHarnessMcpInventory> {
  const configPath = await existingConfigPath(location);
  const raw = await readOptional(configPath);
  const parsed =
    location.format === "toml-mcp-servers"
      ? parseTomlMcpConfig(raw, configPath)
      : location.format === "opencode-json"
        ? parseOpenCodeMcpConfig(raw, configPath)
        : parseJsonMcpConfig(raw, configPath);
  return {
    harness: location.harness,
    label: location.label,
    rootPath: location.rootPath,
    sourcePaths: [configPath],
    supportsToggle: location.supportsToggle,
    supportsAdd: true,
    supportsHttpHeaders: formatSupportsHttpHeaders(location.format),
    servers: [...parsed.servers],
    warnings: [...parsed.warnings],
  };
}

async function list(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ExowattHarnessMcpInventoryResult> {
  const locations = resolveHarnessLocations(env.HOME || NodeOS.homedir(), env);
  return {
    harnesses: await Promise.all(HARNESSES.map((harness) => inventoryFor(locations[harness]))),
  };
}

export const listHarnessMcpConfigs = Effect.fn("listHarnessMcpConfigs")(function* () {
  const env = yield* HarnessLaunchEnvironment.forChild();
  return yield* Effect.tryPromise({
    try: () => list(env),
    catch: (cause) => error("list", cause instanceof Error ? cause.message : String(cause)),
  });
});

export const addHarnessMcpServer = Effect.fn("addHarnessMcpServer")(function* (
  input: ExowattHarnessMcpAddInput,
) {
  const env = yield* HarnessLaunchEnvironment.forChild();
  return yield* Effect.tryPromise({
    try: async () => {
      const location = resolveHarnessLocations(env.HOME || NodeOS.homedir(), env)[input.harness];
      const configPath = await existingConfigPath(location);
      const raw = await readOptional(configPath);
      const next = addMcpServerToContents(location.format, raw, input);
      await atomicWrite(configPath, next);
      if (input.harness === "claude") ExowattClaudeMcp.invalidateClaudeMcpStatusCache();
      return list(env);
    },
    catch: (cause) =>
      isHarnessConfigError(cause)
        ? cause
        : error("add", cause instanceof Error ? cause.message : String(cause)),
  });
});

export const upsertHarnessMcpServer = Effect.fn("upsertHarnessMcpServer")(function* (
  input: ExowattHarnessMcpAddInput,
) {
  const env = yield* HarnessLaunchEnvironment.forChild();
  return yield* Effect.tryPromise({
    try: async () => {
      const location = resolveHarnessLocations(env.HOME || NodeOS.homedir(), env)[input.harness];
      const configPath = await existingConfigPath(location);
      const raw = await readOptional(configPath);
      const next = upsertMcpServerToContents(location.format, raw, input);
      await atomicWrite(configPath, next);
      if (input.harness === "claude") ExowattClaudeMcp.invalidateClaudeMcpStatusCache();
      return list(env);
    },
    catch: (cause) =>
      isHarnessConfigError(cause)
        ? cause
        : error("upsert", cause instanceof Error ? cause.message : String(cause)),
  });
});

/**
 * What one harness's config says today, for code that has to decide whether to
 * write at all. `installed` is whether the harness's own directory exists: P3
 * configures the harnesses on the machine, and must not conjure a config
 * directory for a harness the person never installed.
 */
export interface HarnessMcpState {
  readonly harness: ExowattHarnessId;
  readonly label: string;
  readonly installed: boolean;
  readonly configPath: string;
  readonly entries: ReadonlyArray<HarnessMcpEntry>;
}

export const readHarnessMcpState = Effect.fn("readHarnessMcpState")(function* (
  harness: ExowattHarnessId,
) {
  const env = yield* HarnessLaunchEnvironment.forChild();
  return yield* Effect.tryPromise({
    try: async (): Promise<HarnessMcpState> => {
      const location = resolveHarnessLocations(env.HOME || NodeOS.homedir(), env)[harness];
      const installed = await NodeFSP.stat(location.rootPath)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      const configPath = await existingConfigPath(location);
      const raw = installed ? await readOptional(configPath) : "";
      return {
        harness,
        label: location.label,
        installed,
        configPath,
        entries: parseHarnessMcpEntries(location.format, raw),
      };
    },
    catch: (cause) =>
      isHarnessConfigError(cause)
        ? cause
        : error("read", cause instanceof Error ? cause.message : String(cause)),
  });
});

/** Every harness P3 knows about, in the order the inventory reports them. */
export const HARNESS_IDS: ReadonlyArray<ExowattHarnessId> = HARNESSES;

export const toggleHarnessMcpServer = Effect.fn("toggleHarnessMcpServer")(function* (
  input: ExowattHarnessMcpToggleInput,
  binaryPath?: string,
) {
  const env = yield* HarnessLaunchEnvironment.forChild();
  const location = resolveHarnessLocations(env.HOME || NodeOS.homedir(), env)[input.harness];
  if (!location.supportsToggle) {
    return yield* error(
      "toggle",
      `${location.label} does not expose a stable MCP enable/disable setting.`,
    );
  }

  if (input.harness === "phi") {
    const result = yield* runPhiMcpCommand(
      binaryPath,
      ["mcp", input.enabled ? "enable" : "disable", input.name, "--json"],
      MCP_TOGGLE_TIMEOUT_MS,
    );
    if (result?.code !== 0) {
      const reason =
        (result && (phiMcpError(result.stdout) ?? phiMcpError(result.stderr))) ??
        "Phi MCP enablement did not complete.";
      return yield* error("toggle", reason);
    }
    return { harness: input.harness, name: input.name, enabled: input.enabled, inventory: null };
  }

  const inventory = yield* Effect.tryPromise({
    try: async () => {
      const configPath = await existingConfigPath(location);
      const raw = await readOptional(configPath);
      const next = toggleMcpServerInContents(location.format, raw, input.name, input.enabled);
      await atomicWrite(configPath, next);
      return list(env);
    },
    catch: (cause) =>
      isHarnessConfigError(cause)
        ? cause
        : error("toggle", cause instanceof Error ? cause.message : String(cause)),
  });
  return { harness: input.harness, name: input.name, enabled: input.enabled, inventory };
});

export function parsePhiMcpStatusOutput(output: string): ExowattHarnessMcpStatusResult {
  return Option.match(decodePhiMcpStatusJson(output.trim()), {
    onNone: () => MCP_STATUS_UNAVAILABLE,
    onSome: ({ capabilities, servers }) => ({
      available: true,
      supportsEnablement: capabilities?.enablement === true,
      servers: [...servers],
    }),
  });
}

function phiMcpError(output: string): string | undefined {
  return Option.getOrUndefined(
    Option.map(decodePhiMcpErrorJson(output.trim()), ({ error: reason }) => reason),
  );
}

const runPhiMcpCommand = Effect.fn("runPhiMcpCommand")(function* (
  binaryPath: string | undefined,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) {
  const command = binaryPath?.trim() || DEFAULT_PHI_BINARY;
  const environment = yield* HarnessLaunchEnvironment.forChild(
    args[0] === "login" ? { PHI_MCP_BROWSER_AUTH: "1" } : {},
  );
  const attempt = Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        // Without a force-kill grace, interrupting this scope only sends SIGTERM and
        // then waits for the child forever, so a phi process that ignores or traps it
        // makes `timeoutMs` unenforceable and can wedge the login RPC indefinitely.
        killSignal: "SIGTERM",
        forceKillAfter: PHI_MCP_FORCE_KILL_GRACE,
      }),
    );
  });

  return yield* attempt.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.catchCause(() => Effect.succeedNone),
    Effect.map(Option.getOrUndefined),
  );
});

/**
 * The CLI options the status and login functions take, read off the server
 * settings the way `ws.ts` and the MCP harness toolkit both need them. Missing
 * settings mean the bare binary names and the default homes.
 */
export function harnessCliOptionsFromSettings(
  settings: Pick<ServerSettings, "providerInstances"> | undefined,
): {
  readonly phiBinaryPath: string | undefined;
  readonly claude: ExowattClaudeMcp.ClaudeCliOptions;
  readonly codex: ExowattCodexMcp.CodexCliOptions;
} {
  return {
    phiBinaryPath: phiBinaryPathFromSettings(settings),
    claude: {
      binaryPath: defaultInstanceConfigString(settings, "claudeAgent", "binaryPath"),
      homePath: defaultInstanceConfigString(settings, "claudeAgent", "homePath"),
    },
    codex: { binaryPath: defaultInstanceConfigString(settings, "codex", "binaryPath") },
  };
}

/**
 * A string field of a driver's default provider instance config. Upstream
 * moved per-driver settings (`providers.<driver>`) into `providerInstances`,
 * whose `config` is driver-owned and untyped here; an unset or blank field
 * means the harness default.
 */
function defaultInstanceConfigString(
  settings: Pick<ServerSettings, "providerInstances"> | undefined,
  driver: string,
  field: string,
): string | undefined {
  const config = settings?.providerInstances[ProviderInstanceId.make(driver)]?.config;
  const value =
    typeof config === "object" && config !== null && Object.hasOwn(config, field)
      ? (config as Record<string, unknown>)[field]
      : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Phi is driven through its own binary, whose path the user can override. */
export const phiBinaryPathFromSettings = (
  settings: Pick<ServerSettings, "providerInstances"> | undefined,
): string | undefined => defaultInstanceConfigString(settings, "phi", "binaryPath");

/**
 * Runtime status and login exist only for harnesses with a CLI that can answer: Phi
 * (`phi mcp status|login`), Claude Code (`exowattClaudeMcp.ts`) and Codex
 * (`exowattCodexMcp.ts`). Every other harness reports `available: false` and refuses to connect.
 */
export const getHarnessMcpRuntimeStatus = Effect.fn("getHarnessMcpRuntimeStatus")(function* (
  input: ExowattHarnessMcpStatusInput,
  binaryPath?: string,
  claude: ExowattClaudeMcp.ClaudeCliOptions = {},
  codex: ExowattCodexMcp.CodexCliOptions = {},
) {
  if (input.harness === "claude") {
    return yield* ExowattClaudeMcp.getClaudeMcpStatus(claude, input.refresh === true);
  }
  if (input.harness === "codex") {
    return yield* ExowattCodexMcp.getCodexMcpStatus(codex);
  }
  if (input.harness !== "phi") return MCP_STATUS_UNAVAILABLE;

  const result = yield* runPhiMcpCommand(
    binaryPath,
    ["mcp", "status", "--json"],
    MCP_STATUS_TIMEOUT_MS,
  );
  if (result === undefined || result.code !== 0) return MCP_STATUS_UNAVAILABLE;
  return parsePhiMcpStatusOutput(result.stdout);
});

export const connectHarnessMcpServer = Effect.fn("connectHarnessMcpServer")(function* (
  input: ExowattHarnessMcpConnectInput,
  binaryPath?: string,
  claude: ExowattClaudeMcp.ClaudeCliOptions = {},
  codex: ExowattCodexMcp.CodexCliOptions = {},
) {
  if (input.harness === "claude") {
    return yield* ExowattClaudeMcp.connectClaudeMcpServer(claude, input.name);
  }
  if (input.harness === "codex") {
    return yield* ExowattCodexMcp.connectCodexMcpServer(codex, input.name);
  }
  if (input.harness !== "phi") return { connected: false, error: null };

  const result = yield* runPhiMcpCommand(
    binaryPath,
    ["mcp", "login", input.name, "--json"],
    MCP_LOGIN_TIMEOUT_MS,
  );
  if (result?.code === 0) return { connected: true, error: null };

  const reason =
    (result && (phiMcpError(result.stdout) ?? phiMcpError(result.stderr))) ??
    "Phi MCP login did not complete.";
  return { connected: false, error: reason };
});

async function directoryNames(path: string): Promise<ReadonlyArray<string>> {
  try {
    return (await NodeFSP.readdir(path, { withFileTypes: true }))
      .filter(
        (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

async function directoryAssets(path: string): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  try {
    return (await NodeFSP.readdir(path, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({
        id: NodePath.join(path, entry.name),
        name: entry.name.replace(/\.(?:ts|js|mjs|cjs)$/i, ""),
        status: "enabled" as const,
        sourcePath: NodePath.join(path, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

async function skillAssets(path: string): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const names = await directoryNames(path);
  const assets = await Promise.all(
    names.map(async (name): Promise<ExowattHarnessAsset | null> => {
      const skillPath = NodePath.join(path, name, "SKILL.md");
      try {
        await NodeFSP.access(skillPath);
        return { id: skillPath, name, status: "enabled", sourcePath: skillPath };
      } catch {
        return null;
      }
    }),
  );
  return assets.filter((asset): asset is ExowattHarnessAsset => asset !== null);
}

function packageAssets(raw: string, sourcePath: string): ReadonlyArray<ExowattHarnessAsset> {
  const parsed = record(parseJsonc(raw, [], { allowTrailingComma: true, disallowComments: false }));
  return stringArray(parsed?.packages).map((name) => ({
    id: `${sourcePath}:${name}`,
    name,
    status: "enabled",
    sourcePath,
  }));
}

export function codexPluginAssets(
  raw: string,
  sourcePath: string,
): ReadonlyArray<ExowattHarnessAsset> {
  try {
    const plugins = record(record(parseToml(raw))?.plugins);
    if (!plugins) return [];
    return Object.entries(plugins)
      .map(([name, value]) => ({
        id: `${sourcePath}:${name}`,
        name,
        status: record(value)?.enabled === false ? ("disabled" as const) : ("enabled" as const),
        sourcePath,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function disabledNames(raw: string, kind: "skills" | "plugins"): ReadonlySet<string> {
  try {
    const section = record(record(parseToml(raw))?.[kind]);
    return new Set(stringArray(section?.disabled));
  } catch {
    return new Set();
  }
}

export function applyDisabledNames(
  raw: string,
  kind: "skills" | "plugins",
  names: ReadonlySet<string>,
): string {
  const list = `[${[...names].sort().map(tomlString).join(", ")}]`;
  const sectionPattern = new RegExp(`(^\\[${kind}\\][^\\r\\n]*(?:\\r?\\n(?!\\[)[^\\r\\n]*)*)`, "m");
  if (!sectionPattern.test(raw)) {
    return `${raw.trimEnd()}${raw.trim() ? "\n\n" : ""}[${kind}]\ndisabled = ${list}\n`;
  }
  return raw.replace(sectionPattern, (section) => {
    const settingPattern = /^disabled\s*=.*$/m;
    return settingPattern.test(section)
      ? section.replace(settingPattern, `disabled = ${list}`)
      : section.replace(/\r?\n/, `\ndisabled = ${list}\n`);
  });
}

export function applyCodexPluginEnabled(raw: string, name: string, enabled: boolean): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(
    `(^\\[plugins\\.(?:${escaped}|"${escaped}")\\][^\\r\\n]*(?:\\r?\\n(?!\\[)[^\\r\\n]*)*)`,
    "m",
  );
  if (!sectionPattern.test(raw)) {
    throw error("toggle-asset", `No Codex plugin named '${name}' exists.`);
  }
  return raw.replace(sectionPattern, (section) => {
    const settingPattern = /^enabled\s*=.*$/m;
    return settingPattern.test(section)
      ? section.replace(settingPattern, `enabled = ${String(enabled)}`)
      : section.replace(/\r?\n/, `\nenabled = ${String(enabled)}\n`);
  });
}

async function claudePluginAssets(
  location: HarnessLocation,
): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const installedPath = NodePath.join(location.rootPath, "plugins", "installed_plugins.json");
  const settingsPath = NodePath.join(location.rootPath, "settings.json");
  const installed = record(
    parseJsonc(await readOptional(installedPath), [], {
      allowTrailingComma: true,
      disallowComments: false,
    }),
  );
  const settings = record(
    parseJsonc(await readOptional(settingsPath), [], {
      allowTrailingComma: true,
      disallowComments: false,
    }),
  );
  const plugins = record(installed?.plugins);
  const enabledPlugins = record(settings?.enabledPlugins);
  if (!plugins) return [];
  return Object.entries(plugins)
    .map(([name, installs]) => {
      const firstInstall = Array.isArray(installs) ? record(installs[0]) : null;
      const sourcePath =
        typeof firstInstall?.installPath === "string" ? firstInstall.installPath : installedPath;
      return {
        id: `${installedPath}:${name}`,
        name,
        status: enabledPlugins?.[name] === false ? ("disabled" as const) : ("enabled" as const),
        sourcePath,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function cursorPluginAssets(rootPath: string): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const cachePath = NodePath.join(rootPath, "plugins", "cache");
  const vendors = await directoryNames(cachePath);
  const assets = await Promise.all(
    vendors.map(async (vendor) => {
      const vendorPath = NodePath.join(cachePath, vendor);
      const pluginNames = await directoryNames(vendorPath);
      return Promise.all(
        pluginNames.map(async (name): Promise<ExowattHarnessAsset> => {
          const revisions = await directoryNames(NodePath.join(vendorPath, name));
          const sourcePath = NodePath.join(vendorPath, name, revisions.at(-1) ?? "");
          return {
            id: `${vendor}:${name}`,
            name: `${name}@${vendor}`,
            status: "enabled",
            sourcePath,
          };
        }),
      );
    }),
  );
  return assets.flat().sort((left, right) => left.name.localeCompare(right.name));
}

async function cursorExtensionAssets(
  rootPath: string,
): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const manifestPath = NodePath.join(rootPath, "extensions", "extensions.json");
  const parsed = parseJsonc(await readOptional(manifestPath), [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!Array.isArray(parsed)) return directoryAssets(NodePath.join(rootPath, "extensions"));
  return parsed.flatMap((value): ReadonlyArray<ExowattHarnessAsset> => {
    const valueRecord = record(value);
    const identifier = record(valueRecord?.identifier);
    const location = record(valueRecord?.location);
    const name = typeof identifier?.id === "string" ? identifier.id : null;
    const sourcePath =
      typeof location?.path === "string"
        ? location.path
        : typeof location?.fsPath === "string"
          ? location.fsPath
          : null;
    return name && sourcePath
      ? [{ id: `${manifestPath}:${name}`, name, status: "enabled", sourcePath }]
      : [];
  });
}

async function openCodePluginAssets(
  configPath: string,
): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const parsed = record(
    parseJsonc(await readOptional(configPath), [], {
      allowTrailingComma: true,
      disallowComments: false,
    }),
  );
  return stringArray(parsed?.plugin).map((name) => ({
    id: `${configPath}:${name}`,
    name,
    status: "enabled",
    sourcePath: configPath,
  }));
}

function sourcePathsForAsset(
  location: HarnessLocation,
  kind: ExowattHarnessAssetKind,
): ReadonlyArray<string> {
  if (location.harness === "phi") {
    return kind === "plugins"
      ? [NodePath.join(location.rootPath, "settings.json")]
      : [NodePath.join(location.rootPath, kind)];
  }
  if (location.harness === "codex") {
    return kind === "extensions"
      ? []
      : kind === "plugins"
        ? [location.configPath, NodePath.join(location.rootPath, "plugins")]
        : [NodePath.join(location.rootPath, "skills"), location.configPath];
  }
  if (location.harness === "claude") {
    return kind === "extensions"
      ? []
      : kind === "plugins"
        ? [
            NodePath.join(location.rootPath, "plugins", "installed_plugins.json"),
            NodePath.join(location.rootPath, "settings.json"),
          ]
        : [NodePath.join(location.rootPath, "skills")];
  }
  if (location.harness === "cursor") {
    return [
      NodePath.join(
        location.rootPath,
        kind === "plugins" ? NodePath.join("plugins", "cache") : kind,
      ),
    ];
  }
  if (location.harness === "grok") {
    return kind === "extensions"
      ? []
      : [NodePath.join(location.rootPath, kind), location.configPath];
  }
  return kind === "extensions"
    ? []
    : kind === "plugins"
      ? [NodePath.join(location.rootPath, "plugins"), location.configPath]
      : [NodePath.join(location.rootPath, "skills")];
}

function supportsAssetToggle(harness: ExowattHarnessId, kind: ExowattHarnessAssetKind): boolean {
  return (
    (harness === "codex" && kind === "plugins") ||
    (harness === "claude" && kind === "plugins") ||
    (harness === "grok" && (kind === "skills" || kind === "plugins"))
  );
}

async function assetsFor(
  location: HarnessLocation,
  kind: ExowattHarnessAssetKind,
): Promise<ReadonlyArray<ExowattHarnessAsset>> {
  const sourcePaths = sourcePathsForAsset(location, kind);
  if (sourcePaths.length === 0) return [];
  if (location.harness === "phi" && kind === "plugins") {
    const settingsPath = sourcePaths[0]!;
    return packageAssets(await readOptional(settingsPath), settingsPath);
  }
  if (location.harness === "codex" && kind === "plugins") {
    return codexPluginAssets(await readOptional(location.configPath), location.configPath);
  }
  if (location.harness === "claude" && kind === "plugins") {
    return claudePluginAssets(location);
  }
  if (location.harness === "cursor" && kind === "plugins") {
    return cursorPluginAssets(location.rootPath);
  }
  if (location.harness === "cursor" && kind === "extensions") {
    return cursorExtensionAssets(location.rootPath);
  }
  if (location.harness === "opencode" && kind === "plugins") {
    return openCodePluginAssets(await existingConfigPath(location));
  }
  const directoryPath = sourcePaths[0]!;
  const assets =
    kind === "skills" ? await skillAssets(directoryPath) : await directoryAssets(directoryPath);
  if (location.harness !== "grok" || kind === "extensions") return assets;
  const disabled = disabledNames(await readOptional(location.configPath), kind);
  return assets.map((asset) => ({
    ...asset,
    status: disabled.has(asset.name) ? "disabled" : "enabled",
  }));
}

async function listAssets(
  kind: ExowattHarnessAssetKind,
): Promise<ExowattHarnessAssetInventoryResult> {
  const locations = resolveHarnessLocations();
  return {
    harnesses: await Promise.all(
      HARNESSES.map(async (harness): Promise<ExowattHarnessAssetInventory> => {
        const location = locations[harness];
        return {
          harness,
          label: location.label,
          kind,
          sourcePaths: [...sourcePathsForAsset(location, kind)],
          supportsToggle: supportsAssetToggle(harness, kind),
          assets: [...(await assetsFor(location, kind))],
          warnings: [],
        };
      }),
    ),
  };
}

export const listHarnessAssets = Effect.fn("listHarnessAssets")(
  (input: ExowattHarnessAssetListInput) =>
    Effect.tryPromise({
      try: () => listAssets(input.kind),
      catch: (cause) =>
        error("list-assets", cause instanceof Error ? cause.message : String(cause)),
    }),
);

export const toggleHarnessAsset = Effect.fn("toggleHarnessAsset")(
  (input: ExowattHarnessAssetToggleInput) =>
    Effect.tryPromise({
      try: async () => {
        const location = resolveHarnessLocations()[input.harness];
        if (!supportsAssetToggle(input.harness, input.kind)) {
          throw error(
            "toggle-asset",
            `${location.label} does not expose a stable toggle for this item.`,
          );
        }
        if (input.harness === "codex" && input.kind === "plugins") {
          const raw = await readOptional(location.configPath);
          await atomicWrite(
            location.configPath,
            applyCodexPluginEnabled(raw, input.name, input.enabled),
          );
        } else if (input.harness === "claude" && input.kind === "plugins") {
          const settingsPath = NodePath.join(location.rootPath, "settings.json");
          const raw = (await readOptional(settingsPath)) || "{}\n";
          const next = applyEdits(
            raw,
            modify(raw, ["enabledPlugins", input.name], input.enabled, {
              formattingOptions: jsonFormatting(raw),
            }),
          );
          await atomicWrite(settingsPath, next);
        } else if (input.harness === "grok" && input.kind !== "extensions") {
          const raw = await readOptional(location.configPath);
          const disabled = new Set(disabledNames(raw, input.kind));
          if (input.enabled) disabled.delete(input.name);
          else disabled.add(input.name);
          await atomicWrite(location.configPath, applyDisabledNames(raw, input.kind, disabled));
        }
        return listAssets(input.kind);
      },
      catch: (cause) =>
        isHarnessConfigError(cause)
          ? cause
          : error("toggle-asset", cause instanceof Error ? cause.message : String(cause)),
    }),
);
