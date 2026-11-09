/**
 * Exowatt: P3 sink for Phi's workspace-state contract v1.
 * Phi appends one `workspace-state` custom entry at `agent_settled` (RPC `entry_appended`, before
 * the turn closes); it is stored as a turn item and `awaiting-human` is a passive hand-back.
 * Older Phi builds emit nothing, so a missing or malformed record is `undefined`.
 */
import { piRecordField, piRecordString } from "@t3tools/provider-pi/server";

export const PHI_WORKSPACE_STATE_ENTRY = "workspace-state";

const PHI_WORKSPACE_END_STATES = [
  "complete",
  "awaiting-human",
  "mid-work",
  "blocked-approval",
] as const;
export type PhiWorkspaceEndState = (typeof PHI_WORKSPACE_END_STATES)[number];

export interface PhiWorkspaceStateRecord {
  readonly endState: PhiWorkspaceEndState;
  /** Contract `question`: the exact decision requested; present iff `awaiting-human`. */
  readonly question: string | undefined;
  readonly openItems: ReadonlyArray<string>;
  readonly feadsEpic: string | undefined;
}

/** Reads a `workspace-state` record out of an `entry_appended` event, ignoring other entries. */
export function phiWorkspaceStateFromEntryAppended(
  record: unknown,
): PhiWorkspaceStateRecord | undefined {
  const entry = piRecordField(record, "entry");
  if (piRecordString(entry, "type") !== "custom") return undefined;
  if (piRecordString(entry, "customType") !== PHI_WORKSPACE_STATE_ENTRY) return undefined;
  const data = piRecordField(entry, "data");
  const endState = piRecordString(data, "end_state");
  if (endState === undefined || !isEndState(endState)) return undefined;
  const question = piRecordString(data, "question")?.trim();
  const rawOpenItems = piRecordField(data, "open_items");
  const openItems = Array.isArray(rawOpenItems)
    ? rawOpenItems.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    : [];
  const feadsEpic = piRecordString(piRecordField(data, "feads"), "epic")?.trim();
  return {
    endState,
    question: question && question.length > 0 ? question : undefined,
    openItems,
    feadsEpic: feadsEpic || undefined,
  };
}

function isEndState(value: string): value is PhiWorkspaceEndState {
  return (PHI_WORKSPACE_END_STATES as ReadonlyArray<string>).includes(value);
}
