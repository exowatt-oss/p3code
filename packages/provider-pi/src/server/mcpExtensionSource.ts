// No T3 imports inside the string; resolve Pi and typebox from the user's Pi install.

export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

// These tools trigger file-change approvals, bypassed by Auto-accept edits.
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

/**
 * exowatt: core t3-code tools active from the first turn; the rest load via `find_tools`
 * (all ~130 schemas cost ~50k prompt tokens per fresh thread or model switch). Core is
 * delegation, `t3_thread_read` (context-handoff recovery) and PR linking.
 */
export const PI_T3_EAGER_TOOLS = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_thread_read",
  "link_pull_request",
] as const;

export const PI_T3_FIND_TOOLS_NAME = "mcp__t3-code__find_tools";
export const PI_T3_LOADED_TOOL_ENTRY = "t3-code-loaded-tool";

/**
 * exowatt: Pi's compact form of the shared `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (keep the
 * rules in step). Per-tool detail arrives with each tool once `find_tools` loads it.
 */
export const PI_T3_ORCHESTRATION_INSTRUCTIONS = `## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration; its tools are prefixed \`mcp__t3-code__\`. Only core tools are loaded. Before calling any other T3 tool, named here or elsewhere, load it with \`mcp__t3-code__find_tools\` (exact names); its description has the details.

- Delegated tasks/subagents are child work of this thread. Pick provider and model from \`orchestrator_capabilities\` (the composer's live catalog, not a native tool's model list). Use native subagent tools only for same-provider work they support; otherwise use \`delegate_task\`, also for cross-provider or explicitly T3-owned child tasks. Keep each \`taskId\` for \`task_status\`/\`task_cancel\`. The returned \`childThreadId\` is backing storage; never replace delegation with thread creation. Every delegated review round is a new \`delegate_task\` carrying the brief, prior findings and open objections, with its own \`taskId\` and \`clientRequestId\`; never continue one with \`t3_thread_send\`.
- \`t3_thread_launch\` (one thread) and \`create_threads\` (a batch sharing this checkout) create ordinary top-level conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations, never merely for "subagent" or parallel delegated work.
- Choose a new thread's workspace in the \`t3_thread_launch\` call with \`workspaceStrategy\`: a new \`worktree\`, an \`existing_worktree\`, or \`root\`. Omitting it selects root, not your worktree; \`git worktree add\` or \`cd\` in the prompt does not rebind the thread. \`t3_worktree_list\` finds checkouts; \`t3_worktree_handoff\` moves only the calling thread. Launch has no retry key, so check \`t3_thread_list\` before retrying.
- Recurring work is \`schedule_task\`; the shared app browser is the \`preview_*\` tools (start with \`preview_status\`, \`preview_open\`, \`preview_navigate\`, \`preview_snapshot\`). A secret the user must supply (token, API key, webhook signing secret) comes from \`request_secret\`: pass its one-time \`secretRef\` to a T3 tool or use \`delivery: "file"\` for a shell command; never ask for, invent or repeat a secret in chat. When a chart, table, diagram or mockup says more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before the final reply.
- Another machine: \`t3_environment_links\` lists linked ones; pass its \`environmentId\` to a T3 tool to act there (ids are then that machine's). For a machine the user names that is not linked, call \`t3_environment_link\` with a \`hint\` from their words; never ask for a pairing code in chat.
- Link other P3 threads as \`[title](p3://thread/<threadId>)\`, never a bare ID: percent-encode the exact ID (including \`thread:project:…\` and \`delegated-task\` IDs) as one path segment, \`)\` included, and escape backslashes and square brackets in the title. Register every pull request you open with \`link_pull_request\` and link PRs by full GitHub URL, never a bare number.
- Never poll a running delegate (\`task_status\`, \`sleep\`): follow its \`next\` and end your turn; stop one you no longer need with \`task_cancel\`. Do not duplicate active work, and reuse stable \`clientRequestId\` values on retries.`;

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const EXTENSION_PATH_ENV = ${JSON.stringify(T3_PI_MCP_EXTENSION_PATH_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(PI_T3_ORCHESTRATION_INSTRUCTIONS)};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});
const EAGER_TOOLS = new Set(${JSON.stringify(PI_T3_EAGER_TOOLS)});
const TOOL_PREFIX = "mcp__t3-code__";
const FIND_TOOLS_NAME = ${JSON.stringify(PI_T3_FIND_TOOLS_NAME)};
const LOADED_TOOL_ENTRY = ${JSON.stringify(PI_T3_LOADED_TOOL_ENTRY)};
const FIND_DEFAULT_LIMIT = 5;
const FIND_MAX_LIMIT = 25;

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly outputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

