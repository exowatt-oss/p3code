/**
 * Exowatt: Phi (Pi's RPC protocol) on `makePiAdapterV2` under the `phi` driver, adding session-scoped
 * `set_model`, a passive durable `workspace-state` item (never a runtime question), fallback model
 * adoption with a notice, and the login-shell environment plus a per-session Feads credential.
 */
import { PhiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  makePiAdapterV2,
  piRecordField,
  piRecordString,
  type PiAdapterV2DriverEnv,
  type PiAdapterV2Flavor,
  type PiAdapterV2SessionHookContext,
  type PiAdapterV2SessionHooks,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server";

import * as HarnessLaunchEnvironment from "../../provider/HarnessLaunchEnvironment.ts";
import { FeadsService } from "../../feads/FeadsService.ts";
import { phiCompactionEnvironment } from "../../provider/phi/PhiCompactionEnvironment.ts";
import {
  FEADS_AGENT_TOKEN_ENV,
  LEGACY_FEADS_TOKEN_ENV,
  phiFeadsDisabled,
  phiFeadsEnvironment,
  type P3FeadsCredential,
} from "../../provider/phi/PhiFeadsEnvironment.ts";
import {
  phiWorkspaceStateFromEntryAppended,
  type PhiWorkspaceStateRecord,
} from "../../provider/phi/PhiWorkspaceState.ts";

export const PHI_PROVIDER = ProviderDriverKind.make("phi");
const DEFAULT_PHI_SETTINGS: PhiSettings = Schema.decodeSync(PhiSettings)({});

const PHI_MCP_BROWSER_AUTH_ENV = "PHI_MCP_BROWSER_AUTH";

const PHI_FALLBACK_EVENTS = new Set([
  "refusal_fallback",
  "refusal_fallback_exhausted",
  "refusal_fallback_restored",
  "error_fallback",
  "error_fallback_exhausted",
  "error_fallback_restored",
]);

/**
 * Notice text for a fallback event. `from`/`to` are `provider/id` refs;
 * `*_exhausted` carries `from` + `tried[]` and no `to`. `error_fallback`
 * carries `reason`, `refusal_fallback` carries `explanation` + `category`.
 */
function phiFallbackNotice(type: string, event: PiRpcRecord): string {
  const target = piRecordString(event, "to");
  const from = piRecordString(event, "from");
  const reason =
    piRecordString(event, "reason") ??
    piRecordString(event, "explanation") ??
    piRecordString(event, "category");
  const triedField = piRecordField(event, "tried");
  const tried = Array.isArray(triedField)
    ? triedField.filter((entry): entry is string => typeof entry === "string")
    : [];
  const headline = type.endsWith("_exhausted")
    ? `Phi exhausted its fallback chain after ${from ?? "the selected model"}${
        tried.length > 0 ? ` (tried: ${tried.join(", ")})` : ""
      }`
    : target === undefined
      ? `Phi fallback: ${type}`
      : type.endsWith("_restored")
        ? `Phi restored ${target} after its fallback`
        : `Phi rerouted to ${target}${from ? ` from ${from}` : ""}`;
  return reason ? `${headline}: ${reason}` : headline;
}

export function makePhiSessionHooks(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
): (context: PiAdapterV2SessionHookContext) => PiAdapterV2SessionHooks {
  return (context) => {
    let turnWorkspaceState: { providerTurnId: string; record: PhiWorkspaceStateRecord } | null =
      null;

    const onFallback = Effect.fnUntraced(function* (type: string, event: PiRpcRecord) {
      const target = piRecordString(event, "to");
      if (target !== undefined) {
        const thinkingLevel = piRecordString(event, "thinkingLevel");
        // A refusal escalation is sticky in Phi: adopt it without forcing the
        // thread's model back. An error reroute is host-managed and clamps the
        // thinking level, so the thread's selection is re-sent next turn.
        yield* context.adoptModel({
          model: target,
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          reassertSelection: type.startsWith("error_fallback"),
        });
      }
      yield* context.emitNotice({ message: phiFallbackNotice(type, event) });
    });

    return {
      onTurnStart: () => {
        turnWorkspaceState = null;
        return Effect.void;
      },
      onTurnSettled: Effect.fnUntraced(function* (turn, status, completedAt) {
        const pending = turnWorkspaceState;
        turnWorkspaceState = null;
        if (status === "interrupted" || pending?.providerTurnId !== turn.providerTurn.id) {
          return;
        }
        const { record } = pending;
        const nativeItemId = `workspace-state:${turn.providerTurn.id}`;
        const recordedAt = DateTime.formatIso(completedAt);
        // A v2 turn item is the durable thread activity: the event sink persists
        // it and projects it to every client, including after session restart.
        yield* context.emit({
          type: "turn_item.updated",
          driver: context.driver,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: context.driver,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: { driver: context.driver, nativeId: nativeItemId, strength: "weak" },
            parentItemId: null,
            ordinal: turn.itemOrdinal(nativeItemId),
            status: "completed",
            title: "Session state",
            startedAt: completedAt,
            completedAt,
            updatedAt: completedAt,
            type: "workspace_state",
            payload: {
              endState: record.endState,
              ...(record.question ? { question: record.question } : {}),
              openItems: [...record.openItems],
              ...(record.feadsEpic ? { feadsEpic: record.feadsEpic } : {}),
              recordedAt,
            },
          },
        });
      }),
      onUnhandledEvent: (event) => {
        switch (event["type"]) {
          case "entry_appended": {
            const record = phiWorkspaceStateFromEntryAppended(event);
            const turn = context.activeTurn();
            if (record === undefined || turn === null) return Effect.void;
            // Only the final record of this turn is emitted at settlement.
            turnWorkspaceState = { providerTurnId: turn.providerTurn.id, record };
            return Effect.void;
          }
          default: {
            const type = piRecordString(event, "type") ?? "";
            if (!PHI_FALLBACK_EVENTS.has(type)) return Effect.void;
            return onFallback(type, event).pipe(Effect.ignore({ log: true }));
          }
        }
      },
    };
  };
}

