import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

/** The shell fields the restart-all loop reads. */
export interface RestartableProviderSessionThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly runtime: Pick<
    ThreadRuntimeSummary,
    "status" | "activeRunId" | "providerInstanceId"
  > | null;
}

export interface RestartProviderSessionsResult {
  readonly restarted: number;
  readonly failed: number;
  readonly skippedRunning: number;
}

/** Stops run a few at a time: each one reads the thread projection first. */
const STOP_CONCURRENCY = 4;

function runtimeIsInFlight(runtime: NonNullable<RestartableProviderSessionThread["runtime"]>) {
  switch (runtime.status) {
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return true;
    case "queued":
      return runtime.activeRunId !== null;
    default:
      return false;
  }
}

/**
 * Exowatt: stop the provider session of every unarchived thread whose runtime
 * belongs to `driver`, skipping threads with a run in flight. The next message
 * follows the normal session-start path, so this is a plain client loop over
 * `stopThreadSession`, not a second restart protocol.
 */
export async function restartProviderSessions(input: {
  readonly threads: ReadonlyArray<RestartableProviderSessionThread>;
  readonly driver: ProviderDriverKind;
  readonly resolveDriver: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => ProviderDriverKind | null;
  readonly stop: (thread: RestartableProviderSessionThread) => Promise<void>;
}): Promise<RestartProviderSessionsResult> {
  let skippedRunning = 0;
  const eligible = input.threads.filter((thread) => {
    const runtime = thread.runtime;
    if (runtime === null || thread.archivedAt !== null) return false;
    if (input.resolveDriver(thread.environmentId, runtime.providerInstanceId) !== input.driver) {
      return false;
    }
    if (runtimeIsInFlight(runtime)) {
      skippedRunning += 1;
      return false;
    }
    return true;
  });

  let restarted = 0;
  let failed = 0;
  for (let index = 0; index < eligible.length; index += STOP_CONCURRENCY) {
    const settled = await Promise.allSettled(
      eligible.slice(index, index + STOP_CONCURRENCY).map((thread) => input.stop(thread)),
    );
    for (const result of settled) {
      if (result.status === "rejected") failed += 1;
      else restarted += 1;
    }
  }
  return { restarted, failed, skippedRunning };
}
