import { EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  describeExowattRemoteServerEvent,
  resolveExowattPushDevServerAction,
  shouldOfferExowattPushDevServer,
} from "./exowattRemoteServer";

const sshTarget = { alias: "devbox", hostname: "devbox.example.com", username: "julius", port: 22 };
const sshEnvironment = {
  entry: {
    profile: Option.some({ _tag: "SshConnectionProfile" as const, target: sshTarget }),
  },
} as unknown as Parameters<typeof resolveExowattPushDevServerAction>[0]["environment"];
const bridge = {
  exowattPushDevServer: async () => ({ version: "0.0.0-dev.abc1234", entryPath: "/x" }),
};

describe("resolveExowattPushDevServerAction", () => {
  it("is offered only in dev builds with a P3 bridge and an SSH environment", async () => {
    const action = resolveExowattPushDevServerAction({
      environment: sshEnvironment,
      bridge,
      isDevelopment: true,
    });
    expect(action?.host).toBe("julius@devbox");
    expect(action?.target).toEqual(sshTarget);
    expect((await action?.push())?.version).toBe("0.0.0-dev.abc1234");

    expect(
      resolveExowattPushDevServerAction({
        environment: sshEnvironment,
        bridge,
        isDevelopment: false,
      }),
    ).toBeNull();
    expect(
      resolveExowattPushDevServerAction({
        environment: sshEnvironment,
        bridge: {},
        isDevelopment: true,
      }),
    ).toBeNull();
    expect(
      resolveExowattPushDevServerAction({ environment: null, bridge, isDevelopment: true }),
    ).toBeNull();
  });

  it("only surfaces in the banner for the no-compatible-server failure", () => {
    const action = resolveExowattPushDevServerAction({
      environment: sshEnvironment,
      bridge,
      isDevelopment: true,
    });
    expect(
      shouldOfferExowattPushDevServer({
        action,
        error: `Remote host has no P3 Code server compatible ... [${EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE}]`,
      }),
    ).toBe(true);
    expect(shouldOfferExowattPushDevServer({ action, error: "phi missing" })).toBe(false);
    expect(shouldOfferExowattPushDevServer({ action: null, error: "x" })).toBe(false);
  });
});

describe("describeExowattRemoteServerEvent", () => {
  it("summarises background upgrades", () => {
    expect(
      describeExowattRemoteServerEvent({
        type: "upgraded",
        host: "julius@devbox",
        version: "0.0.37-exowatt.15",
        previousVersion: "0.0.37-exowatt.14",
      }),
    ).toEqual({
      type: "success",
      title: "Remote updated to 0.0.37-exowatt.15",
      description:
        "julius@devbox was running 0.0.37-exowatt.14; the new P3 server is installed and takes effect on the next reconnect.",
    });
    expect(
      describeExowattRemoteServerEvent({
        type: "upgrade-failed",
        host: "julius@devbox",
        version: "0.0.37-exowatt.15",
        message: "npm exited with 1.",
      }).type,
    ).toBe("error");
  });
});
