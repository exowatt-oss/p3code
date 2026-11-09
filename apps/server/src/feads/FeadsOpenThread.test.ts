import { describe, expect, it } from "@effect/vitest";
import {
  type ExowattFeadsIssue,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as FeadsBridge from "./FeadsBridge.ts";
import { feadsOpenedThreadComment, openBeadThread } from "./FeadsOpenThread.ts";

const PROJECT_ID = ProjectId.make("project-1");
const NOW = "2026-09-15T12:00:00.000Z";
const PROJECT_MODEL = { instanceId: ProviderInstanceId.make("phi"), model: "sol" };

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "p3code",
  workspaceRoot: "/workspace/p3code",
  defaultModelSelection: PROJECT_MODEL,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const ISSUE: ExowattFeadsIssue = {
  id: "demo-oru",
  title: "Open a bead as a P3 thread",
  status: "open",
  issueType: "task",
  priority: 2,
  assignee: "bob-phi",
  labels: ["feads", "p3code"],
  boardId: "demo",
  boardName: "Demo",
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  blockedBy: [],
};

interface HarnessOptions {
  readonly project?: OrchestrationProjectShell | null;
  readonly comment?: FeadsBridge.FeadsCommentOutcome;
}

const makeHarness = Effect.fn("makeFeadsOpenThreadHarness")(function* (
  options: HarnessOptions = {},
) {
  const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
  const comments = yield* Ref.make<ReadonlyArray<{ issueId: string; text: string }>>([]);
  const project = options.project === undefined ? PROJECT : options.project;

  const layer = Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Ref.update(launches, (recorded) => [...recorded, input]).pipe(
          // openBeadThread reads nothing back from the launch result.
          Effect.as({} as never),
        ),
    }),
    Layer.mock(ProjectService)({
      getShell: (projectId) =>
        Effect.succeed(
          project !== null && projectId === project.id ? Option.some(project) : Option.none(),
        ),
    }),
    Layer.mock(ServerSettingsService)({
      // The project's own model wins, so the server default is only a fallback.
      getSettings: Effect.succeed({ defaultModelSelection: null } as never),
    }),
    Layer.mock(FeadsBridge.FeadsBridge)({
      readBead: (issueId) =>
        Effect.succeed({
          issueId,
          baseUrl: "http://127.0.0.1:3000",
          issue: ISSUE,
          notification: null,
          detail: {
            description: "Beads filed by outside agents need a way into a coding thread.",
            comments: [{ author: "luna", text: "the REST route does not exist" }],
          },
        }),
      commentOnBead: (input) =>
        Ref.update(comments, (recorded) => [...recorded, input]).pipe(
          Effect.as(options.comment ?? { kind: "posted" }),
        ),
    }),
  );
  return { layer, launches, comments };
});

describe("openBeadThread", () => {
  it.effect("creates the thread and starts its first turn with the brief", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* openBeadThread({ issueId: "demo-oru", projectId: PROJECT_ID }).pipe(
        Effect.provide(harness.layer),
      );
      expect(result.title).toBe("demo-oru Open a bead as a P3 thread");
      expect(result.commentPosted).toBe(true);
      expect(result.commentError).toBeNull();

      const launches = yield* Ref.get(harness.launches);
      expect(launches).toHaveLength(1);
      const [launch] = launches;
      expect(launch).toMatchObject({
        threadId: result.threadId,
        projectId: PROJECT_ID,
        title: result.title,
        modelSelection: PROJECT_MODEL,
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
      });
      // The brief is the first user message, and it is built server-side.
      const text = launch?.initialMessage?.text ?? "";
      expect(text).toContain("# demo-oru: Open a bead as a P3 thread");
      expect(text).toContain("**Bead:** task · priority 2 · open · assigned to bob-phi · Demo");
      expect(text).toContain("- **luna**: the REST route does not exist");
      expect(text).toContain("**Dashboard:** http://127.0.0.1:3000/#/issues?issue=");
      expect(text).toContain("keep its feads state honest");

      expect(yield* Ref.get(harness.comments)).toEqual([
        { issueId: "demo-oru", text: feadsOpenedThreadComment(result.title, result.threadId) },
      ]);
    }),
  );

  it.effect("still opens the thread when feads refuses the comment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ comment: { kind: "failed", error: "not_identified" } });
      const result = yield* openBeadThread({ issueId: "demo-oru", projectId: PROJECT_ID }).pipe(
        Effect.provide(harness.layer),
      );
      expect(result.commentPosted).toBe(false);
      expect(result.commentError).toBe("not_identified");
      expect(yield* Ref.get(harness.launches)).toHaveLength(1);
    }),
  );

  it.effect("refuses an unknown project and a blank bead id without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ project: null });
      const missingProject = yield* openBeadThread({
        issueId: "demo-oru",
        projectId: PROJECT_ID,
      }).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(missingProject.reason).toBe("project_not_found");

      const blank = yield* openBeadThread({ issueId: "  ", projectId: PROJECT_ID }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      );
      expect(blank.reason).toBe("no_issue_id");
      expect(yield* Ref.get(harness.launches)).toEqual([]);
    }),
  );
});
