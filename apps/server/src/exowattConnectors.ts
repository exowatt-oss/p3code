// Exowatt distro: the server half of the Customize › MCP connector catalog.
// `issueConnectorAgentToken` is `t3 agent token` without the CLI: the same environment-auth
// session issuance with standard client scopes and a label for Authorized Clients, plus the
// origin of the running server read from `server-runtime.json`. Revocation is unchanged.
import {
  AuthStandardClientScopes,
  ExowattConnectorError,
  type ExowattConnectorIssueAgentTokenInput,
  type ExowattConnectorIssueAgentTokenResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/** Same 30 days `t3 agent token` uses. */
export const EXOWATT_CONNECTOR_AGENT_TOKEN_TTL = Duration.days(30);

export const issueConnectorAgentToken = Effect.fn("issueConnectorAgentToken")(function* (input: {
  readonly payload: ExowattConnectorIssueAgentTokenInput;
  readonly serverRuntimeStatePath: string;
}) {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  // A stale or unreadable runtime file should not stop token issuance; the
  // client falls back to the origin it is already connected to.
  const runtimeState = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  const issued = yield* serverAuth
    .issueSession({
      scopes: AuthStandardClientScopes,
      ttl: EXOWATT_CONNECTOR_AGENT_TOKEN_TTL,
      label: input.payload.label,
      subject: input.payload.label,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ExowattConnectorError({
            operation: "issueAgentToken",
            reason: cause.message,
          }),
      ),
    );
  return {
    sessionId: issued.sessionId,
    token: issued.token,
    label: input.payload.label,
    expiresAt: DateTime.formatIso(issued.expiresAt),
    origin: Option.isSome(runtimeState) ? runtimeState.value.origin : null,
  } satisfies ExowattConnectorIssueAgentTokenResult;
});
