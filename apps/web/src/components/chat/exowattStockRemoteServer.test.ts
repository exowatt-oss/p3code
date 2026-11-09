import { EXOWATT_STOCK_REMOTE_SERVER_CODE } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  describeExowattStockRemoteServerStop,
  resolveExowattStockRemoteServerAction,
} from "./exowattStockRemoteServer";

const sshTarget = { alias: "devbox", hostname: "devbox.example.com", username: "julius", port: 22 };
const sshEnvironment = {
  entry: {
    profile: Option.some({ _tag: "SshConnectionProfile" as const, target: sshTarget }),
  },
} as unknown as Parameters<typeof resolveExowattStockRemoteServerAction>[0]["environment"];
const bearerEnvironment = {
  entry: {
    profile: Option.some({ _tag: "BearerConnectionProfile" as const, httpBaseUrl: "http://x" }),
  },
} as unknown as Parameters<typeof resolveExowattStockRemoteServerAction>[0]["environment"];
const stockError = `Could not prepare the SSH environment: remote runs stock T3 [${EXOWATT_STOCK_REMOTE_SERVER_CODE}]`;

describe("resolveExowattStockRemoteServerAction", () => {
  it("offers the action for a tagged failure on an SSH environment with a P3 bridge", async () => {
    const calls: Array<unknown> = [];
    const action = resolveExowattStockRemoteServerAction({
      environment: sshEnvironment,
      error: stockError,
      bridge: {
        exowattStopRemoteStockServer: async (target) => {
          calls.push(target);
          return { service: "disabled", stoppedPids: [] };
        },
      },
    });
    expect(action?.target).toEqual(sshTarget);
    await action?.stop();
    expect(calls).toEqual([sshTarget]);
  });

  it("stays hidden for other failures, non-SSH environments, and upstream bridges", () => {
    const bridge = {
      exowattStopRemoteStockServer: async () => ({ service: "absent" as const, stoppedPids: [] }),
    };
    expect(
      resolveExowattStockRemoteServerAction({
        environment: sshEnvironment,
        error: "Could not prepare the SSH environment: phi missing",
        bridge,
      }),
    ).toBeNull();
    expect(
      resolveExowattStockRemoteServerAction({ environment: sshEnvironment, error: null, bridge }),
    ).toBeNull();
    expect(
      resolveExowattStockRemoteServerAction({
        environment: bearerEnvironment,
        error: stockError,
        bridge,
      }),
    ).toBeNull();
    expect(
      resolveExowattStockRemoteServerAction({ environment: null, error: stockError, bridge }),
    ).toBeNull();
    expect(
      resolveExowattStockRemoteServerAction({
        environment: sshEnvironment,
        error: stockError,
        bridge: {},
      }),
    ).toBeNull();
    expect(
      resolveExowattStockRemoteServerAction({
        environment: sshEnvironment,
        error: stockError,
        bridge: undefined,
      }),
    ).toBeNull();
  });
});

describe("describeExowattStockRemoteServerStop", () => {
  it("summarises the service and stray processes", () => {
    expect(describeExowattStockRemoteServerStop({ service: "disabled", stoppedPids: [] })).toBe(
      "Disabled the stock T3 background service. Reconnecting with the P3 server.",
    );
    expect(describeExowattStockRemoteServerStop({ service: "absent", stoppedPids: [1, 2] })).toBe(
      "No stock T3 background service was installed; stopped 2 running stock server processes. Reconnecting with the P3 server.",
    );
    expect(describeExowattStockRemoteServerStop({ service: "unsupported", stoppedPids: [7] })).toBe(
      "No systemd or launchd on the host; stopped 1 running stock server process. Reconnecting with the P3 server.",
    );
  });
});
