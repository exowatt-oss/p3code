import { useNavigate } from "@tanstack/react-router";

import {
  EXOWATT_LOGS_DIAGNOSTICS_ROUTE,
  openExowattLogs,
  resolveExowattLogsLabel,
} from "./exowattLogs";

export function useExowattOpenLogs() {
  const navigate = useNavigate();
  const label = resolveExowattLogsLabel(window.desktopBridge);
  const openLogs = () =>
    openExowattLogs({
      bridge: window.desktopBridge,
      openDiagnostics: () => navigate({ to: EXOWATT_LOGS_DIAGNOSTICS_ROUTE }),
    });
  return { label, openLogs };
}
