// @effect-diagnostics nodeBuiltinImport:off - the probe suite runs the generated remote probe through the local node binary.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { afterAll } from "vite-plus/test";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  EXOWATT_P3_SERVER_COMPAT,
  EXOWATT_STOCK_REMOTE_SERVER_CODE,
  isExowattStockRemoteServerError,
} from "@t3tools/contracts";

import { SshLaunchError } from "./errors.ts";
import {
  buildExowattRemoteInstallScript,
  buildExowattRemoteProbeScript,
  buildExowattRemoteUploadScript,
  compareExowattServerVersions,
  decideExowattRemotePreparation,
  EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL,
  EXOWATT_REMOTE_SERVER_ROOT,
  EXOWATT_REMOTE_STOP_STOCK_SERVER_SCRIPT,
  type ExowattPrepareRemoteRunnerOptions,
  type ExowattRemoteProbeResult,
  type ExowattRemoteServerPackageSource,
  isExowattServerCommand,
  makeExowattPrepareRemoteRunner,
  stopExowattRemoteStockServer,
} from "./exowattRemoteServer.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";
const TEST_SHA256 = "a".repeat(64);
const TEST_VERSION = "0.0.37";

const target = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;

const baseProbe: ExowattRemoteProbeResult = {
  node: true,
  nodeVersion: "22.16.0",
  home: "/home/julius",
  installed: false,
  entryPath: `/home/julius/${EXOWATT_REMOTE_SERVER_ROOT}/versions/${TEST_VERSION}/node_modules/t3/dist/bin.mjs`,
  phiPath: "/home/julius/.npm-global/bin/phi",
  phiVersion: "0.83.0",
  externalServer: null,
};

const COMPAT = EXOWATT_P3_SERVER_COMPAT;
const installedEntry = (version: string) =>
  `/home/julius/${EXOWATT_REMOTE_SERVER_ROOT}/versions/${version}/node_modules/t3/dist/bin.mjs`;
const installedServer = (version: string, compat: string | null = COMPAT, complete = true) => ({
  version,
  compat,
  entryPath: installedEntry(version),
  complete,
});
const releaseSource = { version: TEST_VERSION, compat: COMPAT } as const;
const decide = (
  probe: ExowattRemoteProbeResult,
  overrides: Partial<Parameters<typeof decideExowattRemotePreparation>[0]> = {},
) =>
  decideExowattRemotePreparation({
    target,
    probe,
    source: releaseSource,
    compat: COMPAT,
    isDevelopment: false,
    ...overrides,
  });

describe("exowatt remote server decision", () => {
  it("fails when the remote has no node instead of handing upstream's archive runner back", () => {
    const decision = decide({ node: false });
    assert.strictEqual(decision.kind, "fail");
    assert.include(decision.kind === "fail" ? decision.message : "", "missing node on PATH");
  });

  it("installs the bundled build when nothing compatible is installed", () => {
    assert.deepStrictEqual(decide(baseProbe), { kind: "install", version: TEST_VERSION });
  });

  it("fails clearly when phi is missing from the remote login PATH", () => {
    const decision = decide({ ...baseProbe, phiPath: "" });
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.include(decision.message, "julius@devbox");
    assert.include(decision.message, "'phi'");
    assert.include(decision.message, "pi-coding-agent");
  });

  it("refuses to reuse a stock t3 server that already owns ~/.t3 (npx-launched too)", () => {
    const decision = decide({
      ...baseProbe,
      externalServer: {
        pid: 4242,
        port: 3773,
        command:
          "node /home/julius/.npm/_npx/dec0da79062bfff0/node_modules/.bin/t3 serve --host 127.0.0.1 --port 3773 --base-dir /home/julius/.t3",
      },
    });
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.include(decision.message, "stock T3 Code server");
    assert.include(decision.message, "pid 4242, port 3773");
    assert.include(decision.message, "systemctl --user disable --now t3code.service");
    // The renderer keys its one-click "stop the stock server" action off this token.
    assert.isTrue(isExowattStockRemoteServerError(decision.message));
    assert.include(decision.message, `[${EXOWATT_STOCK_REMOTE_SERVER_CODE}]`);
  });

  it("lets upstream restart a stock server that a desktop launched itself", () => {
    const decision = decide({
      ...baseProbe,
      externalServer: {
        pid: 4242,
        command: "node /home/julius/.npm/_npx/abc/node_modules/t3/dist/bin.mjs serve",
        managed: true,
      },
    });
    assert.equal(decision.kind, "install");
  });

  it("accepts a running P3 server as the external server", () => {
    const decision = decide({
      ...baseProbe,
      installedServers: [installedServer(TEST_VERSION)],
      externalServer: {
        pid: 77,
        port: 3773,
        command: `node ${installedEntry(TEST_VERSION)} serve`,
      },
    });
    assert.equal(decision.kind, "ready");
    assert.isTrue(isExowattServerCommand(`node ${installedEntry(TEST_VERSION)} serve`));
    assert.isTrue(isExowattServerCommand("t3 0.0.37-exowatt.12 serve"));
    assert.isTrue(
      isExowattServerCommand(
        "/Applications/P3 Code.app/Contents/MacOS/P3 Code /Applications/P3 Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3",
      ),
    );
    assert.isFalse(isExowattServerCommand("node /usr/lib/node_modules/t3/dist/bin.mjs serve"));
  });
});

