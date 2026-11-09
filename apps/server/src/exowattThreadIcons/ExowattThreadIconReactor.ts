// exowatt: picks a thread's Font Awesome icon once it has a real title (live v2 event tail),
// waiting out title regeneration so a seed title never costs a call; a failed pick stores the
// keyword fallback so it is not retried forever. Start backfills recent icon-less threads.
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  type ExowattThreadIcon,
  fallbackExowattThreadIcon,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ExowattThreadIconStore from "./ExowattThreadIconStore.ts";

/** Recent threads given an icon on start; older ones keep the client fallback. */
const BACKFILL_LIMIT = 60;
/** Picks in flight at once. Each is one short structured-output call. */
const WORKERS = 2;
const PLACEHOLDER_TITLE = "New thread";
const CONTEXT_CHARS = 2_000;

/** The part of a thread (or shell) the reactor reads. */
export interface IconCandidate {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly titleRegeneration?: unknown;
  readonly deletedAt: unknown;
}

/** The title to pick an icon for, or null while there is none worth a call. */
export function iconTitleOf(thread: IconCandidate): string | null {
  if (thread.deletedAt !== null) return null;
  if (thread.titleRegeneration !== undefined && thread.titleRegeneration !== null) return null;
  const title = thread.title.trim();
  return title.length === 0 || title === PLACEHOLDER_TITLE ? null : title;
}

export class ExowattThreadIconReactor extends Context.Service<
  ExowattThreadIconReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Queue a pick for this thread when its title has no icon yet. */
    readonly consider: (thread: IconCandidate) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/exowattThreadIcons/ExowattThreadIconReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const store = yield* ExowattThreadIconStore.ExowattThreadIconStore;

  // Title each thread's stored icon was picked for, and titles queued now.
  const pickedFor = new Map<ThreadId, string>();
  const queued = new Map<ThreadId, IconCandidate & { readonly iconTitle: string }>();
  let loaded = false;

  const loadPicked = Effect.gen(function* () {
    if (loaded) return;
    const icons = yield* store.list().pipe(Effect.orElseSucceed(() => []));
    for (const icon of icons) pickedFor.set(icon.threadId, icon.title);
    loaded = true;
  });

  const openingRequest = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
      Effect.map((records) => {
        const first = records.messages.find((message) => message.text.trim().length > 0);
        return first?.text.slice(0, CONTEXT_CHARS);
      }),
      Effect.orElseSucceed(() => undefined),
    );

  const pick = Effect.fn("ExowattThreadIconReactor.pick")(function* (
    thread: IconCandidate,
    title: string,
  ) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const cwd =
      thread.worktreePath ??
      (Option.isSome(project) ? project.value.workspaceRoot : undefined) ??
      NodeOS.homedir();
    const context = yield* openingRequest(thread.id);
    const generate = textGeneration.generateThreadIcon;
    if (generate === undefined) return null;
    const result = yield* generate({
      cwd,
      title,
      ...(context === undefined ? {} : { context }),
      modelSelection: settings.textGenerationModelSelection,
    });
    return result.icon;
  });

  const process = Effect.fn("ExowattThreadIconReactor.process")(function* (threadId: ThreadId) {
    const thread = queued.get(threadId);
    if (thread === undefined) return;
    queued.delete(threadId);
    const title = thread.iconTitle;
    if (pickedFor.get(threadId) === title) return;
    const generated = yield* pick(thread, title).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread icon generation failed; using the keyword icon", {
              threadId,
              cause,
            }).pipe(Effect.as(null)),
      ),
    );
    // A newer title arrived while this one was being picked; let it win.
    if (queued.has(threadId)) return;
    const icon: ExowattThreadIcon = {
      threadId,
      icon: generated ?? fallbackExowattThreadIcon(title),
      title,
      source: generated === null ? "fallback" : "generated",
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* store.upsert(icon).pipe(
      Effect.tap(() => Effect.sync(() => pickedFor.set(threadId, title))),
      Effect.catch((error) => Effect.logWarning("Failed to store thread icon", { error })),
    );
  });

  const workers = yield* Effect.forEach(Array.from({ length: WORKERS }), () =>
    makeDrainableWorker(process),
  );
  let nextWorker = 0;

  const consider: ExowattThreadIconReactor["Service"]["consider"] = Effect.fn(
    "ExowattThreadIconReactor.consider",
  )(function* (thread) {
    yield* loadPicked;
    if (thread.deletedAt !== null) {
      queued.delete(thread.id);
      if (pickedFor.delete(thread.id)) {
        yield* store.remove(thread.id).pipe(Effect.ignore);
      }
      return;
    }
    const iconTitle = iconTitleOf(thread);
    if (iconTitle === null || pickedFor.get(thread.id) === iconTitle) return;
    const alreadyQueued = queued.has(thread.id);
    queued.set(thread.id, { ...thread, iconTitle });
    if (alreadyQueued) return;
    const worker = workers[nextWorker % workers.length]!;
    nextWorker += 1;
    yield* worker.enqueue(thread.id);
  });

  const backfill = Effect.gen(function* () {
    yield* loadPicked;
    const snapshot = yield* projections.getShellSnapshot({ location: "active" });
    const missing = snapshot.threads
      .filter((thread) => {
        const title = iconTitleOf(thread);
        return title !== null && !pickedFor.has(thread.id);
      })
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )
      .slice(0, BACKFILL_LIMIT);
    yield* Effect.forEach(missing, consider, { discard: true });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Thread icon backfill failed", { cause }),
    ),
  );

  const start: ExowattThreadIconReactor["Service"]["start"] = Effect.fn(
    "ExowattThreadIconReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          // A title lands on creation (subagents), through metadata updates
          // (generated titles, renames), and an icon goes with its thread.
          case "thread.created":
          case "thread.metadata-updated":
          case "thread.deleted":
            return consider(event.payload);
          default:
            return Effect.void;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread icon reactor stopped", { cause }),
        ),
      ),
    );
    yield* forkParked(backfill);
  });

  const drain = Effect.forEach(workers, (worker) => worker.drain, { discard: true });

  return ExowattThreadIconReactor.of({ start, consider, drain });
});

export const layer = Layer.effect(ExowattThreadIconReactor, make);
