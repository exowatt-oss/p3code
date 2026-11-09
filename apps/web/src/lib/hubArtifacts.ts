/**
 * Outputs and sources for the thread Hub, derived on the client from v2 turn items (v2 has no
 * server-side artifact index). Each turn item maps to typed refs, folded into rows with a use
 * count and the item that last touched them. Pure, so the panel memoizes it on item identity.
 */
import {
  type ExowattThreadHubItemKind,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadPullRequestLink,
  type TurnItemId,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as DateTime from "effect/DateTime";

export type HubTurnFilter = "all" | "current";

/**
 * Every kind a Hub row can be. The server's overlay store keys entries on the
 * same kinds, so the union lives in the contract; `note-output` and
 * `note-source` only come from manual entries (`hubOverlay.ts`).
 */
export type HubArtifactKind = ExowattThreadHubItemKind;

const OUTPUT_KINDS: ReadonlySet<HubArtifactKind> = new Set([
  "file-output",
  "pull-request",
  "commit",
  "link-output",
  "preview",
  "attachment",
  "note-output",
]);

export function isHubOutputKind(kind: HubArtifactKind): boolean {
  return OUTPUT_KINDS.has(kind);
}

/** One reference extracted from one turn item. */
export interface HubArtifactRef {
  readonly kind: HubArtifactKind;
  /** Identity within a thread: path, URL, `server/tool`, commit sha… */
  readonly key: string;
  readonly label: string;
  readonly path?: string;
  readonly url?: string;
  /** MCP server for `mcp-tool`. */
  readonly server?: string;
  /** Tool name for `mcp-tool`, query for `web-search`, branch for `commit`. */
  readonly detail?: string;
}

/** A ref folded across every item that mentioned it. */
export interface HubArtifact extends HubArtifactRef {
  /** How many turn items referenced it. */
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** The last item that touched it, for "jump to source". */
  readonly lastItemId: TurnItemId | null;
  readonly lastRunId: RunId | null;
  /** Every run that touched it, for the "This turn" filter. */
  readonly runIds: readonly RunId[];
  /** Pinned in the thread's Hub overlay: shown in the section's Pinned group. */
  readonly pinned?: boolean;
  /** Added by hand rather than derived from the thread's items. */
  readonly manual?: boolean;
  /** The text of a manual note. */
  readonly note?: string;
}

const MAX_REFS_PER_ITEM = 24;
const MAX_LABEL_CHARS = 120;
/** Assistant text is scanned for links; a pasted log can hold hundreds. */
const MAX_LINKS_PER_MESSAGE = 12;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateLabel(value: string): string {
  return value.length <= MAX_LABEL_CHARS ? value : `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return undefined;
  const collapsed = trimmed.replace(/^\.\/(?=.)/u, "");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : collapsed;
}

function parseHttpUrl(value: unknown): URL | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed || trimmed.length > 4096) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function urlLabel(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return truncateLabel(`${url.host}${path}`);
}

export function hubArtifactKey(ref: Pick<HubArtifactRef, "kind" | "key">): string {
  return `${ref.kind}\u0000${ref.key}`;
}

function fileRef(kind: "file-output" | "file-read", rawPath: unknown): HubArtifactRef | undefined {
  const path = normalizePath(asTrimmedString(rawPath));
  if (!path) return undefined;
  return { kind, key: path, label: truncateLabel(hubArtifactBasename(path) || path), path };
}

function urlRef(kind: "url-fetch" | "link-output", rawUrl: unknown): HubArtifactRef | undefined {
  const url = parseHttpUrl(rawUrl);
  return url ? { kind, key: url.href, label: urlLabel(url), url: url.href } : undefined;
}

function webSearchRef(rawQuery: unknown): HubArtifactRef | undefined {
  const query = asTrimmedString(rawQuery);
  if (!query) return undefined;
  return {
    kind: "web-search",
    key: `search:${query.toLowerCase()}`,
    label: truncateLabel(query),
    detail: truncateLabel(query),
  };
}

function skillRef(rawName: unknown): HubArtifactRef | undefined {
  const name = asTrimmedString(rawName);
  if (!name) return undefined;
  return { kind: "skill", key: name, label: truncateLabel(name), detail: name };
}

export function pullRequestRef(link: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title?: string | undefined;
}): HubArtifactRef {
  return {
    kind: "pull-request",
    key: `${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`,
    label: `${link.repository}#${link.number}`,
    url: link.url,
    ...(link.title ? { detail: truncateLabel(link.title) } : {}),
  };
}

function pullRequestRefFromUrl(rawUrl: string): HubArtifactRef | undefined {
  const parsed = sourceControlClients.parseChangeRequestUrl(rawUrl)?.link;
  return parsed ? pullRequestRef({ ...parsed, url: rawUrl }) : undefined;
}

const PREVIEW_SERVER = /^(?:t3[-_]?code|p3[-_]?code)$/iu;

/**
 * The in-app preview browser is an MCP server too; opening or navigating it
 * is an output (the page the agent left on screen), everything else it does
 * is an interaction that is not indexed.
 */
function mcpRefs(
  server: string,
  tool: string,
  args: Record<string, unknown> | undefined,
): HubArtifactRef[] {
  if (PREVIEW_SERVER.test(server) && tool.startsWith("preview_")) {
    if (tool !== "preview_open" && tool !== "preview_navigate") return [];
    const url = parseHttpUrl(args?.url);
    return [
      url
        ? { kind: "preview", key: url.href, label: urlLabel(url), url: url.href }
        : { kind: "preview", key: "preview", label: "Preview" },
    ];
  }
  return [
    {
      kind: "mcp-tool",
      key: `${server}/${tool}`,
      label: truncateLabel(`${server} · ${tool}`),
      server,
      detail: tool,
    },
  ];
}

/** The identity key a typed path gets, so a hand-added file matches the derived row. */
export function hubNormalizePath(value: string): string | undefined {
  return normalizePath(value);
}

/** The identity key a typed URL gets, or undefined for anything but http(s). */
export function hubNormalizeUrl(value: string): string | undefined {
  return parseHttpUrl(value)?.href;
}

/** Display label for a link row: host and path. */
export function hubUrlLabel(href: string): string {
  const url = parseHttpUrl(href);
  return url ? urlLabel(url) : truncateLabel(href);
}

/**
 * A row's ref rebuilt from its overlay identity alone, for a pinned item whose
 * turn items are not loaded (older history behind "Load earlier"). Kinds whose
 * key does not carry enough to draw the row (attachments, notes) return null.
 */
export function hubRefFromIdentity(kind: HubArtifactKind, key: string): HubArtifactRef | null {
  switch (kind) {
    case "file-output":
    case "file-read":
      return fileRef(kind, key) ?? null;
    case "link-output":
    case "url-fetch":
      return urlRef(kind, key) ?? null;
    case "preview": {
      const url = parseHttpUrl(key);
      return url ? { kind, key, label: urlLabel(url), url: url.href } : null;
    }
    case "web-search":
      return key.startsWith("search:") ? (webSearchRef(key.slice("search:".length)) ?? null) : null;
    case "skill":
      return skillRef(key) ?? null;
    case "commit":
      return { kind, key, label: key.slice(0, 7), detail: key.slice(0, 7) };
    case "mcp-tool": {
      const slash = key.indexOf("/");
      if (slash <= 0 || slash === key.length - 1) return null;
      const server = key.slice(0, slash);
      const tool = key.slice(slash + 1);
      return { kind, key, label: truncateLabel(`${server} · ${tool}`), server, detail: tool };
    }
    case "pull-request": {
      const match = /^([^/]+)\/(.+)#(\d+)$/u.exec(key);
      if (!match) return null;
      const [, host, repository, number] = match;
      return {
        kind,
        key,
        label: `${repository}#${number}`,
        // GitHub's shape; the key is lowercased, which GitHub URLs tolerate.
        ...(host === "github.com"
          ? { url: `https://github.com/${repository}/pull/${number}` }
          : {}),
      };
    }
    default:
      return null;
  }
}

/** Claude and OpenCode: `mcp__server__tool`. */
const MCP_DOUBLE_UNDERSCORE = /^mcp__([^_](?:.*?[^_])?)__(.+)$/u;
/** Phi's MCP bridge: `mcp_server_tool` (its own `mcp_find_tools` loader is not a server). */
const MCP_PHI = /^mcp_([a-z0-9][a-z0-9-]*)_(.+)$/u;
/** Codex app-server: `server.tool`. A trailing file extension is a script, not a tool. */
const MCP_CODEX = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
const SCRIPT_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "py", "sh", "rb"]);

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const double = MCP_DOUBLE_UNDERSCORE.exec(toolName);
  if (double) return { server: double[1]!, tool: double[2]! };
  if (toolName !== "mcp_find_tools") {
    const phi = MCP_PHI.exec(toolName);
    if (phi) return { server: phi[1]!, tool: phi[2]! };
  }
  const codex = MCP_CODEX.exec(toolName);
  if (codex && !SCRIPT_EXTENSIONS.has(codex[2]!.toLowerCase())) {
    return { server: codex[1]!, tool: codex[2]! };
  }
  return null;
}