describe("exowatt remote server compat matrix", () => {
  it("same version: runs the exact install, no upgrade", () => {
    const decision = decide({ ...baseProbe, installedServers: [installedServer(TEST_VERSION)] });
    assert.deepStrictEqual(decision, {
      kind: "ready",
      entryPath: installedEntry(TEST_VERSION),
      version: TEST_VERSION,
      backgroundUpgrade: null,
    });
  });

  it("older compatible remote: connects with it and stages the newer bundled build", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.37-exowatt.14")] },
      { source: { version: "0.0.37-exowatt.15", compat: COMPAT } },
    );
    assert.deepStrictEqual(decision, {
      kind: "ready",
      entryPath: installedEntry("0.0.37-exowatt.14"),
      version: "0.0.37-exowatt.14",
      backgroundUpgrade: "0.0.37-exowatt.15",
    });
  });

  it("newer compatible remote: keeps working on the newer server, nothing installed", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.37-exowatt.16")] },
      { source: { version: "0.0.37-exowatt.15", compat: COMPAT } },
    );
    assert.deepStrictEqual(decision, {
      kind: "ready",
      entryPath: installedEntry("0.0.37-exowatt.16"),
      version: "0.0.37-exowatt.16",
      backgroundUpgrade: null,
    });
  });

  it("picks the newest compatible release and ignores incomplete or pushed dev installs", () => {
    const decision = decide(
      {
        ...baseProbe,
        installedServers: [
          installedServer("0.0.37-exowatt.9"),
          installedServer("0.0.37-exowatt.15"),
          installedServer("0.0.37-exowatt.20", COMPAT, false),
          installedServer("0.0.0-dev.abc1234"),
        ],
      },
      { source: null, isDevelopment: true },
    );
    assert.equal(decision.kind, "ready");
    if (decision.kind !== "ready") return;
    assert.equal(decision.version, "0.0.37-exowatt.15");
    assert.equal(decision.backgroundUpgrade, null);
  });

  it("installs the bundled build beside a legacy first-revision P3 server", () => {
    const decision = decide({
      ...baseProbe,
      installedServers: [installedServer("0.0.37-exowatt.14", "p3.1")],
    });
    assert.deepStrictEqual(decision, { kind: "install", version: TEST_VERSION });
  });

  it("dev desktop without a packed tarball uses the installed compatible release", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.37-exowatt.15")] },
      { source: null, isDevelopment: true },
    );
    assert.deepStrictEqual(decision, {
      kind: "ready",
      entryPath: installedEntry("0.0.37-exowatt.15"),
      version: "0.0.37-exowatt.15",
      backgroundUpgrade: null,
    });
  });

  it("dev desktop with a pushed dev server prefers that exact build", () => {
    const decision = decide(
      {
        ...baseProbe,
        installedServers: [
          installedServer("0.0.37-exowatt.15"),
          installedServer("0.0.0-dev.abc1234"),
        ],
      },
      { source: { version: "0.0.0-dev.abc1234", compat: COMPAT }, isDevelopment: true },
    );
    assert.equal(decision.kind, "ready");
    if (decision.kind !== "ready") return;
    assert.equal(decision.version, "0.0.0-dev.abc1234");
    assert.equal(decision.backgroundUpgrade, null);
  });

  it("dev desktop never falls back to stock t3: fails with guidance when nothing is compatible", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.36", null)] },
      { source: null, isDevelopment: true },
    );
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.include(decision.message, "never runs the stock T3 server");
    assert.include(decision.message, "0.0.36 (no compat token)");
    assert.include(decision.message, "Push dev server");
  });

  it("incompatible remote: installs the bundled build side by side", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.38-exowatt.1", "p3.2")] },
      { source: { version: "0.0.37-exowatt.15", compat: "p3.1" }, compat: "p3.1" },
    );
    assert.deepStrictEqual(decision, { kind: "install", version: "0.0.37-exowatt.15" });
  });

  it("incompatible remote and no tarball: fails instead of running stock or a mismatched server", () => {
    const decision = decide(
      { ...baseProbe, installedServers: [installedServer("0.0.38-exowatt.1", "p3.1")] },
      { source: null, isDevelopment: false },
    );
    assert.equal(decision.kind, "fail");
    if (decision.kind !== "fail") return;
    assert.include(decision.message, "Update P3 Code");
  });

  it("orders versions numerically with dev builds lowest", () => {
    const sorted = [
      "0.0.37-exowatt.15",
      "0.0.0-dev.abc",
      "0.0.37-exowatt.9",
      "0.0.38",
      "0.0.37",
    ].toSorted(compareExowattServerVersions);
    assert.deepStrictEqual(sorted, [
      "0.0.0-dev.abc",
      "0.0.37-exowatt.9",
      "0.0.37-exowatt.15",
      "0.0.37",
      "0.0.38",
    ]);
  });
});

