import { EXOWATT_FEADS_DEFAULT_BASE_URL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeFeadsIdentity,
  decodeFeadsStoredConfig,
  encodeFeadsStoredConfig,
  feadsIdentityProbeUrl,
  normalizeFeadsBaseUrl,
  redactFeadsSecrets,
  resolveFeadsConfig,
} from "./FeadsConfig.ts";

describe("normalizeFeadsBaseUrl", () => {
  it("keeps the origin and drops paths and trailing slashes", () => {
    expect(normalizeFeadsBaseUrl("https://feads.example.org/")).toBe(
      "https://feads.example.org",
    );
    expect(normalizeFeadsBaseUrl("  https://feads.example.org/#/agentwatch ")).toBe(
      "https://feads.example.org",
    );
    expect(normalizeFeadsBaseUrl("http://localhost:8787/api/")).toBe("http://localhost:8787");
  });

  it("assumes https when the scheme is missing", () => {
    expect(normalizeFeadsBaseUrl("feads.example.org")).toBe("https://feads.example.org");
  });

  it("refuses non-http schemes and empty input", () => {
    expect(normalizeFeadsBaseUrl("")).toBeNull();
    expect(normalizeFeadsBaseUrl("   ")).toBeNull();
    expect(normalizeFeadsBaseUrl("ftp://feads")).toBeNull();
    expect(normalizeFeadsBaseUrl("not a url at all")).toBeNull();
  });
});

describe("resolveFeadsConfig", () => {
  it("is unconfigured with nothing stored and nothing in the environment", () => {
    expect(resolveFeadsConfig({}, {})).toEqual({
      token: null,
      tokenSource: "none",
      baseUrl: EXOWATT_FEADS_DEFAULT_BASE_URL,
      defaultBoard: null,
    });
  });

  it("uses the stored token, URL and board when present", () => {
    expect(
      resolveFeadsConfig(
        { token: "fdsa_stored", baseUrl: "https://feads.example/", defaultBoard: " demo " },
        {},
      ),
    ).toEqual({
      token: "fdsa_stored",
      tokenSource: "settings",
      baseUrl: "https://feads.example",
      defaultBoard: "demo",
    });
  });

  it("lets P3_FEADS_TOKEN win over a stored token", () => {
    const resolved = resolveFeadsConfig({ token: "fdsa_stored" }, { P3_FEADS_TOKEN: "fdsa_env" });
    expect(resolved.token).toBe("fdsa_env");
    expect(resolved.tokenSource).toBe("environment");
  });

  it("treats blank environment values as unset", () => {
    const resolved = resolveFeadsConfig(
      {},
      { P3_FEADS_TOKEN: "  ", P3_FEADS_URL: "", P3_FEADS_BOARD: " " },
    );
    expect(resolved).toEqual({
      token: null,
      tokenSource: "none",
      baseUrl: EXOWATT_FEADS_DEFAULT_BASE_URL,
      defaultBoard: null,
    });
  });

  it("uses P3_FEADS_URL and P3_FEADS_BOARD as defaults that Settings override", () => {
    const env = { P3_FEADS_URL: "https://feads.internal", P3_FEADS_BOARD: "demo" };
    expect(resolveFeadsConfig({}, env)).toMatchObject({
      baseUrl: "https://feads.internal",
      defaultBoard: "demo",
    });
    expect(
      resolveFeadsConfig({ baseUrl: "https://feads.other", defaultBoard: "ia" }, env),
    ).toMatchObject({ baseUrl: "https://feads.other", defaultBoard: "ia" });
  });

  it("falls back to the default URL when the stored one is unusable", () => {
    expect(resolveFeadsConfig({ baseUrl: "nope nope" }, {}).baseUrl).toBe(
      EXOWATT_FEADS_DEFAULT_BASE_URL,
    );
  });
});

describe("stored config codec", () => {
  it("round-trips and tolerates unknown or broken payloads", () => {
    const json = encodeFeadsStoredConfig({ token: "fdsa_x", baseUrl: "https://f" });
    expect(decodeFeadsStoredConfig(json)._tag).toBe("Some");
    expect(decodeFeadsStoredConfig("not json")._tag).toBe("None");
    expect(decodeFeadsStoredConfig(JSON.stringify({ token: 42 }))._tag).toBe("None");
  });
});

describe("decodeFeadsIdentity", () => {
  it("reads the actor off a 200 body", () => {
    expect(
      decodeFeadsIdentity(200, {
        ok: true,
        actor: "alice-agent",
        notifications: [],
        unread_count: 0,
        unhandled_count: 0,
      }),
    ).toEqual({ ok: true, actor: "alice-agent" });
  });

  it("maps 401 to not_identified, preferring the server's own code", () => {
    expect(decodeFeadsIdentity(401, null)).toEqual({ ok: false, error: "not_identified" });
    expect(decodeFeadsIdentity(401, { ok: false, error: "revoked" })).toEqual({
      ok: false,
      error: "revoked",
    });
    expect(decodeFeadsIdentity(403, {})).toEqual({ ok: false, error: "not_identified" });
  });

  it("names other statuses and non-JSON bodies", () => {
    expect(decodeFeadsIdentity(404, null)).toEqual({ ok: false, error: "http_404" });
    expect(decodeFeadsIdentity(503, { ok: false })).toEqual({ ok: false, error: "http_503" });
    expect(decodeFeadsIdentity(200, null)).toEqual({ ok: false, error: "not_json" });
    expect(decodeFeadsIdentity(200, { ok: true })).toEqual({ ok: false, error: "no_actor" });
    expect(decodeFeadsIdentity(200, { ok: false, error: "weird" })).toEqual({
      ok: false,
      error: "weird",
    });
  });
});

describe("helpers", () => {
  it("builds the identity probe URL", () => {
    expect(feadsIdentityProbeUrl("https://feads.example")).toBe(
      "https://feads.example/api/notifications?unread_only=1&limit=1",
    );
  });

  it("redacts tokens out of error text", () => {
    expect(redactFeadsSecrets("Bearer fdsa_2eAbC-xyz_09 rejected")).toBe("Bearer fdsa_… rejected");
  });
});
