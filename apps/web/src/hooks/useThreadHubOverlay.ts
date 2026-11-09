import type {
  ExowattThreadHubEntry,
  ExowattThreadHubUpsertInput,
  ScopedThreadRef,
} from "@t3tools/contracts";

import type { HubArtifactRef } from "../lib/hubArtifacts";
import { exowattThreadHubEnvironment } from "../state/exowattThreadHub";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const NO_ENTRIES: readonly ExowattThreadHubEntry[] = [];

type ItemRef = Pick<HubArtifactRef, "kind" | "key">;

export interface ThreadHubOverlayView {
  /** The thread's pins, hides and hand-added items, live from the server. */
  readonly entries: readonly ExowattThreadHubEntry[];
  /**
   * False until the first snapshot arrives, and against a server that predates
   * the overlay: the Hub then offers no pin, hide or add actions.
   */
  readonly available: boolean;
  readonly setPinned: (ref: ItemRef, pinned: boolean) => Promise<boolean>;
  readonly setHidden: (ref: ItemRef, hidden: boolean) => Promise<boolean>;
  readonly add: (input: ExowattThreadHubUpsertInput) => Promise<boolean>;
  readonly remove: (ref: ItemRef) => Promise<boolean>;
}

/**
 * The thread Hub overlay for one thread. Writes resolve to whether the server
 * took them; the new state arrives through the subscription, on this client
 * and every other one, so there is nothing to apply locally.
 */
export function useThreadHubOverlay(threadRef: ScopedThreadRef): ThreadHubOverlayView {
  const { environmentId, threadId } = threadRef;
  const query = useEnvironmentQuery(
    exowattThreadHubEnvironment.entries({ environmentId, input: { threadId } }),
  );
  const upsert = useAtomCommand(exowattThreadHubEnvironment.upsert, { reportFailure: false });
  const deleteEntry = useAtomCommand(exowattThreadHubEnvironment.remove, {
    reportFailure: false,
  });

  const write = async (input: ExowattThreadHubUpsertInput) =>
    (await upsert({ environmentId, input }))._tag === "Success";
  const setPinned = (ref: ItemRef, pinned: boolean) =>
    write({ threadId, kind: ref.kind, key: ref.key, pinned });
  const setHidden = (ref: ItemRef, hidden: boolean) =>
    write({ threadId, kind: ref.kind, key: ref.key, hidden });
  const remove = async (ref: ItemRef) =>
    (
      await deleteEntry({
        environmentId,
        input: { threadId, kind: ref.kind, key: ref.key },
      })
    )._tag === "Success";

  const snapshot = query.data;
  const entries = snapshot?.threadId === threadId ? snapshot.entries : NO_ENTRIES;
  const available = snapshot !== null && query.error === null;
  return { entries, available, setPinned, setHidden, add: write, remove };
}
