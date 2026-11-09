// Exowatt distro: `t3 agent token` mints a bearer session for a coding agent and prints
// the MCP config that lets it drive this server's thread tools. It is `t3 auth session
// issue` with agent-shaped defaults (standard client scopes, 30-day TTL, a label for
// Authorized Clients) plus the origin of the running server, so the output is paste-ready.
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, DurationFromString, resolveCliAuthConfig } from "./config.ts";

export const DEFAULT_AGENT_TOKEN_LABEL = "coding-agent";
export const DEFAULT_AGENT_TOKEN_TTL = Duration.days(30);
/** Shown when no server is running, so the snippet is still paste-ready after a start. */
export const AGENT_TOKEN_ORIGIN_PLACEHOLDER = "http://127.0.0.1:<port>";

export const AgentMcpClient = ["cursor", "claude-code", "json"] as const;
export type AgentMcpClient = (typeof AgentMcpClient)[number];

export interface AgentTokenOutputInput {
  readonly sessionId: string;
  readonly token: string;
  readonly label: string;
  readonly expiresAt: DateTime.Utc;
  /** Origin of the running server, or null when none was found. */
  readonly origin: string | null;
  readonly client: AgentMcpClient;
}

/** The `mcpServers` entry both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`) accept. */
export function agentMcpServerEntry(input: {
  readonly origin: string | null;
  readonly token: string;
  readonly client: AgentMcpClient;
}): Record<string, unknown> {
  return {
    // Claude Code's `.mcp.json` needs the transport spelled out; Cursor infers it from `url`.
    ...(input.client === "claude-code" ? { type: "http" } : {}),
    url: `${input.origin ?? AGENT_TOKEN_ORIGIN_PLACEHOLDER}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  };
}

export function formatAgentTokenOutput(input: AgentTokenOutputInput): string {
  const entry = agentMcpServerEntry(input);
  if (input.client === "json") {
    return `${JSON.stringify(
      {
        sessionId: input.sessionId,
        token: input.token,
        label: input.label,
        expiresAt: DateTime.formatIso(input.expiresAt),
        origin: input.origin,
        mcpServers: { p3: entry },
      },
      null,
      2,
    )}\n`;
  }
  const file = input.client === "cursor" ? ".cursor/mcp.json" : ".mcp.json";
  const lines = [
    `Issued agent token "${input.label}" (session ${input.sessionId}), expires ${DateTime.formatIso(input.expiresAt)}.`,
    `Revoke with \`t3 auth session revoke ${input.sessionId}\` or from Settings › Authorized Clients.`,
    "",
    ...(input.origin === null
      ? [
          "No running P3 Code server was found (server-runtime.json is absent); replace <port> below once it is up.",
          "",
        ]
      : []),
    `Add to ${file} (merge into an existing "mcpServers" object):`,
    JSON.stringify({ mcpServers: { p3: entry } }, null, 2),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription(
    `Name shown in Authorized Clients, e.g. \`claude-code\` or \`cursor\`. Defaults to \`${DEFAULT_AGENT_TOKEN_LABEL}\`.`,
  ),
  Flag.withDefault(DEFAULT_AGENT_TOKEN_LABEL),
);

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("How long the token lives, for example `7d` or `12h`. Defaults to 30 days."),
  Flag.optional,
);

const clientFlag = Flag.Literals("client", AgentMcpClient).pipe(
  Flag.withDescription(
    "Shape of the printed config: `cursor` (.cursor/mcp.json), `claude-code` (.mcp.json), or `json` for scripts.",
  ),
  Flag.withDefault("cursor" as AgentMcpClient),
);

const originFlag = Flag.String("origin").pipe(
  Flag.withDescription(
    "Server origin to print, e.g. `http://127.0.0.1:3773`. Defaults to the running server from server-runtime.json.",
  ),
  Flag.optional,
);

const runAgentToken = Effect.fn("runAgentToken")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly label: string;
  readonly ttl: Option.Option<Duration.Duration>;
  readonly client: AgentMcpClient;
  readonly origin: Option.Option<string>;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = flags.client === "json" ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const runtimeState = Option.isSome(flags.origin)
      ? Option.none()
      : yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
          // A stale or unreadable runtime file should not stop token issuance.
          Effect.orElseSucceed(() => Option.none()),
        );
    const origin = Option.isSome(flags.origin)
      ? flags.origin.value.replace(/\/+$/, "")
      : Option.isSome(runtimeState)
        ? runtimeState.value.origin
        : null;
    const issued = yield* environmentAuth.issueSession({
      scopes: AuthStandardClientScopes,
      ttl: Option.getOrElse(flags.ttl, () => DEFAULT_AGENT_TOKEN_TTL),
      label: flags.label,
      subject: flags.label,
    });
    yield* Console.log(
      formatAgentTokenOutput({
        sessionId: issued.sessionId,
        token: issued.token,
        label: flags.label,
        expiresAt: issued.expiresAt,
        origin,
        client: flags.client,
      }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const agentTokenCommand = Command.make("token", {
  ...authLocationFlags,
  label: labelFlag,
  ttl: ttlFlag,
  client: clientFlag,
  origin: originFlag,
}).pipe(
  Command.withDescription(
    "Mint a bearer token for a coding agent and print the MCP config that connects it to this server's thread tools.",
  ),
  Command.withHandler(runAgentToken),
);

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Connect coding agents (Claude Code, Cursor, scripts) to this server."),
  Command.withSubcommands([agentTokenCommand]),
);
