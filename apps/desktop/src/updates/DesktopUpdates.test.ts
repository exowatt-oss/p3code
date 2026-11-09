import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdateTransport from "./DesktopUpdateTransport.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.equal(harness.listenerCount(), 7);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps P3 force-check enabled while the stock Electron updater is disabled", () => {
    const harness = makeHarness({
      env: { T3CODE_DISABLE_AUTO_UPDATE: "true" },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const initialState = yield* updates.getState;
        assert.isTrue(initialState.enabled);
        assert.notEqual(
          initialState.message,
          "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.",
        );

        const clickedResult = yield* updates.check("web-ui");
        assert.isTrue(clickedResult.checked);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("uses a distinct P3 emergency kill switch and message", () => {
    const harness = makeHarness({
      env: { P3CODE_DISABLE_AUTO_UPDATE: "true" },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.isFalse(state.enabled);
        assert.equal(state.status, "disabled");
        const reason = yield* updates.disabledReason;
        assert.isTrue(Option.isSome(reason));
        if (Option.isSome(reason)) {
          assert.equal(
            reason.value,
            "P3 Code updates are disabled by the P3CODE_DISABLE_AUTO_UPDATE emergency setting.",
          );
        }
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the disabled reason available after configuration and channel changes", () => {
    // exowatt: P3 reads its own kill switch (T3CODE_DISABLE_AUTO_UPDATE only stops the stock updater).
    const harness = makeHarness({ env: { P3CODE_DISABLE_AUTO_UPDATE: "true" } });
    const reason =
      "P3 Code updates are disabled by the P3CODE_DISABLE_AUTO_UPDATE emergency setting.";

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const configured = yield* updates.getState;
        assert.equal(configured.message, reason);

        const changed = yield* updates.setChannel("nightly");
        assert.equal(changed.channel, "nightly");
        assert.equal(changed.enabled, false);
        assert.equal(changed.status, "disabled");
        assert.equal(changed.message, reason);
        assert.equal(harness.sentStates.at(-1)?.message, reason);
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed background stage actionable with its fallback message", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        harness.emit(
          "update-staging-error",
          new Error("P3 Code could not download the update. Fallback: download it by hand"),
        );
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.errorContext, "download");
        assert.include(state.message ?? "", "download it by hand");
        assert.isTrue(state.canRetry);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("checks for newer releases after an update has been downloaded", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.check("poll");
        assert.isTrue(result.checked);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const unchangedState = yield* updates.getState;
        assert.equal(unchangedState.status, "downloaded");
        assert.equal(unchangedState.downloadedVersion, "1.2.4");
        assert.deepEqual(unchangedState.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);

        const nextResult = yield* updates.check("poll");
        assert.isTrue(nextResult.checked);

        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.5");
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            const followUpCheck = yield* updates.check("manual");
            assert.isTrue(followUpCheck.checked);
            assert.equal(harness.checkCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          const installResult = yield* Fiber.join(installFiber);
          assert.isTrue(installResult.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves a queued installer after a background updater error", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isNull(state.errorContext);

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs the redacted cause of a rejected update check", () => {
    const cause = Object.assign(
      new Error("request failed for https://user:secret@example.com/update?token=secret"),
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
    );
    const updaterError = new DesktopUpdateTransport.DesktopUpdateTransportCheckError({
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "DesktopUpdateTransportCheckError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "DesktopUpdateTransportCheckError");
        assert.include(
          String(loggedAnnotation.cause),
          "Error [ERR_UPDATER_LATEST_VERSION_NOT_FOUND]: request failed for [redacted URL]",
        );
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(state.message, "P3 Code could not check for updates.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("surfaces a failed detached install on the next launch", () => {
    const harness = makeHarness({
      previousInstallFailure:
        "The installer could not upgrade P3 Code. The previous app is still installed.",
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.errorContext, "install");
        assert.equal(
          state.message,
          "The installer could not upgrade P3 Code. The previous app is still installed.",
        );
        assert.isTrue(state.canRetry);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      downloadUpdate: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        downloadUpdate: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("records the version an install hands to the installer", () => {
    let recordsAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        recordsAtStop = [...harness.installRecords.values()];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(
          recordsAtStop.map((record) => JSON.parse(record)),
          [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags an install that did not apply and keeps the flag through checks", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
        assert.isDefined(harness.previousInstallRecord());

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.notAppliedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // regression: #19291 an install that did apply was still flagged as not applied
  it.effect("does not flag an install that applied", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined((yield* updates.getState).notAppliedVersion);
        assert.isUndefined(harness.previousInstallRecord());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          assert.equal(harness.updateRestartMarkers.size, 1);

          yield* Fiber.interrupt(installFiber);
          assert.equal(harness.updateRestartMarkers.size, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps windows and restarts backends when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal(harness.installRecords.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the disabled primary stopped when quitAndInstall fails", () => {
    const harness = makeHarness({
      backendDesiredRunning: false,
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.equal(result.state.errorContext, "install");
        assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        assert.isFalse((yield* (yield* pool.primary).snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores only desired-running instances after an installer error event", () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const makeInstance = (id: DesktopBackendPool.BackendInstanceId, initiallyRunning: boolean) => {
      let desiredRunning = initiallyRunning;
      return {
        id,
        label: Effect.succeed(id),
        currentConfig: Effect.succeedNone,
        start: Effect.sync(() => {
          starts.push(id);
          desiredRunning = true;
        }),
        stop: () =>
          Effect.sync(() => {
            stops.push(id);
            desiredRunning = false;
          }),
        snapshot: Effect.sync(() => ({
          desiredRunning,
          ready: false,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        })),
        waitForReady: () => Effect.succeed(true),
      } satisfies DesktopBackendPool.DesktopBackendInstance;
    };
    const primary = makeInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, false);
    const wsl = makeInstance(DesktopBackendPool.BackendInstanceId("wsl:default"), true);
    const harness = makeHarness({ backendInstances: [primary, wsl] });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.sameMembers(stops, [primary.id, wsl.id]);
        assert.isFalse((yield* wsl.snapshot).desiredRunning);
        const { changes } = yield* updates.subscribe;
        const recovered = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("error", new Error("native installer refused"));
        assert.equal(Option.getOrThrow(yield* Fiber.join(recovered)).errorContext, "install");

        assert.deepEqual(starts, [wsl.id]);
        assert.isFalse((yield* primary.snapshot).desiredRunning);
        assert.isTrue((yield* wsl.snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const failedInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        assert.equal(harness.quitAndInstalls(), 1);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        yield* Deferred.succeed(releaseRecovery, undefined);
        const failedResult = yield* Fiber.join(failedInstall);
        assert.equal(failedResult.state.errorContext, "install");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects a prepared install when the downloaded version changed", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("ignores a finished download from a track it no longer follows", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        // A backed-out switch's download keeps reporting progress until it finishes.
        harness.emit("download-progress", { percent: 40 });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4-nightly.20261027.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.downloadedVersion, null);
        assert.notEqual(state.status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("re-checks a saved track that differs from the running build's track", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest");
        const checks = harness.checkCount();

        yield* updates.setChannel("latest");

        assert.equal(harness.checkCount(), checks + 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers nothing below a track switch's checked release", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest", { minimumVersion: "1.2.3" });

        harness.emit("update-available", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
        harness.emit("update-downloaded", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).downloadedVersion);

        harness.emit("update-available", { version: "1.2.3" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).availableVersion, "1.2.3");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a saved Stable track across a restart without offering an older release", () => {
    // A Nightly build whose switch to Stable did not finish before the app quit.
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20261027.1", savedChannel: "latest" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");

        assert.equal((yield* updates.getState).channel, "latest");
        // Semver ranks Stable 1.2.4 above this Nightly, but a Nightly built before the release's
        // version bump can hold migrations 1.2.4 lacks. Crossing needs a guarded switch.
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("waits out a background check instead of refusing a track change", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Effect.void,
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("poll").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* TestClock.adjust(Duration.seconds(2));
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.isTrue(DesktopUpdates.isDesktopUpdateSetChannelError(error));
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);

        const checkResult = yield* updates.check("manual");
        assert.isTrue(checkResult.checked);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

describe("describeUpdateErrorCause", () => {
  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});

describe("DesktopUpdates under a managed policy", () => {
  const message = "Example Corp manages T3 Code updates.";
  const managed = (
    policy: Partial<DesktopUpdatePolicy.UpdatePolicy>,
  ): DesktopUpdatePolicy.UpdatePolicy => ({
    ...DesktopUpdatePolicy.unmanagedUpdatePolicy,
    message,
    ...policy,
  });

  it.effect("never checks when updates are off", () => {
    const harness = makeHarness({ policy: managed({ mode: "off" }) });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("10 minutes");

        const state = yield* updates.getState;
        assert.equal(state.status, "disabled");
        assert.equal(state.message, message);
        assert.isFalse((yield* updates.check("menu")).checked);
        assert.deepEqual(yield* updates.disabledReason, Option.some(message));
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.listenerCount(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // exowatt: P3 installs through its own transport, so an electron-updater mirror cannot apply.
  it.effect("keeps P3's transport when an administrator sets a feed", () => {
    const harness = makeHarness({
      policy: managed({ feedUrl: "https://updates.example.com/t3code" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).status, "idle");
        assert.deepEqual(harness.feedUrls(), []);
        assert.isTrue((yield* updates.check("menu")).checked);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("refuses the nightly channel without nightly", () => {
    const harness = makeHarness({ policy: managed({ allowNightly: false }) });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);
        assert.equal(error._tag, "DesktopUpdateChannelManagedError");
        assert.equal((yield* updates.getState).channel, "latest");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not report the channel as the only block when updates are off anyway", () => {
    const harness = makeHarness({
      appVersion: "1.2.3-nightly.20261028.1",
      env: { P3CODE_DISABLE_AUTO_UPDATE: "true" },
      policy: managed({ allowNightly: false, feedUrl: "https://updates.example.com/t3code" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const state = yield* updates.getState;
        assert.isFalse(state.enabled);
        assert.isUndefined(state.channelBlockedByPolicy);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
