import {
  RunId,
  ThreadId,
  TurnItemId,
  type ExowattThreadHubEntry,
  type ExowattThreadHubItemKind,
  type ExowattThreadHubManual,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHubModel, hubArtifactsMarkdown, type HubArtifact } from "./hubArtifacts";
import { applyHubOverlay, hubManualUpsert, inferHubManualType } from "./hubOverlay";

const threadId = ThreadId.make("thread-hub");
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

function derived(
  kind: HubArtifact["kind"],
  key: string,
  fields: Partial<HubArtifact> = {},
): HubArtifact {
  return {
    kind,
    key,
    label: key,
    count: 1,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z",
    lastItemId: TurnItemId.make(`item-${key}`),
    lastRunId: run1,
    runIds: [run1],
    ...(kind === "file-output" || kind === "file-read" ? { path: key } : {}),
    ...(kind === "link-output" || kind === "url-fetch" ? { url: key } : {}),
    ...fields,
  };
}

function entry(
  kind: ExowattThreadHubItemKind,
  key: string,
  fields: { pinned?: boolean; hidden?: boolean; manual?: ExowattThreadHubManual } = {},
): ExowattThreadHubEntry {
  return {
    threadId,
    kind,
    key,
    pinned: fields.pinned ?? false,
    hidden: fields.hidden ?? false,
    manual: fields.manual ?? null,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

describe("applyHubOverlay", () => {
  const rows = [
    derived("file-output", "docs/plan.md"),
    derived("file-output", "docs/notes.md"),
    derived("url-fetch", "https://example.com/a"),
  ];

  it("passes derived rows through untouched when nothing is overlaid", () => {
    expect(applyHubOverlay(rows, [])).toEqual({ visible: rows, hidden: [] });
  });

  it("marks pins and moves hidden rows aside", () => {
    const result = applyHubOverlay(rows, [
      entry("file-output", "docs/plan.md", { pinned: true }),
      entry("url-fetch", "https://example.com/a", { hidden: true }),
    ]);
    expect(result.visible.map((row) => [row.key, row.pinned ?? false])).toEqual([
      ["docs/plan.md", true],
      ["docs/notes.md", false],
    ]);
    expect(result.hidden.map((row) => row.key)).toEqual(["https://example.com/a"]);
  });

  it("does not match across kinds: a read is not the written file", () => {
    const result = applyHubOverlay(rows, [entry("file-read", "docs/plan.md", { hidden: true })]);
    expect(result.visible).toHaveLength(3);
    expect(result.hidden).toEqual([]);
  });

  it("adds manual entries as rows, and names a matching derived row after them", () => {
    const result = applyHubOverlay(rows, [
      entry("note-output", "note:1", { manual: { title: "Ship it", note: "Ship it Monday" } }),
      entry("url-fetch", "https://example.com/a", {
        manual: { title: "Spec", url: "https://example.com/a" },
      }),
    ]);
    const note = result.visible.find((row) => row.kind === "note-output");
    expect(note).toMatchObject({
      key: "note:1",
      label: "Ship it",
      note: "Ship it Monday",
      manual: true,
      count: 0,
      lastItemId: null,
      runIds: [],
    });
    const page = result.visible.find((row) => row.kind === "url-fetch");
    // The derived row keeps its jump target and count; the user's name wins.
    expect(page).toMatchObject({ label: "Spec", manual: true, count: 1, lastRunId: run1 });
    expect(result.visible).toHaveLength(4);
  });

  it("rebuilds a pinned row whose turn items are not loaded, and drops a hidden one", () => {
    const result = applyHubOverlay(
      [],
      [
        entry("pull-request", "github.com/example/p3code#210", { pinned: true }),
        entry("file-read", "/Users/c/notes/brief.md", { pinned: true }),
        entry("attachment", "att-1", { pinned: true }),
        entry("file-output", "gone.md", { hidden: true }),
      ],
    );
    expect(result.visible.map((row) => [row.kind, row.label, row.url ?? row.path])).toEqual([
      ["pull-request", "example/p3code#210", "https://github.com/example/p3code/pull/210"],
      ["file-read", "brief.md", "/Users/c/notes/brief.md"],
    ]);
    expect(result.hidden).toEqual([]);
  });
});

describe("buildHubModel with the overlay", () => {
  const rows = [
    derived("file-output", "docs/plan.md"),
    derived("file-output", "docs/old.md"),
    derived("commit", "abc1234def", { lastRunId: run2, runIds: [run2] }),
    derived("url-fetch", "https://example.com/a"),
  ];
  const entries = [
    entry("file-output", "docs/plan.md", { pinned: true }),
    entry("file-output", "docs/old.md", { hidden: true }),
    entry("note-source", "note:1", { manual: { title: "Context", note: "Context from Alex" } }),
  ];
  const overlaid = applyHubOverlay(rows, entries);

  it("holds pinned rows in their section's Pinned group, out of their kind group", () => {
    const model = buildHubModel(overlaid.visible, {
      turnFilter: "all",
      latestRunId: run2,
      hidden: overlaid.hidden,
    });
    expect(model.outputs.pinned.map((row) => row.key)).toEqual(["docs/plan.md"]);
    expect(model.outputs.files).toEqual([]);
    expect(model.outputs.hidden.map((row) => row.key)).toEqual(["docs/old.md"]);
    expect(model.sources.notes.map((row) => row.key)).toEqual(["note:1"]);
    expect(model.sources.pinned).toEqual([]);
    // Pinned + commit; Page + note. Hidden rows are not counted.
    expect(model.outputs.total).toBe(2);
    expect(model.sources.total).toBe(2);
  });

  it("keeps pinned and hand-added rows under This turn", () => {
    const model = buildHubModel(overlaid.visible, {
      turnFilter: "current",
      latestRunId: run2,
      hidden: overlaid.hidden,
    });
    expect(model.outputs.pinned.map((row) => row.key)).toEqual(["docs/plan.md"]);
    expect(model.outputs.commits.map((row) => row.key)).toEqual(["abc1234def"]);
    expect(model.sources.notes).toHaveLength(1);
    expect(model.sources.links).toEqual([]);
    // The hidden row is from run 1, so this turn has nothing hidden.
    expect(model.outputs.hidden).toEqual([]);
  });

  it("exports pins and notes to markdown", () => {
    const markdown = hubArtifactsMarkdown(
      buildHubModel(overlaid.visible, { turnFilter: "all", latestRunId: run2 }),
      {},
    );
    expect(markdown).toContain("### Pinned\n- `docs/plan.md`");
    expect(markdown).toContain("### Notes\n- Context from Alex");
    expect(markdown).not.toContain("docs/old.md");
  });
});

describe("manual add", () => {
  it("guesses links, paths and notes", () => {
    expect(inferHubManualType("https://example.com/x")).toBe("link");
    expect(inferHubManualType("~/notes/brief.md")).toBe("file");
    expect(inferHubManualType("apps/web/src/a.ts")).toBe("file");
    expect(inferHubManualType("README.md")).toBe("file");
    expect(inferHubManualType("ask Alex about the relay")).toBe("note");
    expect(inferHubManualType("ftp://example.com/x")).toBe("note");
  });

  it("keys links and files the way the derivation does, so they meet the derived row", () => {
    expect(
      hubManualUpsert({
        threadId,
        section: "sources",
        type: "link",
        value: " https://Example.com/a ",
        newId: () => "unused",
      }),
    ).toEqual({
      threadId,
      kind: "url-fetch",
      key: "https://example.com/a",
      manual: { title: "example.com/a", url: "https://example.com/a" },
    });
    expect(
      hubManualUpsert({
        threadId,
        section: "outputs",
        type: "file",
        value: "./docs/plan.md",
        newId: () => "unused",
      }),
    ).toMatchObject({
      kind: "file-output",
      key: "docs/plan.md",
      manual: { title: "plan.md", path: "docs/plan.md" },
    });
  });

  it("titles a note by its first line and gives it a fresh key", () => {
    expect(
      hubManualUpsert({
        threadId,
        section: "outputs",
        type: "note",
        value: "\nDeploy is green\nAlex owns rollback",
        newId: () => "n1",
      }),
    ).toEqual({
      threadId,
      kind: "note-output",
      key: "note:n1",
      manual: { title: "Deploy is green", note: "Deploy is green\nAlex owns rollback" },
    });
  });

  it("refuses a value that is not what its type says", () => {
    const base = { threadId, section: "outputs", newId: () => "x" } as const;
    expect(hubManualUpsert({ ...base, type: "link", value: "not a url" })).toBeNull();
    expect(hubManualUpsert({ ...base, type: "note", value: "   " })).toBeNull();
  });
});
