import type { ClientSettingsPatch } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";
import {
  isClientSettingsHydrated,
  subscribeClientSettingsHydration,
  updateClientSettings,
} from "./useSettings";

/**
 * Scoped per environment like the default theme: each environment's push is
 * its own act, so hopping between primary environments neither replays one
 * environment's push over the user's picks nor swallows another's.
 */
const APPLIED_CLIENT_SETTINGS_PUSH_STORAGE_PREFIX = "t3code:client-settings-push-applied:v1:";

/**
 * The push generation to apply, or null to leave this client alone. Pure so
 * the rule -- apply once per push, never replay one already applied, wait for
 * the client's own settings to load first -- can be tested without a renderer.
 */
export function clientSettingsPushToApply(input: {
  readonly environmentId: string | null;
  readonly setAt: string;
  readonly patch: ClientSettingsPatch;
  readonly appliedGeneration: string | null;
  readonly hydrated: boolean;
}): string | null {
  if (input.environmentId === null || input.setAt.length === 0) return null;
  if (Object.keys(input.patch).length === 0) return null;
  if (input.appliedGeneration === input.setAt) return null;
  // Applying before hydration would merge the patch into the schema defaults
  // and then persist that, wiping every preference this client had saved.
  if (!input.hydrated) return null;
  return input.setAt;
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
    // Unrecordable means the next config event applies again; harmless.
  }
}

function adoptClientSettingsPush(): void {
  if (typeof window === "undefined") return;
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return;
  const { exowattClientSettingsPush } = appAtomRegistry.get(primaryServerSettingsAtom);
  const storageKey = `${APPLIED_CLIENT_SETTINGS_PUSH_STORAGE_PREFIX}${environmentId}`;
  const generation = clientSettingsPushToApply({
    environmentId,
    setAt: exowattClientSettingsPush.setAt,
    patch: exowattClientSettingsPush.patch,
    appliedGeneration: readAppliedGeneration(storageKey),
    hydrated: isClientSettingsHydrated(),
  });
  if (generation === null) return;
  updateClientSettings(exowattClientSettingsPush.patch);
  writeAppliedGeneration(storageKey, generation);
}

/**
 * Applies the environment's client-settings push (`client_settings_apply`
 * over MCP) for the life of the app. Each push changes this client once, live
 * or on the next connect, then a preference the user picks wins until the next push.
 */
export function startClientSettingsPushAdoption(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, adoptClientSettingsPush),
    appAtomRegistry.subscribe(primaryServerSettingsAtom, adoptClientSettingsPush),
    subscribeClientSettingsHydration(adoptClientSettingsPush),
  ];
  adoptClientSettingsPush();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