/** Paths named in an apply_patch body (`*** Update File: path`, `*** Add File: path`). */
function applyPatchPaths(patch: unknown): string[] {
  const text = asTrimmedString(patch);
  if (!text) return [];
  const paths: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gmu)) {
    const path = asTrimmedString(match[1]);
    if (path) paths.push(path);
  }
  return paths;
}

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "create_file",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "apply_patch",
  "patch",
]);
const READ_TOOLS = new Set(["read", "read_file", "view", "cat", "notebookread"]);
const FETCH_TOOLS = new Set(["webfetch", "web_fetch", "fetch", "fetch_url", "http_get"]);
const SEARCH_TOOLS = new Set(["websearch", "web_search", "search_web"]);

function refsFromDynamicTool(
  item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
): HubArtifactRef[] {
  const refs: HubArtifactRef[] = [];
  const args = asRecord(item.input);
  if (item.viewedImagePath) {
    const ref = fileRef("file-read", item.viewedImagePath);
    if (ref) refs.push(ref);
  }
  // A browser tool that reported the page it is on: the page is a source.
  if (item.toolIcon?._tag === "website") {
    const ref = urlRef("url-fetch", item.toolIcon.pageUrl);
    if (ref) refs.push(ref);
  }
  const toolName = asTrimmedString(item.toolName);
  if (!toolName) return refs;

  const mcp = parseMcpToolName(toolName);
  if (mcp) return [...refs, ...mcpRefs(mcp.server, mcp.tool, args)];
  // Claude reports the claude.ai connector's display name as the tool source.
  if (item.toolSource?.kind === "integration") {
    return [...refs, ...mcpRefs(item.toolSource.name, toolName, args)];
  }

  const normalized = toolName.toLowerCase().replace(/[\s-]+/gu, "_");
  const pathArg = args?.file_path ?? args?.path ?? args?.notebook_path ?? args?.filePath;
  if (WRITE_TOOLS.has(normalized)) {
    const direct = fileRef("file-output", pathArg);
    if (direct) refs.push(direct);
    for (const path of applyPatchPaths(args?.patch ?? args?.input)) {
      const ref = fileRef("file-output", path);
      if (ref) refs.push(ref);
    }
    return refs;
  }
  if (READ_TOOLS.has(normalized)) {
    const ref = fileRef("file-read", pathArg);
    return ref ? [...refs, ref] : refs;
  }
  if (FETCH_TOOLS.has(normalized)) {
    const ref = urlRef("url-fetch", args?.url);
    return ref ? [...refs, ref] : refs;
  }
  if (SEARCH_TOOLS.has(normalized)) {
    const ref = webSearchRef(args?.query);
    return ref ? [...refs, ref] : refs;
  }
  if (normalized === "skill") {
    const ref = skillRef(args?.skill ?? args?.name);
    return ref ? [...refs, ref] : refs;
  }
  return refs;
}

