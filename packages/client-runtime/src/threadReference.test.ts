import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import {
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { threadLinkContextReferences } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget, threadChipCopyTarget } from "./threadReference.ts";

const thread = {
  threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  title: "Fix the login flow",
};

const crossRepositoryPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "other/repo",
  number: 42,
  url: "https://github.com/other/repo/pull/42",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("resolveThreadReferenceCopyTarget", () => {
  // exowatt: Copy thread link never copies a PR URL or a bare id (P3 ledger).
  it("always copies the P3 thread link, even with a pull request", () => {
    for (const openPanelPullRequestUrl of [null, "https://github.com/t3/pr/14", undefined]) {
      expect(
        resolveThreadReferenceCopyTarget({
          ...thread,
          openPanelPullRequestUrl,
          pullRequests: [crossRepositoryPullRequest],
          linkedPullRequestUrl: "https://github.com/t3/pr/12",
        }),
      ).toMatchObject({
        kind: "thread",
        value: "[Fix the login flow](p3://thread/thread-1)",
      });
    }
  });

  it("encodes the thread id as one link segment", () => {
    const target = threadChipCopyTarget(
      {
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread:project:abc:delegated-task:request)1"),
      },
      "Review",
    );
    expect(target.value).toBe(
      "[Review](p3://thread/thread%3Aproject%3Aabc%3Adelegated-task%3Arequest%291)",
    );
  });

  it("copies a titleless thread as an autolink", () => {
    expect(resolveThreadReferenceCopyTarget({ ...thread, title: "" }).value).toBe(
      "<p3://thread/thread-1>",
    );
  });

  it("copies a thread chip that pastes back as the same thread on its machine", () => {
    const target = resolveThreadReferenceCopyTarget({ ...thread, linkedPullRequestUrl: null });

    expect(target).toMatchObject({
      kind: "thread",
      description: "Fix the login flow",
      successTitle: "Thread copied",
    });
    const pasted = decodeComposerContextFragment(encodeComposerContextFragment(target.fragment!));
    expect(pasted).toEqual({
      version: 1,
      source: { environmentId: "env-1" },
      records: [
        expect.objectContaining({
          kind: "thread",
          environmentId: "env-1",
          threadId: "thread-1",
          title: "Fix the login flow",
        }),
      ],
    });
    // The plain text is the P3 link agents write, and pastes back as the copied record's chip.
    expect(target.value).toBe("[Fix the login flow](p3://thread/thread-1)");
    expect(threadLinkContextReferences(target.value, pasted!.records, () => undefined)).toEqual({
      text: `[Fix the login flow](t3-context://v1/thread/${pasted!.records[0]!.contextId})`,
      records: pasted!.records,
    });
  });

  it("never links through a hosted app", () => {
    expect(
      resolveThreadReferenceCopyTarget({ ...thread, hostedAppUrl: "https://preview.t3.codes" })
        .value,
    ).toBe("[Fix the login flow](p3://thread/thread-1)");
  });
});