// One short line per tool in the system prompt; the full description
// already travels with the tool definition.
function promptSnippetFor(description: string): string {
  const line = description.split("\\n")[0] ?? description;
  const first = line.match(/^.*?[.!?](?=\\s|$)/)?.[0] ?? line;
  const sentence = first.length >= 40 ? first : line;
  return sentence.length > 160 ? sentence.slice(0, 157) + "..." : sentence;
}

function bareToolName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith(TOOL_PREFIX) ? trimmed.slice(TOOL_PREFIX.length) : trimmed;
}

// Exact names (bare or prefixed, comma/space separated) load exactly those
// tools; otherwise keywords rank not-yet-loaded tools, name matches above
// description matches, so repeating a query reaches lower-ranked matches.
function findDeferredTools(
  query: string,
  catalog: ReadonlyArray<McpTool>,
  loaded: ReadonlySet<string>,
  limit: number,
): McpTool[] {
  const byName = new Map(catalog.map((tool) => [tool.name.toLowerCase(), tool]));
  const words = query.split(/[\\s,]+/).filter(Boolean).map((word) => bareToolName(word).toLowerCase());
  if (words.length > 0 && words.every((word) => byName.has(word))) {
    return [...new Set(words)].map((word) => byName.get(word)!);
  }
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
  const scored: Array<{ tool: McpTool; score: number }> = [];
  for (const tool of catalog) {
    if (loaded.has(tool.name)) continue;
    const name = tool.name.toLowerCase();
    const text = (tool.description ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      else if (text.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return scored.slice(0, limit).map((entry) => entry.tool);
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    // Zero-argument MCP tools may omit "properties", which some OpenAI-compatible
    // servers reject. Declare it, as Pi does for its own MCP tools.
    return unsafe({
      ...schema,
      type: schema.type ?? "object",
      ...(schema.properties === undefined ? { properties: {} } : {}),
    });
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Pi's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function mcpScriptResult(result: JsonValue | undefined) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const { _meta: _ignored, ...scriptResult } = result;
  return scriptResult;
}

function mcpOutputSchema(tool: McpTool) {
  return jsonSchemaToTypebox({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(tool.outputSchema === undefined ? {} : { structuredContent: tool.outputSchema }),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  });
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  // RPC has no trust prompt, so Pi skips an untrusted folder's protected resources. Session
  // replacement reruns this factory without project_trust, and T3 drops notices outside a turn,
  // so check each session's first turn. An explicit --no-approve is deliberate and stays quiet.
  let projectTrustChecked = false;
  pi.on("before_agent_start", (_event, ctx) => {
    if (projectTrustChecked) return;
    projectTrustChecked = true;
    if (ctx.isProjectTrusted() || process.argv.some((arg) => arg === "--no-approve" || arg === "-na")) return;
    ctx.ui.notify(
      \`Pi did not load project settings, extensions, skills, prompts, MCP servers or system prompt files for \${ctx.cwd} because the folder is not trusted. To load them, run the configured Pi binary there with the same PI_CODING_AGENT_DIR (if set), trust the folder or its parent with /trust, then start a new thread in that same worktree. To trust every project, add --approve to Pi's launch arguments in T3 Code settings; to keep them off without this notice, add --no-approve.\`,
      "warning",
    );
  });

  // Keep skill chips in the request. Pi expands only one leading /skill:
  // command, so use its own frontmatter loader for every selected chip here.
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("$")) return;
    const commands = pi.getCommands().filter((command) => command.source === "skill");
    const nativeSkill = /^\\/skill:([^ ]+)(?: |$)/.exec(event.text)?.[1];
    const seen = new Set<string>(nativeSkill === undefined ? [] : [nativeSkill]);
    const blocks: string[] = [];
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (name === undefined || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name);
      if (command === undefined) continue;
      seen.add(name);
      const path = command.sourceInfo.path;
      try {
        const body = stripFrontmatter(await NodeFSP.readFile(path, "utf8")).trim();
        blocks.push(
          \`<skill name="\${name}" location="\${path}">\\nReferences are relative to \${NodePath.dirname(path)}.\\n\\n\${body}\\n</skill>\`,
        );
      } catch {
        ctx.ui.notify(\`Could not load skill \${name} from \${path}.\`, "error");
      }
    }
    if (blocks.length === 0) return;
    return {
      action: "transform",
      text: event.text + "\\n\\n" + blocks.join("\\n\\n"),
      images: event.images,
    };
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");

  const readOnlyMcpTools = new Set<string>();
  const isReadOnlyMcpTool = (name: string) => {
    const extensionPath = env(EXTENSION_PATH_ENV);
    if (extensionPath === undefined || !readOnlyMcpTools.has(name) || typeof pi.getAllTools !== "function") return false;
    // A user extension may own the same name. Only our registered HTTP bridge
    // may inherit the canonical T3 server's read-only annotation.
    return pi.getAllTools().some((tool) => tool.name === name &&
      typeof tool.sourceInfo?.path === "string" &&
      NodePath.resolve(tool.sourceInfo.path) === NodePath.resolve(extensionPath));
  };

  pi.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    if (mode === "full-access") return;
    if ((event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) || isReadOnlyMcpTool(event.toolName)) {
      return;
    }
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
      { signal: ctx.signal },
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
    }
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    return;
  }

  // Tool exposure arrived with registerMcpServer in Pi 0.99. Keep the HTTP
  // bridge as the credential owner: mcp.json overrides native registrations.
  const supportsExposure = "registerMcpServer" in pi && typeof pi.registerMcpServer === "function";
  let catalog: ReadonlyArray<McpTool> = [];

  const client = createMcpClient(endpoint, token);
  let started: Promise<void> | undefined;
  const registered = new Set<string>();
  const hiddenRegistered = new Set<string>();
  const deferred: McpTool[] = [];
  const loaded = new Set<string>();

  // Withhold deferred tools that this session has not loaded. Pi rebuilds the
  // system prompt and tool list from the active set only, so inactive tools
  // cost nothing until find_tools activates them.
  const applyToolModes = () => {
    if (registered.size === 0) return;
    const withheld = new Set(
      deferred.filter((tool) => !loaded.has(tool.name)).map((tool) => TOOL_PREFIX + tool.name),
    );
    const active = pi.getActiveTools();
    const next = active.filter((name) => !withheld.has(name));
    for (const name of registered) {
      if (!withheld.has(name) && !next.includes(name)) next.push(name);
    }
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
      pi.setActiveTools(next);
    }
  };

  // Loaded tools are session state: a resumed or forked session keeps them.
  const restoreLoadedTools = (ctx: { sessionManager?: { getBranch?: () => unknown[] } }) => {
    loaded.clear();
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      const record = entry as { type?: string; customType?: string; data?: { tool?: unknown } };
      if (record.type !== "custom" || record.customType !== LOADED_TOOL_ENTRY) continue;
      if (typeof record.data?.tool === "string") loaded.add(record.data.tool);
    }
  };

  const registerFinder = () => {
    if (deferred.length === 0 || registered.has(FIND_TOOLS_NAME)) return;
    const names = deferred.map((tool) => tool.name).join(", ");
    registered.add(FIND_TOOLS_NAME);
    pi.registerTool({
      name: FIND_TOOLS_NAME,
      label: "find_tools",
      description: [
        "Load more t3-code MCP tools. Only core t3-code tools are loaded up front; the rest are listed here and become callable after this loads them.",
        \`Not loaded yet: \${names}.\`,
        "Pass exact names (comma-separated) or a few words for the capability you need.",
      ].join(" "),
      promptSnippet: "Load more t3-code MCP tools by name or capability",
      promptGuidelines: [
        \`Only core t3-code tools are loaded up front. To use any other T3 tool named in these instructions or the user's request (for example schedule_task, create_threads, thread_update or settings_update), call \${FIND_TOOLS_NAME} with its name first.\`,
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Exact tool names, comma-separated, or capability keywords." }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: FIND_MAX_LIMIT,
            description: \`Maximum keyword matches to load. Default \${FIND_DEFAULT_LIMIT}.\`,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const input = (params ?? {}) as { query?: unknown; limit?: unknown };
        const query = typeof input.query === "string" ? input.query : "";
        const limit =
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? Math.min(FIND_MAX_LIMIT, Math.max(1, Math.floor(input.limit)))
            : FIND_DEFAULT_LIMIT;
        const matches = findDeferredTools(query, deferred, loaded, limit);
        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: \`No t3-code tool matched "\${query}". Not loaded yet: \${names}.\` }],
            details: { server: "t3-code", query, loaded: [] },
          };
        }
        for (const tool of matches) {
          if (loaded.has(tool.name)) continue;
          loaded.add(tool.name);
          try {
            pi.appendEntry(LOADED_TOOL_ENTRY, { tool: tool.name });
          } catch {
            // Persistence is best effort; the tool is still active this run.
          }
        }
        applyToolModes();
        const loadedNames = matches.map((tool) => TOOL_PREFIX + tool.name);
        return {
          content: [
            {
              type: "text",
              text: \`Loaded: \${loadedNames.join(", ")}. Call them directly now.\`,
            },
          ],
          details: { server: "t3-code", query, loaded: loadedNames },
        };
      },
    });
  };

  const registerTools = () => {
    // Preserve public names for saved loadouts and tool selectors. Hidden
    // canonical names reserve ownership against Pi's configured MCP servers.
    const prefixes = supportsExposure ? [TOOL_PREFIX, "mcp__t3_code__"] : [TOOL_PREFIX];
    for (const tool of catalog) {
      const name = tool.name;
      const description = tool.description ?? name;
      for (const prefix of prefixes) {
        const registeredName = prefix + name;
        if (tool.annotations?.readOnlyHint === true) readOnlyMcpTools.add(registeredName);
        if (registered.has(registeredName) || hiddenRegistered.has(registeredName)) continue;
        // exowatt: only the public name joins the active loadout. Core tools
        // start active and the rest wait for find_tools (applyToolModes), so
        // Pi's own tool_search exposure never decides what Phi loads.
        const hidden = prefix !== TOOL_PREFIX;
        const exposure = hidden ? "hidden" : "direct";
        if (hidden) {
          hiddenRegistered.add(registeredName);
        } else {
          if (!EAGER_TOOLS.has(name)) deferred.push(tool);
          registered.add(registeredName);
        }
        pi.registerTool({
          name: \`\${prefix}\${name}\`,
          label: name,
          description,
          ...(hidden ? {} : { promptSnippet: promptSnippetFor(description) }),
          parameters: jsonSchemaToTypebox(tool.inputSchema),
          ...(supportsExposure ? { outputSchema: mcpOutputSchema(tool) } : {}),
          ...(supportsExposure ? { exposure } : {}),
          async execute(_toolCallId, params, signal) {
            const result = await client.callTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              signal,
            );
            const content = mcpModelContent(result);
            if (isMcpToolError(result) && !content.some((part) => part.type === "text" && part.text.length > 0)) {
              content.push({ type: "text", text: "MCP tool t3-code/" + name + " returned an error" });
            }
            return {
              content,
              structuredContent: mcpScriptResult(result),
              details: { server: "t3-code", tool: name },
              ...(isMcpToolError(result) ? { isError: true } : {}),
            };
          },
        });
      }
    }
  };

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await client.connect(signal);
      catalog = await client.listTools(signal);
      registerTools();
      registerFinder();
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // CLI extensions load before builtins, and Pi keeps the first registration
  // of a tool name. Register now so the bridge owns the T3 namespace even when
  // mcp.json configures it; retry a failed connection at session_start.
  await ensureStarted().catch(() => undefined);

  // The branch's loaded-tool entries decide what stays active, so a resumed,
  // forked or tree-navigated session keeps the tools it already loaded.
  const reconcileLoadout = (ctx: Pick<ExtensionContext, "sessionManager">) => {
    restoreLoadedTools(ctx);
    applyToolModes();
  };

  // Tree navigation restores its saved loadout after session_start.
  pi.on("session_tree", (_event, ctx) => reconcileLoadout(ctx));
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureStarted();
      reconcileLoadout(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`t3-code MCP unavailable: \${message}\`, "warning");
    }
  });

  // Keep guidance in the system prompt so leading slash commands still expand.
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      // A full prompt override bypasses Pi's later section rendering.
      sections.t3_code_orchestration = ORCHESTRATION_INSTRUCTIONS;
      return undefined;
    }
    return { systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS };
  });
}
`;