describe("exowatt remote server scripts", () => {
  it("quotes the version and checksum into the probe and reuses the node env helper", () => {
    const script = buildExowattRemoteProbeScript({
      version: TEST_VERSION,
      sha256: TEST_SHA256,
      runner: { nodeEngineRange: TEST_NODE_ENGINE_RANGE },
    });
    assert.include(script, "ensure_remote_node_path() {");
    assert.include(script, `node - '${TEST_VERSION}' '${TEST_SHA256}' <<'NODE'`);
    assert.include(script, `printf '{"node":false}\\n'`);
    assert.notInclude(script, "@@");
  });

  it("verifies the checksum before installing and installs into a per-version dir", () => {
    const script = buildExowattRemoteInstallScript({
      version: TEST_VERSION,
      sha256: TEST_SHA256,
      archiveName: `t3-${TEST_VERSION}.tgz`,
      runner: { nodeEngineRange: TEST_NODE_ENGINE_RANGE },
    });
    assert.include(script, `P3_ROOT="$HOME/${EXOWATT_REMOTE_SERVER_ROOT}"`);
    assert.include(script, `TGZ="$P3_ROOT/incoming/t3-${TEST_VERSION}.tgz"`);
    assert.include(script, `if [ "$ACTUAL_SHA256" != '${TEST_SHA256}' ]; then`);
    assert.include(script, 'npm install --prefix "$STAGING" --no-fund --no-audit "$TGZ"');
    assert.include(script, `>"$STAGING/${EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL}"`);
    assert.isBelow(script.indexOf("ACTUAL_SHA256="), script.indexOf("npm install"));
    assert.notInclude(script, "@@");
  });

  it("writes the upload atomically", () => {
    const script = buildExowattRemoteUploadScript({ archiveName: "t3-0.0.37.tgz" });
    assert.include(script, `INCOMING="$HOME/${EXOWATT_REMOTE_SERVER_ROOT}/incoming"`);
    assert.include(script, 'cat >"$INCOMING/t3-0.0.37.tgz.part"');
    assert.include(script, 'mv -f "$INCOMING/t3-0.0.37.tgz.part" "$INCOMING/t3-0.0.37.tgz"');
  });
});

