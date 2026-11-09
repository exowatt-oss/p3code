import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useRestartPhiSessions } from "../../hooks/useRestartProviderSessions";
import { Button } from "../ui/button";
import { toastProviderSessionsRestart } from "../../lib/restartSessionToast";
import { SettingsRow } from "./settingsLayout";

/**
 * Exowatt: phi upgrades only take effect when a thread's phi process is
 * replaced, and idle sessions keep the old binary alive indefinitely. This
 * stops every idle phi session (running turns are left alone) through the
 * regular session-stop command; the next message starts a fresh process.
 */
export function ExowattRestartPhiSessionsRow({
  readOnly = false,
}: {
  readonly readOnly?: boolean;
}) {
  const restartAll = useRestartPhiSessions();
  const [isRestarting, setIsRestarting] = useState(false);

  return (
    <SettingsRow
      title="Restart Phi sessions"
      description="Stop every idle Phi session on connected devices so the next message starts on the currently installed phi binary. Running turns are skipped."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || isRestarting}
          aria-busy={isRestarting}
          onClick={() => {
            setIsRestarting(true);
            void restartAll()
              .then(toastProviderSessionsRestart)
              .finally(() => setIsRestarting(false));
          }}
        >
          <RefreshCwIcon className={isRestarting ? "animate-spin" : undefined} />
          {isRestarting ? "Restarting…" : "Restart all"}
        </Button>
      }
    />
  );
}
