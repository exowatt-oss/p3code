import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHubModel,
  deriveHubArtifacts,
  extractHubRefs,
  hubArtifactsMarkdown,
  hubDisplayPath,
  hubFileGroupId,
  hubWorkspaceRelativePath,
  parseMcpToolName,
} from "./hubArtifacts";

const threadId = ThreadId.make("thread-A");
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");
let ordinal = 0;

function item(
  fields: Record<string, unknown> & { type: OrchestrationV2TurnItem["type"] },
  at = "2026-10-01T00:00:00.000Z",
  runId: RunId = run1,
): OrchestrationV2TurnItem {
  ordinal += 1;
  const time = DateTime.makeUnsafe(at);
  return {
    id: TurnItemId.make(`item-${ordinal}`),
    threadId,
    runId,
    nodeId: "node-1",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

const tool = (toolName: string, input: unknown = {}, extra: Record<string, unknown> = {}) =>
  item({ type: "dynamic_tool", toolName, input, output: null, ...extra });

describe("parseMcpToolName", () => {
  it("reads Claude, Phi and Codex MCP names", () => {
    expect(parseMcpToolName("mcp__t3-code__delegate_task")).toEqual({
      server: "t3-code",
      tool: "delegate_task",
    });
    expect(parseMcpToolName("mcp_copper_jev_run")).toEqual({ server: "copper", tool: "jev_run" });
    expect(parseMcpToolName("linear.create_issue")).toEqual({
      server: "linear",
      tool: "create_issue",
    });
  });

  it("does not read a script name or phi's loader as a server", () => {
    expect(parseMcpToolName("cua_repl.js")).toBeNull();
    expect(parseMcpToolName("mcp_find_tools")).toBeNull();
    expect(parseMcpToolName("Read")).toBeNull();
  });
});

describe("extractHubRefs", () => {
  it("maps file changes and checkpoints to file outputs, skipping deletions", () => {
    expect(
      extractHubRefs(
        item({
          type: "file_change",
          fileName: "src/a.ts",
          changes: [
            { operation: "update", path: "src/a.ts" },
            { operation: "delete", path: "src/gone.ts" },
            { operation: "add", path: "./docs/notes.md" },
          ],
        }),
      ).map((ref) => [ref.kind, ref.key]),
    ).toEqual([
      ["file-output", "src/a.ts"],
      ["file-output", "docs/notes.md"],
    ]);
    expect(
      extractHubRefs(
        item({
          type: "checkpoint",
          files: [
            { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
            { path: "old.txt", kind: "deleted", additions: 0, deletions: 3 },
          ],
        }),
      ).map((ref) => ref.key),
    ).toEqual(["README.md"]);
  });

  it("reads tools by name: writes, reads, fetches, searches, skills, MCP", () => {
    expect(extractHubRefs(tool("Write", { file_path: "/w/out.md" }))[0]).toMatchObject({
      kind: "file-output",
      path: "/w/out.md",
      label: "out.md",
    });
    expect(extractHubRefs(tool("read", { path: "src/x.ts" }))[0]?.kind).toBe("file-read");
    expect(extractHubRefs(tool("WebFetch", { url: "https://example.com/a" }))[0]).toMatchObject({
      kind: "url-fetch",
      label: "example.com/a",
    });
    expect(extractHubRefs(tool("WebSearch", { query: "effect schema" }))[0]?.kind).toBe(
      "web-search",
    );
    expect(extractHubRefs(tool("Skill", { skill: "hyperframes" }))[0]?.kind).toBe("skill");
    expect(extractHubRefs(tool("mcp__linear__create_issue"))[0]).toMatchObject({
      kind: "mcp-tool",
      server: "linear",
      detail: "create_issue",
    });
  });

  it("uses Claude's integration source as the server name", () => {
    expect(
      extractHubRefs(
        tool(
          "search_threads",
          {},
          {
            toolSource: { key: "mcp:gmail", name: "claude.ai Gmail", kind: "integration" },
          },
        ),
      )[0],
    ).toMatchObject({ kind: "mcp-tool", server: "claude.ai Gmail", detail: "search_threads" });
  });

  it("treats the preview browser's open/navigate as a preview output and drops its other tools", () => {
    expect(
      extractHubRefs(tool("mcp__t3-code__preview_open", { url: "http://localhost:5173/" }))[0],
    ).toMatchObject({ kind: "preview", url: "http://localhost:5173/" });
    expect(extractHubRefs(tool("mcp__t3-code__preview_click"))).toEqual([]);
  });

  it("indexes the page a browser tool reported", () => {
    expect(
      extractHubRefs(
        tool(
          "browser_navigate",
          {},
          { toolIcon: { _tag: "website", pageUrl: "https://docs.x.io/a" } },
        ),
      )[0],
    ).toMatchObject({ kind: "url-fetch", url: "https://docs.x.io/a" });
  });

  it("reads commits and created pull requests out of shell output", () => {
    const refs = extractHubRefs(
      item({
        type: "command_execution",
        input: "git commit -m 'Fix' && gh pr create --fill",
        output:
          "[feat/hub 1a2b3c4d] Bring back the Hub\n 3 files changed\nhttps://github.com/exowatt/p3code/pull/42\n",
      }),
    );
    expect(refs.map((ref) => [ref.kind, ref.label])).toEqual([
      ["commit", "Bring back the Hub"],
      ["pull-request", "exowatt/p3code#42"],
    ]);
    expect(refs[0]?.detail).toBe("feat/hub · 1a2b3c4");
  });

  it("does not index PR URLs a command merely printed", () => {
    expect(
      extractHubRefs(
        item({
          type: "command_execution",
          input: "gh pr view 42",
          output: "https://github.com/exowatt/p3code/pull/42",
        }),
      ),
    ).toEqual([]);
  });

  it("collects links from finished assistant messages only", () => {
    expect(
      extractHubRefs(
        item({
          type: "assistant_message",
          messageId: "m1",
          text: "Deployed to https://app.example.com/. See [docs](https://docs.example.com/x).",
          streaming: false,
        }),
      ).map((ref) => ref.url),
    ).toEqual(["https://app.example.com/", "https://docs.example.com/x"]);
    expect(
      extractHubRefs(
        item({ type: "assistant_message", messageId: "m2", text: "https://a.b/", streaming: true }),
      ),
    ).toEqual([]);
  });
});

describe("deriveHubArtifacts", () => {
  const pullRequest = {
    host: "github.com",
    repository: "exowatt/p3code",
    number: 42,
    url: "https://github.com/exowatt/p3code/pull/42",
    source: "agent",
    linkedAt: "2026-10-01T00:00:05.000Z",
    snapshot: { title: "Bring back the Hub" },
    stack: null,
  } as unknown as ThreadPullRequestLink;

  it("folds repeats into one row with a count, the last item and every run", () => {
    const first = tool("Read", { file_path: "a.md" }, {});
    const second = item(
      { type: "dynamic_tool", toolName: "Read", input: { file_path: "a.md" }, output: null },
      "2026-10-01T00:01:00.000Z",
      run2,
    );
    const [row] = deriveHubArtifacts({ items: [first, second] });
    expect(row).toMatchObject({ kind: "file-read", count: 2, lastItemId: second.id });
    expect(row?.runIds).toEqual([run1, run2]);
  });

  it("merges a linked PR with the PR the agent wrote about, keeping the jump target", () => {
    const message = item({
      type: "assistant_message",
      messageId: "m1",
      text: "Opened https://github.com/exowatt/p3code/pull/42",
      streaming: false,
    });
    const created = item({
      type: "command_execution",
      input: "gh pr create",
      output: "https://github.com/exowatt/p3code/pull/42",
    });
    const artifacts = deriveHubArtifacts({
      items: [created, message],
      pullRequests: [pullRequest],
    });
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["pull-request"]);
    expect(artifacts[0]).toMatchObject({ detail: "Bring back the Hub", lastItemId: created.id });
  });

  it("drops a message link that is a linked PR even without a creating command", () => {
    const message = item({
      type: "assistant_message",
      messageId: "m1",
      text: "See https://github.com/exowatt/p3code/pull/42",
      streaming: false,
    });
    expect(
      deriveHubArtifacts({ items: [message], pullRequests: [pullRequest] }).map((it) => it.kind),
    ).toEqual(["pull-request"]);
  });
});

describe("buildHubModel", () => {
  const items = [
    tool("Write", { file_path: "docs/plan.md" }),
    tool("Edit", { file_path: "src/a.ts" }),
    tool("mcp__linear__create_issue"),
    tool("mcp__linear__create_issue"),
    tool("mcp__linear__get_issue"),
    item(
      { type: "dynamic_tool", toolName: "Read", input: { file_path: "src/b.ts" }, output: null },
      "2026-10-01T00:02:00.000Z",
      run2,
    ),
  ];
  const artifacts = deriveHubArtifacts({ items });

  it("splits code edits from readable files and groups MCP tools by server", () => {
    const model = buildHubModel(artifacts, { turnFilter: "all", latestRunId: run2 });
    expect(model.outputs.files.map((group) => group.id)).toEqual(["documents"]);
    expect(model.outputs.codeFiles.map((artifact) => artifact.key)).toEqual(["src/a.ts"]);
    expect(model.sources.mcpServers).toEqual([
      expect.objectContaining({
        server: "linear",
        count: 3,
        tools: [
          expect.objectContaining({ tool: "create_issue", count: 2 }),
          expect.objectContaining({ tool: "get_issue", count: 1 }),
        ],
      }),
    ]);
    expect(model.total).toBe(5);
  });

  it("filters to the latest run", () => {
    const model = buildHubModel(artifacts, { turnFilter: "current", latestRunId: run2 });
    expect(model.total).toBe(1);
    expect(model.sources.fileReads.map((artifact) => artifact.key)).toEqual(["src/b.ts"]);
    expect(model.totalAllTurns).toBe(5);
  });

  it("exports markdown with agents and every non-empty section", () => {
    const markdown = hubArtifactsMarkdown(
      buildHubModel(artifacts, { turnFilter: "all", latestRunId: run2 }),
      { threadTitle: "Hub", agents: [{ title: "Explore", status: "running" }] },
    );
    expect(markdown).toContain("# Hub: outputs & sources");
    expect(markdown).toContain("- Explore (running)");
    expect(markdown).toContain("- **linear**: create_issue (×2), get_issue");
    expect(markdown).toContain("`docs/plan.md`");
  });
});

describe("paths", () => {
  const roots = { worktreePath: "/Users/c/wt", projectRoot: "/Users/c/repo" };

  it("shows workspace paths relative and outside paths home-relative", () => {
    expect(hubDisplayPath("/Users/c/wt/src/a.ts", roots)).toBe("src/a.ts");
    expect(hubDisplayPath("/Users/c/notes/x.md", roots)).toBe("~/notes/x.md");
    expect(hubDisplayPath("/tmp/x", roots)).toBe("/tmp/x");
  });

  it("only offers the file surface for paths in the workspace", () => {
    expect(hubWorkspaceRelativePath("/Users/c/repo/a.md", roots)).toBe("a.md");
    expect(hubWorkspaceRelativePath("src/a.ts", roots)).toBe("src/a.ts");
    expect(hubWorkspaceRelativePath("/tmp/x", roots)).toBeNull();
    expect(hubWorkspaceRelativePath("~/x", roots)).toBeNull();
  });

  it("groups by extension", () => {
    expect(hubFileGroupId("a/Dockerfile")).toBe("code");
    expect(hubFileGroupId("shot.PNG")).toBe("images");
    expect(hubFileGroupId("notes.md")).toBe("documents");
    expect(hubFileGroupId(".env")).toBe("other");
  });
});
