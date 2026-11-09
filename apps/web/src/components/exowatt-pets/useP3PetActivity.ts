import { useEffect, useRef } from "react";
import { resolveP3PetActivity, type P3PetActivityInput } from "./activity";
import { setPetActivity } from "./vendor/react/activityStore";

/** The sole P3 thread adapter; all providers and remote threads use the same signals. */
export function useP3PetActivity(input: P3PetActivityInput) {
  const previous = useRef<P3PetActivityInput | null>(null);
  const {
    threadKey,
    isWorking,
    hasPendingApproval,
    hasPendingUserInput,
    latestTurnOutcome,
    completedAt,
    hasThreadError,
  } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes thread activity into the external pet activity registry.
  useEffect(() => {
    const next = {
      threadKey,
      isWorking,
      hasPendingApproval,
      hasPendingUserInput,
      latestTurnOutcome,
      completedAt,
      hasThreadError,
    };
    const activity = resolveP3PetActivity(next, previous.current);
    previous.current = next;
    setPetActivity(activity, activity === "success" ? { transientForMs: 2_000 } : undefined);
  }, [
    threadKey,
    isWorking,
    hasPendingApproval,
    hasPendingUserInput,
    latestTurnOutcome,
    completedAt,
    hasThreadError,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the external pet activity registry on unmount.
  useEffect(
    () => () => {
      setPetActivity("idle");
      previous.current = null;
    },
    [],
  );
}
