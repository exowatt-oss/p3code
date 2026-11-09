import { assert, describe, it } from "@effect/vitest";
import { ProjectId, TextGenerationError, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  ExowattThreadIconReactor,
  type IconCandidate,
  iconTitleOf,
  layer as reactorLayer,
} from "./ExowattThreadIconReactor.ts";
import * as ExowattThreadIconStore from "./ExowattThreadIconStore.ts";

const projectId = ProjectId.make("project:icons");

const thread = (overrides: Partial<IconCandidate> = {}): IconCandidate => ({
  id: ThreadId.make("thread-icon-a"),
  projectId,
  title: "Fix the login crash",
  worktreePath: "/repo",
  titleRegeneration: null,
  deletedAt: null,
  ...overrides,
});

type IconCall = TextGeneration.ThreadIconGenerationInput;

function makeLayer(
  generate: (
    input: IconCall,
  ) => Effect.Effect<TextGeneration.ThreadIconGenerationResult, TextGenerationError>,
) {
  const store = ExowattThreadIconStore.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations())),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () =>
        Effect.succeed({
          messages: [{ role: "user", text: "The login page crashes on submit" }],
        } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
    Layer.mock(TextGeneration.TextGeneration)({ generateThreadIcon: generate }),
    ServerSettings.layerTest({}),
  );
  return reactorLayer.pipe(Layer.provideMerge(store), Layer.provide(dependencies));
}

const storedIcons = Effect.gen(function* () {
  const store = yield* ExowattThreadIconStore.ExowattThreadIconStore;
  return (yield* store.list()).map((icon) => ({
    threadId: icon.threadId,
    icon: icon.icon,
    title: icon.title,
    source: icon.source,
  }));
});

describe("iconTitleOf", () => {
  it("waits for a real title", () => {
    assert.strictEqual(iconTitleOf(thread({ title: "New thread" })), null);
    assert.strictEqual(iconTitleOf(thread({ title: "   " })), null);
    assert.strictEqual(
      iconTitleOf(thread({ titleRegeneration: { requestId: "r", startedAt: "now" } })),
      null,
    );
    assert.strictEqual(iconTitleOf(thread({ deletedAt: "2026-10-04T00:00:00.000Z" })), null);
    assert.strictEqual(iconTitleOf(thread({ title: " Ship it " })), "Ship it");
  });
});

describe("ExowattThreadIconReactor", () => {
  it.effect("picks once per title and passes the opening request as context", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<IconCall>>([]);
      yield* Effect.gen(function* () {
        const reactor = yield* ExowattThreadIconReactor;
        yield* reactor.consider(thread({ title: "New thread" }));
        yield* reactor.consider(thread());
        yield* reactor.drain;
        yield* reactor.consider(thread());
        yield* reactor.drain;

        const recorded = yield* Ref.get(calls);
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0]?.title, "Fix the login crash");
        assert.strictEqual(recorded[0]?.context, "The login page crashes on submit");
        assert.strictEqual(recorded[0]?.cwd, "/repo");
        assert.deepStrictEqual(yield* storedIcons, [
          {
            threadId: ThreadId.make("thread-icon-a"),
            icon: "bug",
            title: "Fix the login crash",
            source: "generated",
          },
        ]);

        // A rename picks again.
        yield* reactor.consider(thread({ title: "Design the onboarding screens" }));
        yield* reactor.drain;
        assert.strictEqual((yield* Ref.get(calls)).length, 2);
        assert.strictEqual((yield* storedIcons)[0]?.title, "Design the onboarding screens");

        // Deleting the thread drops its icon.
        yield* reactor.consider(thread({ deletedAt: "2026-10-04T00:00:00.000Z" }));
        assert.deepStrictEqual(yield* storedIcons, []);
      }).pipe(
        Effect.provide(
          makeLayer((input) =>
            Ref.update(calls, (existing) => [...existing, input]).pipe(
              Effect.as({ icon: "bug" as const }),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("stores the keyword icon when generation fails", () =>
    Effect.gen(function* () {
      const reactor = yield* ExowattThreadIconReactor;
      yield* reactor.consider(thread({ title: "Deploy the release" }));
      yield* reactor.drain;
      assert.deepStrictEqual(yield* storedIcons, [
        {
          threadId: ThreadId.make("thread-icon-a"),
          icon: "rocket",
          title: "Deploy the release",
          source: "fallback",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateThreadIcon", detail: "offline" }),
          ),
        ),
      ),
    ),
  );
});
