// @effect-diagnostics nodeBuiltinImport:off - boots the packed CLI as a real child process.
// @effect-diagnostics globalFetch:off - plain fetch probes the child from outside any Effect runtime.
// @effect-diagnostics globalTimers:off - a plain timer bounds the kill grace period.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";

/**
 * Exowatt: the shipped artifact is the packed `dist/bin.mjs`, not `src/bin.ts`, and bundling
 * changes how third-party packages load (jsonc-parser's UMD entry crash-looped packed servers).
 * Pack into a scratch directory, boot it the way the desktop app and the remote installer do,
 * and require it to answer HTTP.
 */

const serverRoot = NodePath.resolve(import.meta.dirname, "..");
const vpBin = NodePath.join(serverRoot, "node_modules", ".bin", "vp");
// `serve` prints this once the HTTP listener is bound.
const READY_PATTERN = /server is ready/iu;

function run(command: string, args: ReadonlyArray<string>, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { cwd, env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${error.message}\n${stdout}\n${stderr}`,
            ),
          );
          return;
        }
        resolve(`${stdout}${stderr}`);
      },
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not reserve a port"));
        }
      });
    });
  });
}

async function answersHttp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "manual",
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

// Settles on the server's own readiness line, or rejects if the process exits first.
function waitForReady(child: NodeChildProcess.ChildProcess, output: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      finish();
    };
    const onData = () => {
      if (READY_PATTERN.test(output())) settle(resolve);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        reject(
          new Error(`server exited before listening (code=${code} signal=${signal}):\n${output()}`),
        ),
      );
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

it.skipIf(process.platform === "darwin")("packed server bundle boots under the running Node and serves HTTP", async () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p3-server-bundle-"));
  const outDir = NodePath.join(scratch, "dist");
  const baseDir = NodePath.join(scratch, "state");
  // A real server reconciles every harness config under HOME at startup; keep it in the scratch
  // directory so the test never repoints the developer's own Codex/Claude/Pi MCP entries.
  const home = NodePath.join(scratch, "home");
  NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(baseDir, "userdata", "settings.json"),
    JSON.stringify({ exowattAutoConnectHarnesses: false }),
  );
  // The bundle keeps native packages external (scripts/lib/cli-external-packages.ts)
  // and resolves them from the nearest node_modules, exactly like the packaged app.
  NodeFS.symlinkSync(
    NodePath.join(serverRoot, "node_modules"),
    NodePath.join(scratch, "node_modules"),
    "junction",
  );
  let child: NodeChildProcess.ChildProcess | undefined;
  let output = "";
  try {
    await run(vpBin, ["pack", "--out-dir", outDir], serverRoot);
    const entry = NodePath.join(outDir, "bin.mjs");
    assert.isTrue(NodeFS.existsSync(entry), `pack produced no ${entry}`);

    const port = await freePort();
    child = NodeChildProcess.spawn(
      process.execPath,
      [
        entry,
        "serve",
        "--mode",
        "desktop",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        baseDir,
        "--no-browser",
      ],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: undefined,
          GROK_HOME: undefined,
          XDG_CONFIG_HOME: undefined,
          ELECTRON_RUN_AS_NODE: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await waitForReady(child, () => output);
    // The readiness line can print just before the router takes its first request.
    try {
      await expect.poll(() => answersHttp(port)).toBe(true);
    } catch (cause) {
      throw new Error(`server did not answer on 127.0.0.1:${port}:\n${output}`, { cause });
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- A server that ignores SIGTERM must not leak; the SIGKILL fallback is cleanup, not a test milestone.
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 5_000);
        child?.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
