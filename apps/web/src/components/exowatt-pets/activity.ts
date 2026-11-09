import type { OrchestrationV2RunStatus } from "@t3tools/contracts";
import type { PetActivity } from "./vendor/core/animation";

export interface P3PetActivityInput {
  readonly threadKey: string;
  readonly isWorking: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  /** The latest run's status. */
  readonly latestTurnOutcome: OrchestrationV2RunStatus | null;
  readonly completedAt: string | null;
  readonly hasThreadError: boolean;
}

/** Only celebrate a new completion in the same thread, never opening old history. */
export function resolveP3PetActivity(
  input: P3PetActivityInput,
  previous: P3PetActivityInput | null,
): PetActivity {
  if (input.hasPendingApproval || input.hasPendingUserInput) return "waiting-for-user";
  if (input.isWorking) return "working";
  if (input.hasThreadError || input.latestTurnOutcome === "failed") return "error";
  if (
    previous?.threadKey === input.threadKey &&
    input.latestTurnOutcome === "completed" &&
    (previous.isWorking || input.completedAt !== previous.completedAt)
  )
    return "success";
  return "idle";
}