/** `[main 1a2b3c4] Fix the thing`, the line `git commit` prints for each commit. */
const GIT_COMMIT_LINE = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gmu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/giu;
const PR_CREATE_COMMAND = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create|hub\s+pull-request)\b/u;
const FETCH_COMMAND = /(?:^|[\s;&|(])(?:curl|wget|http)\s/u;

function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function refsFromCommand(
  item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
): HubArtifactRef[] {
  const refs: HubArtifactRef[] = [];
  const output = item.output ?? "";
  for (const match of output.matchAll(GIT_COMMIT_LINE)) {
    const [, branch, sha, message] = match;
    refs.push({
      kind: "commit",
      key: sha!,
      label: truncateLabel(message!.trim()),
      detail: `${branch} · ${sha!.slice(0, 7)}`,
    });
  }
  // `gh pr create` prints the new pull request's URL; that one is an output.
  if (PR_CREATE_COMMAND.test(item.input)) {
    for (const raw of output.match(URL_PATTERN) ?? []) {
      const ref = pullRequestRefFromUrl(trimUrlPunctuation(raw));
      if (ref) refs.push(ref);
    }
  }
  if (FETCH_COMMAND.test(item.input)) {
    for (const raw of item.input.match(URL_PATTERN) ?? []) {
      const ref = urlRef("url-fetch", trimUrlPunctuation(raw));
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Links an assistant message wrote: markdown targets and bare URLs. */
function refsFromAssistantText(text: string): HubArtifactRef[] {
  const refs: HubArtifactRef[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(URL_PATTERN) ?? []) {
    if (refs.length >= MAX_LINKS_PER_MESSAGE) break;
    const ref = urlRef("link-output", trimUrlPunctuation(raw));
    if (!ref || seen.has(ref.key)) continue;
    seen.add(ref.key);
    refs.push(ref);
  }
  return refs;
}

function dedupeRefs(refs: readonly HubArtifactRef[]): HubArtifactRef[] {
  const seen = new Set<string>();
  const result: HubArtifactRef[] = [];
  for (const ref of refs) {
    const key = hubArtifactKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
    if (result.length >= MAX_REFS_PER_ITEM) break;
  }
  return result;
}

/** Typed refs for one v2 turn item. */
export function extractHubRefs(item: OrchestrationV2TurnItem): readonly HubArtifactRef[] {
  switch (item.type) {
    case "file_change": {
      const refs: HubArtifactRef[] = [];
      const changes = item.changes ?? [];
      if (changes.length === 0) {
        const ref = fileRef("file-output", item.fileName);
        if (ref) refs.push(ref);
      }
      for (const change of changes) {
        if (/^delete/iu.test(change.operation)) continue;
        const ref = fileRef("file-output", change.path);
        if (ref) refs.push(ref);
      }
      return dedupeRefs(refs);
    }
    case "checkpoint":
      return dedupeRefs(
        item.files.flatMap((file) => {
          if (/^delete/iu.test(file.kind)) return [];
          const ref = fileRef("file-output", file.path);
          return ref ? [ref] : [];
        }),
      );
    case "web_search":
      return dedupeRefs(
        (item.patterns ?? []).flatMap((pattern) => {
          const fetch = urlRef("url-fetch", pattern);
          if (fetch) return [fetch];
          const search = webSearchRef(pattern);
          return search ? [search] : [];
        }),
      );
    case "dynamic_tool":
      return dedupeRefs(refsFromDynamicTool(item));
    case "command_execution":
      return dedupeRefs(refsFromCommand(item));
    case "assistant_message": {
      if (item.streaming) return [];
      const attachments = (item.attachments ?? []).map((attachment): HubArtifactRef => ({
        kind: "attachment",
        key: attachment.id,
        label: truncateLabel(attachment.name),
      }));
      return dedupeRefs([...attachments, ...refsFromAssistantText(item.text)]);
    }
    default:
      return [];
  }
}

function laterIso(left: string, right: string): string {
  return right > left ? right : left;
}

interface MutableArtifact {
  ref: HubArtifactRef;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastItemId: TurnItemId | null;
  lastRunId: RunId | null;
  runIds: RunId[];
}

/**
 * Folds every loaded item into artifact rows: new refs become rows, known
 * refs bump `count` and their last-seen item. Thread pull-request links are
 * added as outputs; a PR URL the agent also wrote in a message stays one row.
 */
export function deriveHubArtifacts(input: {
  readonly items: readonly OrchestrationV2TurnItem[];
  readonly pullRequests?: readonly ThreadPullRequestLink[];
}): readonly HubArtifact[] {
  const byKey = new Map<string, MutableArtifact>();
  const upsert = (
    ref: HubArtifactRef,
    seenAt: string,
    itemId: TurnItemId | null,
    runId: RunId | null,
  ) => {
    const key = hubArtifactKey(ref);
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, {
        ref,
        count: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        lastItemId: itemId,
        lastRunId: runId,
        runIds: runId === null ? [] : [runId],
      });
      return;
    }
    current.count += 1;
    if (seenAt >= current.lastSeenAt) {
      current.lastItemId = itemId ?? current.lastItemId;
      current.lastRunId = runId ?? current.lastRunId;
    }
    current.lastSeenAt = laterIso(current.lastSeenAt, seenAt);
    if (runId !== null && !current.runIds.includes(runId)) current.runIds.push(runId);
  };

  for (const item of input.items) {
    const refs = extractHubRefs(item);
    if (refs.length === 0) continue;
    const seenAt = DateTime.formatIso(item.completedAt ?? item.startedAt ?? item.updatedAt);
    for (const ref of refs) {
      // A PR URL in a message is that PR, not a separate link.
      if (ref.kind === "link-output" && ref.url) {
        const pr = pullRequestRefFromUrl(ref.url);
        if (pr && byKey.has(hubArtifactKey(pr))) continue;
      }
      upsert(ref, seenAt, item.id, item.runId);
    }
  }

  for (const link of input.pullRequests ?? []) {
    if (link.source === "stack-dismissed") continue;
    const ref = pullRequestRef({
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
      title: link.snapshot?.title,
    });
    const key = hubArtifactKey(ref);
    const existing = byKey.get(key);
    if (existing) {
      // The link carries the title; keep the item that produced it for the jump.
      existing.ref = { ...existing.ref, ...ref };
      continue;
    }
    upsert(ref, link.linkedAt, null, null);
  }

  // A link row for a URL that is also a linked PR folds into the PR row.
  for (const [key, artifact] of byKey) {
    if (artifact.ref.kind !== "link-output" || !artifact.ref.url) continue;
    const pr = pullRequestRefFromUrl(artifact.ref.url);
    if (pr && byKey.has(hubArtifactKey(pr))) byKey.delete(key);
  }

  return [...byKey.values()].map((artifact) => ({
    ...artifact.ref,
    count: artifact.count,
    firstSeenAt: artifact.firstSeenAt,
    lastSeenAt: artifact.lastSeenAt,
    lastItemId: artifact.lastItemId,
    lastRunId: artifact.lastRunId,
    runIds: artifact.runIds,
  }));
}

// ── Grouping, paths and markdown (ported from P3's v1 `hubArtifacts.ts`) ──

export type HubFileGroupId = "documents" | "images" | "code" | "other";

export interface HubFileGroup {
  readonly id: HubFileGroupId;
  readonly label: string;
  readonly artifacts: readonly HubArtifact[];
}

export interface HubMcpToolEntry {
  readonly tool: string;
  readonly count: number;
  readonly artifact: HubArtifact;
}

export interface HubMcpServerGroup {
  readonly server: string;
  readonly count: number;
  readonly tools: readonly HubMcpToolEntry[];
}

export interface HubOutputs {
  /** Pinned outputs of any kind, held above the kind groups. */
  readonly pinned: readonly HubArtifact[];
  /** Documents, images and other files: what a reader opens. */
  readonly files: readonly HubFileGroup[];
  /** Code files are folded on their own: the Diff surface is where they are read. */
  readonly codeFiles: readonly HubArtifact[];
  readonly pullRequests: readonly HubArtifact[];
  readonly commits: readonly HubArtifact[];
  readonly links: readonly HubArtifact[];
  readonly previews: readonly HubArtifact[];
  readonly attachments: readonly HubArtifact[];
  readonly notes: readonly HubArtifact[];
  readonly total: number;
  /** Hidden outputs, after the turn filter; listed behind "Show N hidden". */
  readonly hidden: readonly HubArtifact[];
}

export interface HubSources {
  readonly pinned: readonly HubArtifact[];
  readonly links: readonly HubArtifact[];
  readonly searches: readonly HubArtifact[];
  readonly mcpServers: readonly HubMcpServerGroup[];
  readonly skills: readonly HubArtifact[];
  readonly fileReads: readonly HubArtifact[];
  readonly notes: readonly HubArtifact[];
  readonly total: number;
  readonly hidden: readonly HubArtifact[];
}

export interface HubModel {
  readonly outputs: HubOutputs;
  readonly sources: HubSources;
  /** Artifacts in the model after the turn filter. */
  readonly total: number;
  /** Artifacts before the turn filter, so "This turn" can say it hid things. */
  readonly totalAllTurns: number;
}

const FILE_GROUP_LABELS: Record<HubFileGroupId, string> = {
  documents: "Documents",
  images: "Images",
  code: "Code",
  other: "Other files",
};

/** Render order for the non-code file groups; empty groups are dropped. */
const FILE_GROUP_ORDER: readonly HubFileGroupId[] = ["documents", "images", "other"];

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
  "heic",
  "tif",
  "tiff",
]);

