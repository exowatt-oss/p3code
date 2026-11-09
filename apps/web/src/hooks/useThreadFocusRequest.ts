import type { AnyRouter } from "@tanstack/react-router";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";

/** Scoped per environment: each environment's request is its own act. */
const APPLIED_THREAD_FOCUS_STORAGE_PREFIX = "t3code:thread-focus-applied:v1:";

/**
 * A request older than this is history, not an instruction: a client opened
 * an hour later must not be dragged to whatever thread was asked for then.
 */
export const THREAD_FOCUS_REQUEST_MAX_AGE_MS = 30_000;

/**
 * The request generation to act on, or null to leave this client where it is.
 * Pure so the rule -- act once per request, never replay one already acted
 * on, ignore stale ones -- can be tested without a renderer.
 */
export function threadFocusRequestToApply(input: {
  readonly environmentId: string | null;
  readonly threadId: string;
  readonly requestedAt: string;
  readonly appliedGeneration: string | null;
  readonly now: number;
}): string | null {
  if (input.environmentId === null) return null;
  if (input.threadId.length === 0 || input.requestedAt.length === 0) return null;
  if (input.appliedGeneration === input.requestedAt) return null;
  const requestedAtMs = Date.parse(input.requestedAt);
  if (Number.isNaN(requestedAtMs)) return null;
  if (input.now - requestedAtMs > THREAD_FOCUS_REQUEST_MAX_AGE_MS) return null;
  return input.requestedAt;
}

function readAppliedGeneration(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeAppliedGeneration(storageKey: string, generation: string): void {
  try {
    window.localStorage.setItem(storageKey, generation);
  } catch {
    // Unrecordable means a later config event navigates again; harmless.
  }
}

/**
 * Acts on the environment's thread-focus request (`thread_focus` over MCP) for
 * the life of the app: navigates this client to the thread once per request generation.
 */
export function startThreadFocusRequestAdoption(router: AnyRouter): () => void {
  const adopt = () => {
    if (typeof window === "undefined") return;
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (environmentId === null) return;
    const { exowattThreadFocusRequest } = appAtomRegistry.get(primaryServerSettingsAtom);
    const storageKey = `${APPLIED_THREAD_FOCUS_STORAGE_PREFIX}${environmentId}`;
    const generation = threadFocusRequestToApply({
      environmentId,
      threadId: exowattThreadFocusRequest.threadId,
      requestedAt: exowattThreadFocusRequest.requestedAt,
      appliedGeneration: readAppliedGeneration(storageKey),
      now: Date.now(),
    });
    if (generation === null) return;
    writeAppliedGeneration(storageKey, generation);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: exowattThreadFocusRequest.threadId },
    });
    // Best effort: a browser client comes to its tab; the desktop window is
    // brought forward by whoever asked (`open -a "P3 Code"` on macOS).
    window.focus();
  };
  const unsubscribes = [
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, adopt),
    appAtomRegistry.subscribe(primaryServerSettingsAtom, adopt),
  ];
  adopt();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
