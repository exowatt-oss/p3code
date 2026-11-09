import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  restartProviderSessions,
  type RestartableProviderSessionThread,
} from "./restartProviderSessions";

const environmentId = EnvironmentId.make("local");
const phi = ProviderInstanceId.make("phi");
const codex = ProviderInstanceId.make("codex");

function thread(
  id: string,
  status: ThreadRuntimeSummary["status"] | null,
  options: {
    readonly instanceId?: ProviderInstanceId;
    readonly activeRunId?: string | null;
    readonly archivedAt?: string | null;
  } = {},
): RestartableProviderSessionThread {
  return {
    environmentId,
    id: ThreadId.make(id),
    archivedAt: options.archivedAt ?? null,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: options.activeRunId ? RunId.make(options.activeRunId) : null,
            providerInstanceId: options.instanceId ?? phi,
          },
  };
}

describe("restartProviderSessions", () => {
  it("stops every settled phi runtime and skips runs in flight", async () => {
    const stopped: string[] = [];
    const result = await restartProviderSessions({
      threads: [
        thread("idle", "idle"),
        thread("completed", "completed"),
        thread("failed", "failed"),
        thread("queued-behind-nothing", "queued"),
        thread("running", "running", { activeRunId: "run-1" }),
        thread("waiting", "waiting", { activeRunId: "run-2" }),
        thread("starting", "starting"),
        thread("queued-behind-active", "queued", { activeRunId: "run-3" }),
        thread("never-ran", null),
        thread("archived", "idle", { archivedAt: "2026-10-01T00:00:00.000Z" }),
        thread("codex", "idle", { instanceId: codex }),
      ],
      driver: ProviderDriverKind.make("phi"),
      resolveDriver: (_environmentId, instanceId) =>
        instanceId === phi ? ProviderDriverKind.make("phi") : ProviderDriverKind.make("codex"),
      stop: async (candidate) => {
        stopped.push(candidate.id);
      },
    });

    expect(stopped).toEqual(["idle", "completed", "failed", "queued-behind-nothing"]);
    expect(result).toEqual({ restarted: 4, failed: 0, skippedRunning: 4 });
  });

  it("continues after individual failures and reports them", async () => {
    const stop = vi.fn(async (candidate: RestartableProviderSessionThread) => {
      if (candidate.id === "broken") throw new Error("nope");
    });
    const result = await restartProviderSessions({
      threads: Array.from({ length: 6 }, (_, index) =>
        thread(index === 2 ? "broken" : `healthy-${index}`, "idle"),
      ),
      driver: ProviderDriverKind.make("phi"),
      resolveDriver: () => ProviderDriverKind.make("phi"),
      stop,
    });

    expect(stop).toHaveBeenCalledTimes(6);
    expect(result).toEqual({ restarted: 5, failed: 1, skippedRunning: 0 });
  });
});