const DOCUMENT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "pdf",
  "rtf",
  "doc",
  "docx",
  "odt",
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "log",
]);

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "graphql",
  "gql",
  "prisma",
  "proto",
  "lua",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
  "scala",
  "clj",
  "zig",
  "nix",
  "gradle",
  "m",
  "mm",
  "r",
  "pl",
]);

/** Extension-free basenames that are still code to a reader. */
const CODE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "justfile",
  "rakefile",
  "gemfile",
  "procfile",
  "brewfile",
]);

export function hubArtifactBasename(pathOrLabel: string): string {
  const trimmed = pathOrLabel.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function hubFileGroupId(pathOrLabel: string): HubFileGroupId {
  const name = hubArtifactBasename(pathOrLabel).toLowerCase();
  if (CODE_BASENAMES.has(name)) return "code";
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile (`.env`), not an extension.
  if (dot <= 0) return "other";
  const extension = name.slice(dot + 1);
  if (IMAGE_EXTENSIONS.has(extension)) return "images";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "documents";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "other";
}

/** Roots a display path can be shortened against, most specific first. */
export interface HubPathRoots {
  readonly worktreePath?: string | null | undefined;
  readonly projectRoot?: string | null | undefined;
  /** Usually derived from the roots; pass one to override the guess. */
  readonly homeDir?: string | null | undefined;
}

const HOME_DIR_PATTERN =
  /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/u;

/** The user's home directory as implied by a known absolute root. */
export function hubHomeDirFromRoot(root: string | null | undefined): string | null {
  if (!root) return null;
  return HOME_DIR_PATTERN.exec(root)?.[0] ?? null;
}

const stripTrailingSeparator = (value: string) => value.replace(/[/\\]+$/u, "");

function relativeTo(path: string, root: string | null | undefined): string | null {
  const base = stripTrailingSeparator(root ?? "");
  if (base.length === 0 || !path.startsWith(base)) return null;
  const rest = path.slice(base.length);
  if (rest.length === 0) return ".";
  if (rest[0] !== "/" && rest[0] !== "\\") return null;
  return rest.slice(1);
}

/**
 * What a path should read as in the panel. An absolute path inside the
 * thread's checkout reads as its workspace-relative tail; anything outside
 * stays absolute (home-relative when it can) so it is obvious it is not in
 * the repo. The full path stays in the tooltip and in copy-path.
 */
export function hubDisplayPath(path: string, roots: HubPathRoots = {}): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return path;
  const absolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (!absolute) return trimmed;
  const inWorkspace =
    relativeTo(trimmed, roots.worktreePath) ?? relativeTo(trimmed, roots.projectRoot);
  if (inWorkspace !== null) return inWorkspace;
  const home =
    roots.homeDir ??
    hubHomeDirFromRoot(roots.worktreePath) ??
    hubHomeDirFromRoot(roots.projectRoot) ??
    hubHomeDirFromRoot(trimmed);
  const inHome = relativeTo(trimmed, home);
  return inHome === null ? trimmed : `~/${inHome}`;
}

