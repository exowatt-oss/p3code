import type { EnvironmentId, ExowattFeadsStatus } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "../state/environments";
import { exowattFeadsEnvironment } from "../state/exowattFeads";
import { useEnvironmentQuery } from "../state/query";

export interface ExowattFeadsStatusView {
  readonly environmentId: EnvironmentId | null;
  /** `null` until the first snapshot arrives or when no server is connected. */
  readonly status: ExowattFeadsStatus | null;
  /** Subscription failure, e.g. a server that predates the feads integration. */
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Live feads status for the primary server: configured or not, who the token
 * resolves to, and the poller's last result, for Settings › Sharing & access.
 */
export function useExowattFeadsStatus(): ExowattFeadsStatusView {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : exowattFeadsEnvironment.status({ environmentId, input: {} }),
  );
  return {
    environmentId,
    status: query.data,
    error: query.error,
    isPending: query.isPending,
  };
}