describe("exowatt remote probe (executed)", () => {
  const tempHomes: string[] = [];
  afterAll(() => {
    for (const home of tempHomes) NodeFS.rmSync(home, { recursive: true, force: true });
  });

  function makeHome(): string {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p3-remote-probe-"));
    tempHomes.push(home);
    return home;
  }

  function runProbe(home: string, extraPath: string) {
    const script = buildExowattRemoteProbeScript({
      version: TEST_VERSION,
      sha256: TEST_SHA256,
      runner: { nodeEngineRange: TEST_NODE_ENGINE_RANGE },
    });
    const nodeDir = NodePath.dirname(process.execPath);
    const result = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { HOME: home, PATH: [extraPath, nodeDir, "/usr/bin", "/bin"].join(":") },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as ExowattRemoteProbeResult;
  }

  it("reports a bare host as needing install with no phi", () => {
    const home = makeHome();
    const probe = runProbe(home, NodePath.join(home, "empty-bin"));
    assert.equal(probe.node, true);
    assert.equal(probe.installed, false);
    assert.equal(probe.phiPath, "");
    assert.equal(probe.externalServer, null);
    assert.equal(
      probe.entryPath,
      NodePath.join(
        home,
        EXOWATT_REMOTE_SERVER_ROOT,
        "versions",
        TEST_VERSION,
        "node_modules/t3/dist/bin.mjs",
      ),
    );
  });

  it("detects phi, a matching install sentinel, and a managed server", () => {
    const home = makeHome();
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bin, "phi"), "#!/bin/sh\necho 0.83.0\n", { mode: 0o755 });

    const versionDir = NodePath.join(home, EXOWATT_REMOTE_SERVER_ROOT, "versions", TEST_VERSION);
    NodeFS.mkdirSync(NodePath.join(versionDir, "node_modules/t3/dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(versionDir, "node_modules/t3/dist/bin.mjs"), "");
    NodeFS.writeFileSync(
      NodePath.join(versionDir, EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL),
      `${TEST_SHA256}\n`,
    );

    // Point the shared runtime file at this test process and mark it managed
    // by an ssh-launch state dir, exactly as upstream's launch script does.
    NodeFS.mkdirSync(NodePath.join(home, ".t3/userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".t3/userdata/server-runtime.json"),
      JSON.stringify({ pid: process.pid, port: 3773 }),
    );
    const stateDir = NodePath.join(home, ".t3/ssh-launch/abc123");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stateDir, "pid"), `${String(process.pid)}\n`);
    NodeFS.writeFileSync(NodePath.join(stateDir, "managed"), "managed\n");

    const probe = runProbe(home, bin);
    assert.equal(probe.installed, true);
    assert.equal(probe.phiPath, NodePath.join(bin, "phi"));
    assert.equal(probe.phiVersion, "0.83.0");
    assert.equal(probe.externalServer?.pid, process.pid);
    assert.equal(probe.externalServer?.port, 3773);
    assert.equal(probe.externalServer?.managed, true);
    assert.isString(probe.externalServer?.command);
  });

  it("treats a stale sentinel from another build as not installed", () => {
    const home = makeHome();
    const versionDir = NodePath.join(home, EXOWATT_REMOTE_SERVER_ROOT, "versions", TEST_VERSION);
    NodeFS.mkdirSync(NodePath.join(versionDir, "node_modules/t3/dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(versionDir, "node_modules/t3/dist/bin.mjs"), "");
    NodeFS.writeFileSync(
      NodePath.join(versionDir, EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL),
      `${"b".repeat(64)}\n`,
    );
    const probe = runProbe(home, NodePath.join(home, "empty-bin"));
    assert.equal(probe.installed, false);
  });

  it("lists every installed P3 build with its compat token, backfilling legacy installs", () => {
    const home = makeHome();
    const install = (
      version: string,
      manifest: Record<string, unknown> | null,
      complete: boolean,
    ) => {
      const dir = NodePath.join(home, EXOWATT_REMOTE_SERVER_ROOT, "versions", version);
      NodeFS.mkdirSync(NodePath.join(dir, "node_modules/t3/dist"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "node_modules/t3/dist/bin.mjs"), "");
      if (manifest !== null) {
        NodeFS.writeFileSync(
          NodePath.join(dir, "node_modules/t3/package.json"),
          JSON.stringify({ name: "t3", version, ...manifest }),
        );
      }
      if (complete) {
        NodeFS.writeFileSync(NodePath.join(dir, EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL), "x\n");
      }
    };
    install("0.0.36", {}, true); // stock-shaped manual install: no marker
    install("0.0.37-exowatt.14", { exowattP3Server: true }, true); // pre-compat P3 release
    install("0.0.37-exowatt.15", { exowattP3Server: true, exowattP3Compat: "p3.1" }, true);
    install("0.0.0-dev.abc1234", { exowattP3Server: true, exowattP3Compat: COMPAT }, false);
    NodeFS.mkdirSync(NodePath.join(home, EXOWATT_REMOTE_SERVER_ROOT, "versions", ".staging-x.1"));

    const probe = runProbe(home, NodePath.join(home, "empty-bin"));
    const byVersion = Object.fromEntries(
      (probe.installedServers ?? []).map((server) => [server.version, server]),
    );
    assert.deepStrictEqual(Object.keys(byVersion).toSorted(), [
      "0.0.0-dev.abc1234",
      "0.0.36",
      "0.0.37-exowatt.14",
      "0.0.37-exowatt.15",
    ]);
    assert.equal(byVersion["0.0.36"]?.compat, null);
    assert.equal(byVersion["0.0.37-exowatt.14"]?.compat, "p3.1");
    assert.equal(byVersion["0.0.37-exowatt.15"]?.compat, "p3.1");
    assert.equal(byVersion["0.0.0-dev.abc1234"]?.compat, COMPAT);
    assert.equal(byVersion["0.0.0-dev.abc1234"]?.complete, false);
    assert.equal(
      byVersion["0.0.37-exowatt.15"]?.entryPath,
      NodePath.join(
        home,
        EXOWATT_REMOTE_SERVER_ROOT,
        "versions/0.0.37-exowatt.15/node_modules/t3/dist/bin.mjs",
      ),
    );
  });
});

describe("exowatt prepareRemoteRunner", () => {
  const source: ExowattRemoteServerPackageSource = {
    version: TEST_VERSION,
    compat: COMPAT,
    sha256: TEST_SHA256,
    archiveName: `t3-${TEST_VERSION}.tgz`,
    read: Effect.succeed(new Uint8Array([1, 2, 3, 4])),
  };
  const runner = { packageSpec: "t3@0.0.37", nodeEngineRange: TEST_NODE_ENGINE_RANGE } as const;
  const entryPath = baseProbe.entryPath ?? "";
  const prepare = (
    overrides: Partial<Omit<ExowattPrepareRemoteRunnerOptions, "resolveSource">> & {
      readonly source?: ExowattRemoteServerPackageSource | null;
    } = {},
  ) => {
    const { source: sourceOverride, ...rest } = overrides;
    return makeExowattPrepareRemoteRunner({
      resolveSource: Effect.succeed(sourceOverride === undefined ? source : sourceOverride),
      compat: COMPAT,
      isDevelopment: false,
      ...rest,
    });
  };

  const makeProcess = (stdout: string) => {
    const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: stdoutStream,
      stderr: Stream.empty,
      all: stdoutStream,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  };

  function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
    return command._tag === "StandardCommand" ? command.args.map(String) : [];
  }

  // runSshCommand hands stdin to the spawner as a stream on the command itself.
  const collectStdin = (command: ChildProcess.Command | undefined) =>
    Effect.gen(function* () {
      if (command === undefined || command._tag !== "StandardCommand") return new Uint8Array();
      const stdin: unknown = command.options.stdin;
      if (typeof stdin !== "object" || stdin === null || !("stream" in stdin)) {
        return new Uint8Array();
      }
      const chunks = yield* Stream.runCollect(stdin.stream as Stream.Stream<Uint8Array>);
      return new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
    });

  function makeSpawner(responses: ReadonlyArray<string>) {
    const spawned: Array<ReadonlyArray<string>> = [];
    const commands: Array<ChildProcess.Command> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawned.push(commandArgs(command));
        commands.push(command);
        return makeProcess(responses[spawned.length - 1] ?? "");
      }),
    );
    return {
      spawned,
      commands,
      layer: Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    };
  }

  it.effect("returns the installed entry as nodeScriptPath without uploading", () => {
    const spawner = makeSpawner([
      `${JSON.stringify({ ...baseProbe, installedServers: [installedServer(TEST_VERSION)] })}\n`,
    ]);
    return Effect.gen(function* () {
      const prepared = yield* prepare()(target, runner, {});
      assert.deepStrictEqual(prepared, { ...runner, nodeScriptPath: entryPath });
      assert.equal(spawner.spawned.length, 1);
      assert.deepEqual(spawner.spawned[0]?.slice(-3), ["sh", "-l", "-s"]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("uploads the tarball bytes then installs when the build is missing", () => {
    const spawner = makeSpawner([
      `${JSON.stringify(baseProbe)}\n`,
      "",
      `${JSON.stringify({ installed: true, entryPath })}\n`,
    ]);
    return Effect.gen(function* () {
      const prepared = yield* prepare()(target, runner, {});
      assert.deepStrictEqual(prepared, { ...runner, nodeScriptPath: entryPath });
      assert.equal(spawner.spawned.length, 3);
      const uploadArgs = spawner.spawned[1] ?? [];
      assert.equal(uploadArgs.at(-2), "-c");
      assert.include(uploadArgs.at(-1) ?? "", `t3-${TEST_VERSION}.tgz.part`);
      assert.deepStrictEqual(Array.from(yield* collectStdin(spawner.commands[1])), [1, 2, 3, 4]);
      const installScript = new TextDecoder().decode(yield* collectStdin(spawner.commands[2]));
      assert.include(installScript, `'${TEST_SHA256}'`);
      assert.include(installScript, "npm install --prefix");
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect(
    "fails rather than hand back upstream's archive runner when the remote has no node",
    () => {
      const spawner = makeSpawner(['{"node":false}\n']);
      return Effect.gen(function* () {
        const error = yield* Effect.flip(prepare()(target, runner, {}));
        assert.instanceOf(error, SshLaunchError);
        assert.include(error.message, "missing node on PATH");
        assert.equal(spawner.spawned.length, 1);
      }).pipe(Effect.provide(spawner.layer));
    },
  );

  it.effect("fails before uploading when phi is missing", () => {
    const spawner = makeSpawner([`${JSON.stringify({ ...baseProbe, phiPath: "" })}\n`]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(prepare()(target, runner, {}));
      assert.instanceOf(error, SshLaunchError);
      assert.include(error.message, "no 'phi' on PATH");
      assert.equal(spawner.spawned.length, 1);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("rejects malformed package metadata before uploading", () => {
    const spawner = makeSpawner([`${JSON.stringify(baseProbe)}\n`]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        prepare({ source: { ...source, sha256: "nope" } })(target, runner, {}),
      );
      assert.instanceOf(error, SshLaunchError);
      assert.include(error.message, "invalid server package metadata");
      assert.equal(spawner.spawned.length, 1);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("dev build without a tarball never uses upstream's npx runner", () => {
    const spawner = makeSpawner([`${JSON.stringify(baseProbe)}\n`]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        prepare({ source: null, isDevelopment: true })(target, runner, {}),
      );
      assert.instanceOf(error, SshLaunchError);
      assert.include(error.message, "never runs the stock T3 server");
      assert.equal(spawner.spawned.length, 1);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("dev build uses the installed compatible release without uploading", () => {
    const spawner = makeSpawner([
      `${JSON.stringify({ ...baseProbe, installedServers: [installedServer("0.0.37-exowatt.15")] })}\n`,
    ]);
    return Effect.gen(function* () {
      const prepared = yield* prepare({ source: null, isDevelopment: true })(target, runner, {});
      assert.deepStrictEqual(prepared, {
        ...runner,
        nodeScriptPath: installedEntry("0.0.37-exowatt.15"),
      });
      assert.equal(spawner.spawned.length, 1);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.live("connects on the older install and stages the newer build in the background", () => {
    const newer = {
      ...source,
      version: "0.0.37-exowatt.15",
      archiveName: "t3-0.0.37-exowatt.15.tgz",
    };
    const spawner = makeSpawner([
      `${JSON.stringify({ ...baseProbe, installedServers: [installedServer("0.0.37-exowatt.14")] })}\n`,
      "",
      `${JSON.stringify({ installed: true, entryPath: installedEntry("0.0.37-exowatt.15") })}\n`,
    ]);
    const events: Array<unknown> = [];
    return Effect.gen(function* () {
      const upgraded = yield* Deferred.make<void>();
      const prepared = yield* prepare({
        source: newer,
        onEvent: (event) =>
          Effect.sync(() => void events.push(event)).pipe(
            Effect.andThen(Deferred.succeed(upgraded, undefined)),
          ),
      })(target, runner, {});
      assert.deepStrictEqual(prepared, {
        ...runner,
        nodeScriptPath: installedEntry("0.0.37-exowatt.14"),
      });
      // The detached upgrade fiber reports through onEvent once it finishes.
      yield* Deferred.await(upgraded);
      assert.equal(spawner.spawned.length, 3);
      assert.deepStrictEqual(events, [
        {
          type: "upgraded",
          host: "julius@devbox",
          version: "0.0.37-exowatt.15",
          previousVersion: "0.0.37-exowatt.14",
        },
      ]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("stops the stock server over a plain sh session and decodes the report", () => {
    const spawner = makeSpawner(['{"service":"disabled","stoppedPids":[4242]}\n']);
    return Effect.gen(function* () {
      const result = yield* stopExowattRemoteStockServer(target, {});
      assert.deepStrictEqual(result, { service: "disabled", stoppedPids: [4242] });
      assert.equal(spawner.spawned.length, 1);
      assert.deepEqual(spawner.spawned[0]?.slice(-2), ["sh", "-s"]);
      const script = new TextDecoder().decode(yield* collectStdin(spawner.commands[0]));
      assert.equal(script, EXOWATT_REMOTE_STOP_STOCK_SERVER_SCRIPT);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("fails with the host named when the stop report is unreadable", () => {
    const spawner = makeSpawner(["Failed to connect to bus\n"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(stopExowattRemoteStockServer(target, {}));
      assert.instanceOf(error, SshLaunchError);
      assert.include(error.message, "stopping the stock T3 Code server");
      assert.include(error.message, "julius@");
    }).pipe(Effect.provide(spawner.layer));
  });
});

describe("exowatt stop stock server script (executed)", () => {
  const stopScript = EXOWATT_REMOTE_STOP_STOCK_SERVER_SCRIPT;
  const parseStopReport = (output: string): unknown => JSON.parse(output.trim());

  function makeStopHome(systemctlBody: string) {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p3-stop-"));
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "systemctl"), `#!/bin/sh\n${systemctlBody}\n`, {
      mode: 0o755,
    });
    return { home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } };
  }

  it("disables the systemd unit when present and never touches the stock runtime on disk", () => {
    const calls = NodePath.join(NodeOS.tmpdir(), `p3-stop-calls-${String(process.pid)}`);
    NodeFS.rmSync(calls, { force: true });
    // Fake systemctl: the unit exists; record every invocation.
    const { home, env } = makeStopHome(`printf '%s\\n' "$*" >>${JSON.stringify(calls)}\nexit 0`);
    const runtimeDir = NodePath.join(home, ".t3", "runtime", "versions", "0.0.36");
    NodeFS.mkdirSync(runtimeDir, { recursive: true });
    try {
      const output = NodeChildProcess.execFileSync("sh", ["-s"], {
        input: stopScript,
        env,
        encoding: "utf8",
      });
      assert.deepStrictEqual(JSON.parse(output.trim()), { service: "disabled", stoppedPids: [] });
      assert.include(NodeFS.readFileSync(calls, "utf8"), "--user disable --now t3code.service");
      assert.isTrue(NodeFS.existsSync(runtimeDir));
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.rmSync(calls, { force: true });
    }
  });

  it("reports an absent unit on a host without the service", () => {
    // `systemctl --user cat` fails when the unit is not installed.
    const { home, env } = makeStopHome("exit 1");
    try {
      const output = NodeChildProcess.execFileSync("sh", ["-s"], {
        input: stopScript,
        env,
        encoding: "utf8",
      });
      assert.deepStrictEqual(JSON.parse(output.trim()), { service: "absent", stoppedPids: [] });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it.live("kills a stray npx-launched stock server but never a P3 server", () =>
    Effect.gen(function* () {
      const { home, env } = makeStopHome("exit 1");
      // Stand-ins whose argv looks like upstream's `npx --package t3@nightly t3 serve`
      // and like a P3 server launched from ~/.t3/p3-server.
      const stockBin = NodePath.join(home, ".npm/_npx/dec0da79062bfff0/node_modules/.bin/t3");
      const p3Bin = NodePath.join(
        home,
        ".t3/p3-server/versions/0.0.37-exowatt.15/node_modules/t3/dist/bin.mjs",
      );
      for (const file of [stockBin, p3Bin]) {
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, "#!/bin/sh\necho ready\nsleep 30\n", { mode: 0o755 });
      }
      const serveArgs = ["serve", "--host", "127.0.0.1", "--port", "3774"];
      const spawnStandIn = (bin: string) =>
        NodeChildProcess.spawn("sh", [bin, ...serveArgs], { stdio: ["ignore", "pipe", "ignore"] });
      // Each stand-in prints once its shell runs with the server-like argv.
      const started = (child: NodeChildProcess.ChildProcess) =>
        new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
      const stock = spawnStandIn(stockBin);
      const p3 = spawnStandIn(p3Bin);
      const stockExit = new Promise<void>((resolve) => stock.once("exit", () => resolve()));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stock.kill("SIGKILL");
          p3.kill("SIGKILL");
          NodeFS.rmSync(home, { recursive: true, force: true });
        }),
      );
      yield* Effect.promise(() => Promise.all([started(stock), started(p3)]));
      const output = NodeChildProcess.execFileSync("sh", ["-s"], {
        input: stopScript,
        env,
        encoding: "utf8",
      });
      assert.deepStrictEqual(parseStopReport(output), {
        service: "absent",
        stoppedPids: [stock.pid],
      });
      yield* Effect.promise(() => stockExit);
      assert.equal(p3.exitCode, null);
    }).pipe(Effect.scoped),
  );

  it("surfaces a failed disable instead of reporting success", () => {
    const { home, env } = makeStopHome('case "$*" in *" cat "*) exit 0;; *) exit 1;; esac');
    try {
      assert.throws(() =>
        NodeChildProcess.execFileSync("sh", ["-s"], {
          input: stopScript,
          env,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