/** A workspace-relative path the file surface can open, or null for paths outside it. */
export function hubWorkspaceRelativePath(path: string, roots: HubPathRoots): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  const absolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (!absolute) return trimmed.startsWith("~") ? null : trimmed;
  const relative =
    relativeTo(trimmed, roots.worktreePath) ?? relativeTo(trimmed, roots.projectRoot);
  return relative === null || relative === "." ? null : relative;
}

export function hubArtifactHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Most recently seen first, then label: stable, so a live update never reshuffles rows. */
export function compareHubArtifacts(left: HubArtifact, right: HubArtifact): number {
  if (left.lastSeenAt !== right.lastSeenAt) return left.lastSeenAt < right.lastSeenAt ? 1 : -1;
  return left.label.localeCompare(right.label);
}

const sorted = (artifacts: readonly HubArtifact[]): readonly HubArtifact[] =>
  [...artifacts].sort(compareHubArtifacts);

function groupFiles(artifacts: readonly HubArtifact[]): {
  readonly files: readonly HubFileGroup[];
  readonly code: readonly HubArtifact[];
} {
  const byGroup = new Map<HubFileGroupId, HubArtifact[]>();
  for (const artifact of artifacts) {
    const id = hubFileGroupId(artifact.path ?? artifact.label);
    const bucket = byGroup.get(id);
    if (bucket) bucket.push(artifact);
    else byGroup.set(id, [artifact]);
  }
  const files = FILE_GROUP_ORDER.flatMap((id) => {
    const bucket = byGroup.get(id);
    if (!bucket || bucket.length === 0) return [];
    return [{ id, label: FILE_GROUP_LABELS[id], artifacts: sorted(bucket) }];
  });
  return { files, code: sorted(byGroup.get("code") ?? []) };
}

