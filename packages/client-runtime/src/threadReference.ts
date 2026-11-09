import type {
  ComposerContextClipboardFragment,
  ScopedThreadRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  /** The plain text: a PR URL, or a link that opens the thread from anywhere. */
  readonly value: string;
  /** What a toast or palette row shows for the copy. */
  readonly description: string;
  /** T3's clipboard format, which pastes a thread back into a composer as a chip. */
  readonly fragment?: ComposerContextClipboardFragment;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

/**
 * exowatt: the plain text is P3's `[title](p3://thread/<id>)` Markdown link, the form agents
 * write, never a hosted app link (`_hostedAppUrl` stays for upstream's call sites). It pastes
 * back as a chip into any composer whose agent reads that thread's machine.
 */
export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
  _hostedAppUrl?: string,
): ThreadReferenceCopyTarget {
  const record = threadContextRecord(threadRef, title);
  return {
    kind: "thread",
    value: formatThreadLink({ environmentId: null, threadId: threadRef.threadId }, title),
    description: record.title,
    fragment: { version: 1, source: { environmentId: threadRef.environmentId }, records: [record] },
    clipboardTarget: "thread",
    successTitle: "Thread copied",
    failureTitle: "Failed to copy thread",
  };
}

/**
 * exowatt: Copy thread link always copies the thread, never a PR URL (P3 ledger). The
 * pull-request fields stay so upstream's call sites compile; they are ignored.
 */
export function resolveThreadReferenceCopyTarget(input: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly openPanelPullRequestUrl?: string | null | undefined;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequestUrl?: string | null;
  readonly hostedAppUrl?: string;
}): ThreadReferenceCopyTarget {
  return threadChipCopyTarget(input.threadRef, input.title, input.hostedAppUrl);
}
