import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { readLocalApi } from "../localApi";
import {
  loadThreadProjection,
  readLoadedThreadProjection,
  readThreadShell,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function hasLiveProviderSession(
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions"> | null,
): boolean {
  return (
    projection?.providerSessions.some(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? false
  );
}

/** Only a loaded detail can answer synchronously; sidebar shells contain no session state. */
export function readRestartThreadSessionAvailability(ref: ScopedThreadRef): boolean | null {
  const projection = readLoadedThreadProjection(ref);
  if (projection !== null) return hasLiveProviderSession(projection);
  // Menu callers get an immediate disabled/unknown state. Loading the detail
  // only helps a later open; a missing or unreachable environment cannot stall
  // the current context menu.
  void canRestartThreadSession(ref).catch(() => {});
  return null;
}

/** The shell has no session field; the detail projection owns the attached sessions. */
export async function canRestartThreadSession(ref: ScopedThreadRef): Promise<boolean> {
  return hasLiveProviderSession(await loadThreadProjection(ref));
}

/** A loaded detail answers synchronously, so a menu opens without waiting on a fetch. */
export function resolveRestartThreadSessionAvailability(
  ref: ScopedThreadRef,
): boolean | Promise<boolean> {
  const projection = readLoadedThreadProjection(ref);
  return projection !== null ? hasLiveProviderSession(projection) : canRestartThreadSession(ref);
}

const restarting = new Set<string>();

function useStopSession() {
  return useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
}

// Outside the hook: the React Compiler skips a hook with try/finally or a throw inside try.
export async function restartThreadSession(
  ref: ScopedThreadRef,
  stop: ReturnType<typeof useStopSession>,
): Promise<boolean> {
  const key = `${ref.environmentId}:${ref.threadId}`;
  if (restarting.has(key)) return false;
  restarting.add(key);
  try {
    if (!(await canRestartThreadSession(ref))) {
      toastManager.add({
        type: "info",
        title: "No session to restart",
        description: "Your next message already starts fresh.",
      });
      return false;
    }
    const thread = readThreadShell(ref);
    if (
      thread?.runtime?.status === "preparing" ||
      thread?.runtime?.status === "starting" ||
      thread?.runtime?.status === "running" ||
      thread?.runtime?.status === "waiting"
    ) {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        `Restart the session for "${thread.title}"?\nThis thread has a turn in flight. Restarting interrupts it; the thread keeps its history and the next message starts a fresh session.`,
        { variant: "destructive" },
      );
      if (!confirmed) return false;
    }
    const result = await stop({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    toastManager.add({
      type: "success",
      title: "Agent session will restart",
      description: "Your next message starts a fresh session.",
    });
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not restart session",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  } finally {
    restarting.delete(key);
  }
}

export function useRestartThreadSession() {
  const stop = useStopSession();
  return (ref: ScopedThreadRef) => restartThreadSession(ref, stop);
}