function groupMcpTools(artifacts: readonly HubArtifact[]): readonly HubMcpServerGroup[] {
  const byServer = new Map<string, HubArtifact[]>();
  for (const artifact of artifacts) {
    const server = artifact.server ?? "Unknown server";
    const bucket = byServer.get(server);
    if (bucket) bucket.push(artifact);
    else byServer.set(server, [artifact]);
  }
  return [...byServer.entries()]
    .map(([server, bucket]) => ({
      server,
      count: bucket.reduce((total, artifact) => total + artifact.count, 0),
      // Chips read best most-used-first.
      tools: [...bucket]
        .sort((left, right) => {
          if (left.count !== right.count) return right.count - left.count;
          return left.label.localeCompare(right.label);
        })
        .map((artifact) => ({
          tool: artifact.detail ?? artifact.label,
          count: artifact.count,
          artifact,
        })),
    }))
    .sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      return left.server.localeCompare(right.server);
    });
}

/**
 * "This turn" keeps what the latest run touched. Pinned and hand-added rows
 * stay too: the user put them there to keep them in view.
 */
export function filterHubArtifactsByTurn(
  artifacts: readonly HubArtifact[],
  turnFilter: HubTurnFilter,
  latestRunId: RunId | null,
): readonly HubArtifact[] {
  if (turnFilter === "all" || latestRunId === null) return artifacts;
  return artifacts.filter(
    (artifact) =>
      artifact.pinned === true || artifact.manual === true || artifact.runIds.includes(latestRunId),
  );
}