// Phi's MCP extension reports every server's connect/OAuth status as a `notify`; as timeline
// rows that is one warning per configured server on every new thread. Hub › Connectors and
// Customize › MCP show that status instead.
export const isPhiMcpStatusNotice = (message: string): boolean => message.startsWith("mcp: ");

export const makePhiAdapterV2Flavor = (
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
): PiAdapterV2Flavor => ({
  label: "Phi",
  sessionScopedModelSwitch: true,
  makeSessionHooks: makePhiSessionHooks(idAllocator),
  showsExtensionNotice: (message) => !isPhiMcpStatusNotice(message),
});

export type PhiAdapterV2DriverEnv =
  | PiAdapterV2DriverEnv
  | HarnessLaunchEnvironment.HarnessLaunchEnvironment;

export const PhiAdapterV2Driver: ProviderAdapterDriver<PhiSettings, PhiAdapterV2DriverEnv> = {
  driverKind: PHI_PROVIDER,
  configSchema: PhiSettings,
  defaultConfig: (): PhiSettings => DEFAULT_PHI_SETTINGS,
  create: Effect.fn("PhiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PhiSettings>) {
      const harnessEnvironment = yield* HarnessLaunchEnvironment.forChild();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      // Optional so registry tests can build every driver without feads; the
      // server provides it, and without it Phi falls back to the shell's token.
      const feads = yield* Effect.serviceOption(FeadsService);
      if (Option.isNone(feads)) {
        yield* Effect.logWarning("Phi adapter built without FeadsService; P3 feads token unused.");
      }
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        harnessEnvironment,
      );
      // The overlay below cannot delete inherited keys. When Phi is opted out,
      // strip both token names from its child environment before opening any session.
      if (phiFeadsDisabled(environment)) {
        delete environment[FEADS_AGENT_TOKEN_ENV];
        delete environment[LEGACY_FEADS_TOKEN_ENV];
      }
      const feadsCredential: Effect.Effect<P3FeadsCredential | undefined> = Option.isNone(feads)
        ? Effect.undefined
        : feads.value.resolvedConfig.pipe(
            Effect.map((config) => ({ token: config.token, baseUrl: config.baseUrl })),
          );
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment,
        // Read per session, so re-configuring the feads token in Settings
        // takes effect on the next session instead of at server restart.
        sessionEnvironment: feadsCredential.pipe(
          Effect.map((p3Feads) => ({
            ...phiFeadsEnvironment({ environment, p3Feads }),
            ...phiCompactionEnvironment({ environment }),
            [PHI_MCP_BROWSER_AUTH_ENV]: "1",
          })),
        ),
        driver: PHI_PROVIDER,
        flavor: makePhiAdapterV2Flavor(idAllocator),
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PHI_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Phi adapter.",
              cause,
            }),
        ),
      ),
  ),
};
