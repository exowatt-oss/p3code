import { describe, expect, it, vi } from "vite-plus/test";

import { openExowattLogs, resolveExowattLogsLabel } from "./exowattLogs";

describe("openExowattLogs", () => {
  it("reveals the log directory through the desktop bridge when available", async () => {
    const reveal = vi.fn(async () => true);
    const openDiagnostics = vi.fn();

    await expect(
      openExowattLogs({ bridge: { exowattOpenLogsDirectory: reveal }, openDiagnostics }),
    ).resolves.toBe("revealed");

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(openDiagnostics).not.toHaveBeenCalled();
  });

  it("falls back to the diagnostics page in browser mode", async () => {
    const openDiagnostics = vi.fn();

    await expect(openExowattLogs({ bridge: undefined, openDiagnostics })).resolves.toBe(
      "diagnostics",
    );
    await expect(openExowattLogs({ bridge: {}, openDiagnostics })).resolves.toBe("diagnostics");

    expect(openDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("falls back to the diagnostics page when the reveal fails or rejects", async () => {
    const openDiagnostics = vi.fn();

    await expect(
      openExowattLogs({
        bridge: { exowattOpenLogsDirectory: async () => false },
        openDiagnostics,
      }),
    ).resolves.toBe("diagnostics");
    await expect(
      openExowattLogs({
        bridge: { exowattOpenLogsDirectory: () => Promise.reject(new Error("ipc down")) },
        openDiagnostics,
      }),
    ).resolves.toBe("diagnostics");

    expect(openDiagnostics).toHaveBeenCalledTimes(2);
  });
});

describe("resolveExowattLogsLabel", () => {
  it("describes the folder reveal only when the bridge offers it", () => {
    expect(resolveExowattLogsLabel({ exowattOpenLogsDirectory: async () => true })).toBe(
      "Open logs folder",
    );
    expect(resolveExowattLogsLabel({})).toBe("Open logs");
    expect(resolveExowattLogsLabel(undefined)).toBe("Open logs");
  });
});
