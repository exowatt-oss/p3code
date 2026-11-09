import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadThreadProjection, readLoadedThreadProjection } from "../state/entities";
import { readRestartThreadSessionAvailability } from "./useRestartThreadSession";

vi.mock("../state/entities", () => ({
  loadThreadProjection: vi.fn(),
  readLoadedThreadProjection: vi.fn(),
  readThreadShell: vi.fn(),
}));

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("test-environment"),
  threadId: ThreadId.make("test-thread"),
};

beforeEach(() => vi.clearAllMocks());

describe("sidebar restart-session availability", () => {
  it("returns immediately for a sidebar-only thread even if its detail never loads", () => {
    vi.mocked(readLoadedThreadProjection).mockReturnValue(null);
    vi.mocked(loadThreadProjection).mockImplementation(() => new Promise(() => {}));

    expect(readRestartThreadSessionAvailability(ref)).toBeNull();
    expect(loadThreadProjection).toHaveBeenCalledWith(ref);
  });

  it("uses already-loaded sessions without starting a new detail fetch", () => {
    vi.mocked(readLoadedThreadProjection).mockReturnValue({
      providerSessions: [{ status: "running" }],
    } as unknown as NonNullable<ReturnType<typeof readLoadedThreadProjection>>);

    expect(readRestartThreadSessionAvailability(ref)).toBe(true);
    expect(loadThreadProjection).not.toHaveBeenCalled();
  });

  it("keeps an unavailable detail disabled even when loading rejects", async () => {
    vi.mocked(readLoadedThreadProjection).mockReturnValue(null);
    vi.mocked(loadThreadProjection).mockRejectedValue(new Error("disconnected"));

    expect(readRestartThreadSessionAvailability(ref)).toBeNull();
    await Promise.resolve();
    expect(loadThreadProjection).toHaveBeenCalledWith(ref);
  });
});