export function buildHubModel(
  artifacts: readonly HubArtifact[],
  options: {
    turnFilter: HubTurnFilter;
    latestRunId: RunId | null;
    /** Rows the overlay hides (`applyHubOverlay`), listed behind "Show N hidden". */
    hidden?: readonly HubArtifact[];
  },
): HubModel {
  const visible = filterHubArtifactsByTurn(artifacts, options.turnFilter, options.latestRunId);
  const hidden = filterHubArtifactsByTurn(
    options.hidden ?? [],
    options.turnFilter,
    options.latestRunId,
  );
  const pinned = visible.filter((artifact) => artifact.pinned === true);
  const byKind = new Map<HubArtifactKind, HubArtifact[]>();
  for (const artifact of visible) {
    if (artifact.pinned === true) continue;
    const bucket = byKind.get(artifact.kind);
    if (bucket) bucket.push(artifact);
    else byKind.set(artifact.kind, [artifact]);
  }
  const of = (kind: HubArtifactKind) => byKind.get(kind) ?? [];

  const { files, code } = groupFiles(of("file-output"));
  const pullRequests = sorted(of("pull-request"));
  const commits = sorted(of("commit"));
  const outputLinks = sorted(of("link-output"));
  const previews = sorted(of("preview"));
  const attachments = sorted(of("attachment"));
  const outputNotes = sorted(of("note-output"));
  const pinnedOutputs = sorted(pinned.filter((artifact) => isHubOutputKind(artifact.kind)));
  const outputsTotal =
    pinnedOutputs.length +
    of("file-output").length +
    pullRequests.length +
    commits.length +
    outputLinks.length +
    previews.length +
    attachments.length +
    outputNotes.length;

  const links = sorted(of("url-fetch"));
  const searches = sorted(of("web-search"));
  const mcpServers = groupMcpTools(of("mcp-tool"));
  const skills = sorted(of("skill"));
  const fileReads = sorted(of("file-read"));
  const sourceNotes = sorted(of("note-source"));
  const pinnedSources = sorted(pinned.filter((artifact) => !isHubOutputKind(artifact.kind)));
  const sourcesTotal =
    pinnedSources.length +
    links.length +
    searches.length +
    of("mcp-tool").length +
    skills.length +
    fileReads.length +
    sourceNotes.length;

  return {
    outputs: {
      pinned: pinnedOutputs,
      files,
      codeFiles: code,
      pullRequests,
      commits,
      links: outputLinks,
      previews,
      attachments,
      notes: outputNotes,
      total: outputsTotal,
      hidden: sorted(hidden.filter((artifact) => isHubOutputKind(artifact.kind))),
    },
    sources: {
      pinned: pinnedSources,
      links,
      searches,
      mcpServers,
      skills,
      fileReads,
      notes: sourceNotes,
      total: sourcesTotal,
      hidden: sorted(hidden.filter((artifact) => !isHubOutputKind(artifact.kind))),
    },
    total: outputsTotal + sourcesTotal,
    totalAllTurns: artifacts.length,
  };
}

const countSuffix = (count: number) => (count > 1 ? ` (×${count})` : "");

function markdownLink(label: string, url: string | undefined): string {
  return url ? `[${label}](${url})` : label;
}

/**
 * A pasteable brief of what a thread produced and consulted. Sections with no
 * rows are omitted so the output stays readable for a short thread.
 */
