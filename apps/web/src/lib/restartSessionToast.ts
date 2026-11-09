import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { RestartProviderSessionsResult } from "./restartProviderSessions";

/** Toast the counts from a fan-out restart. */
export function toastProviderSessionsRestart(result: RestartProviderSessionsResult): void {
  const details = [
    `${result.restarted} restarted`,
    ...(result.skippedRunning > 0 ? [`${result.skippedRunning} running skipped`] : []),
    ...(result.failed > 0 ? [`${result.failed} failed`] : []),
  ].join(" · ");
  toastManager.add(
    stackedThreadToast({
      type: result.failed > 0 ? "error" : result.restarted > 0 ? "success" : "info",
      title:
        result.restarted > 0
          ? `Restarted ${result.restarted} Phi session${result.restarted === 1 ? "" : "s"}`
          : "No idle Phi sessions to restart",
      description: details,
    }),
  );
}
