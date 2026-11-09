import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  restartProviderSessions,
  type RestartProviderSessionsResult,
} from "../lib/restartProviderSessions";

/** Exowatt: "Restart all Phi sessions" (Settings › Providers and the command palette). */
export function useRestartPhiSessions(): () => Promise<RestartProviderSessionsResult> {
  const threads = useThreadShells();
  const providersByEnvironment = useEnvironmentProviders();
  const { environments } = useEnvironments();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  // Cached shells survive a disconnect; a stop dispatched at an offline
  // environment cannot succeed, so only connected environments take part.
  const connectedEnvironmentIds = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const driverByEnvironmentAndInstance = new Map<string, ProviderDriverKind>();
  for (const [environmentId, providers] of providersByEnvironment) {
    for (const provider of deriveProviderInstanceEntries(providers)) {
      driverByEnvironmentAndInstance.set(
        `${environmentId}:${provider.instanceId}`,
        provider.driverKind,
      );
    }
  }

  return () =>
    restartProviderSessions({
      threads: threads.filter((thread) => connectedEnvironmentIds.has(thread.environmentId)),
      driver: ProviderDriverKind.make("phi"),
      resolveDriver: (environmentId: EnvironmentId, instanceId: ProviderInstanceId) =>
        driverByEnvironmentAndInstance.get(`${environmentId}:${instanceId}`) ?? null,
      stop: async (thread) => {
        const result = await stopThreadSession({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
        if (result._tag === "Failure") throw new Error("Failed to stop provider session");
      },
    });
}