export function hubArtifactsMarkdown(
  model: HubModel,
  options: {
    threadTitle?: string | undefined;
    turnFilter?: HubTurnFilter;
    agents?: ReadonlyArray<{ readonly title: string; readonly status: string }>;
  } = {},
): string {
  const lines: string[] = [];
  const title = options.threadTitle?.trim();
  lines.push(`# ${title && title.length > 0 ? title : "Thread"}: outputs & sources`);
  if (options.turnFilter === "current") lines.push("", "_Latest turn only._");

  const agents = options.agents ?? [];
  if (agents.length > 0) {
    lines.push("", "## Agents");
    for (const agent of agents) lines.push(`- ${agent.title} (${agent.status})`);
  }

  const { outputs, sources } = model;
  const pinnedList = (artifacts: readonly HubArtifact[]) => {
    if (artifacts.length === 0) return;
    lines.push("", "### Pinned");
    for (const artifact of artifacts) {
      const target = artifact.url ?? artifact.path;
      lines.push(
        `- ${artifact.url ? markdownLink(artifact.label, artifact.url) : target ? `\`${target}\`` : artifact.label}${artifact.note ? `: ${artifact.note}` : ""}`,
      );
    }
  };
  const noteList = (artifacts: readonly HubArtifact[]) => {
    if (artifacts.length === 0) return;
    lines.push("", "### Notes");
    for (const artifact of artifacts) lines.push(`- ${artifact.note ?? artifact.label}`);
  };
  const fileList = (heading: string, artifacts: readonly HubArtifact[]) => {
    if (artifacts.length === 0) return;
    lines.push("", `### ${heading}`);
    for (const artifact of artifacts) {
      lines.push(`- \`${artifact.path ?? artifact.label}\`${countSuffix(artifact.count)}`);
    }
  };
  if (outputs.total > 0) {
    lines.push("", "## Outputs");
    pinnedList(outputs.pinned);
    for (const group of outputs.files) fileList(group.label, group.artifacts);
    fileList(FILE_GROUP_LABELS.code, outputs.codeFiles);
    if (outputs.pullRequests.length > 0) {
      lines.push("", "### Pull requests");
      for (const artifact of outputs.pullRequests) {
        const suffix = artifact.detail ? `: ${artifact.detail}` : "";
        lines.push(`- ${markdownLink(artifact.label, artifact.url)}${suffix}`);
      }
    }
    if (outputs.commits.length > 0) {
      lines.push("", "### Commits");
      for (const artifact of outputs.commits) {
        lines.push(`- \`${artifact.key.slice(0, 7)}\` ${artifact.label}`);
      }
    }
    if (outputs.links.length > 0) {
      lines.push("", "### Links");
      for (const artifact of outputs.links) {
        lines.push(`- ${markdownLink(artifact.label, artifact.url)}`);
      }
    }
    if (outputs.previews.length > 0) {
      lines.push("", "### Previews");
      for (const artifact of outputs.previews) {
        lines.push(`- ${markdownLink(artifact.label, artifact.url)}`);
      }
    }
    if (outputs.attachments.length > 0) {
      lines.push("", "### Attachments");
      for (const artifact of outputs.attachments) lines.push(`- ${artifact.label}`);
    }
    noteList(outputs.notes);
  }

  if (sources.total > 0) {
    lines.push("", "## Sources");
    pinnedList(sources.pinned);
    if (sources.links.length > 0) {
      lines.push("", "### Pages");
      for (const artifact of sources.links) {
        lines.push(`- ${markdownLink(artifact.label, artifact.url)}${countSuffix(artifact.count)}`);
      }
    }
    if (sources.searches.length > 0) {
      lines.push("", "### Searches");
      for (const artifact of sources.searches) {
        lines.push(`- ${artifact.detail ?? artifact.label}${countSuffix(artifact.count)}`);
      }
    }
    if (sources.mcpServers.length > 0) {
      lines.push("", "### MCP tools");
      for (const group of sources.mcpServers) {
        const tools = group.tools
          .map((entry) => `${entry.tool}${countSuffix(entry.count)}`)
          .join(", ");
        lines.push(`- **${group.server}**: ${tools}`);
      }
    }
    if (sources.skills.length > 0) {
      lines.push("", "### Skills");
      for (const artifact of sources.skills) {
        lines.push(`- ${artifact.detail ?? artifact.label}${countSuffix(artifact.count)}`);
      }
    }
    if (sources.fileReads.length > 0) {
      lines.push("", `### Files read (${sources.fileReads.length})`);
      for (const artifact of sources.fileReads) {
        lines.push(`- \`${artifact.path ?? artifact.label}\`${countSuffix(artifact.count)}`);
      }
    }
    noteList(sources.notes);
  }

  if (model.total === 0 && agents.length === 0) lines.push("", "_No outputs or sources yet._");
  return `${lines.join("\n")}\n`;
}
