// Exowatt distro: where "Logs" (command palette) sends the user. The desktop app reveals its
// log directory in the OS file manager; in a browser, or if the reveal fails, it falls back to
// upstream's Diagnostics settings page (log viewer and "Open logs folder").
import type { DesktopBridge } from "@t3tools/contracts";

export const EXOWATT_LOGS_DIAGNOSTICS_ROUTE = "/settings/diagnostics" as const;

export type ExowattOpenLogsOutcome = "revealed" | "diagnostics";

export interface ExowattOpenLogsInput {
  readonly bridge: Pick<DesktopBridge, "exowattOpenLogsDirectory"> | undefined;
  readonly openDiagnostics: () => void | Promise<void>;
}

export function resolveExowattLogsLabel(
  bridge: Pick<DesktopBridge, "exowattOpenLogsDirectory"> | undefined,
): string {
  return bridge?.exowattOpenLogsDirectory ? "Open logs folder" : "Open logs";
}

export async function openExowattLogs(
  input: ExowattOpenLogsInput,
): Promise<ExowattOpenLogsOutcome> {
  const reveal = input.bridge?.exowattOpenLogsDirectory;
  if (reveal) {
    const revealed = await reveal().catch(() => false);
    if (revealed) return "revealed";
  }
  await input.openDiagnostics();
  return "diagnostics";
}
