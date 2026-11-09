# Agent Access (MCP)

Use this when you want a coding agent — Claude Code, a Cursor agent, or a script — to drive P3 Code the way you would from the app: open threads and send them messages, read what they said, organize and settle them, change settings, and configure the harnesses. The server exposes this as an MCP endpoint at `<origin>/mcp`, authenticated with an ordinary bearer session you can revoke at any time.

## In-app agents already have it

Every agent session P3 starts — Phi, Codex, Claude Code, Cursor, Grok, OpenCode — is connected to this server's MCP endpoint automatically, with the same tools an agent token gets (section 4): threads and projects, server and client settings, harness configuration, feads. An agent running inside a thread can reconfigure the environment it runs on. Nothing to set up. Codex, Claude Code, Cursor, Grok and OpenCode see the tools on the `t3-code` MCP server; Phi sees them as `p3_thread_list`, `p3_settings_update`, and so on. Destructive tools (`thread_delete`, `thread_revert`, `project_delete`) take `confirm: true`, so an agent has to mean it.

Settings › Sharing & access › **Agent P3 tools** switches this off for sessions started from then on. **Agent browser access** stays its own switch.

The rest of this page is for agents running _outside_ P3: Claude Code or Cursor in a terminal, a script, another machine.

## 1. Find the running server

The desktop app and `t3 serve` both record where they are listening:

```bash
cat ~/.t3/userdata/server-runtime.json
# {"version":1,"pid":…,"port":3773,"origin":"http://127.0.0.1:3773",…}
```

`origin` is what the agent connects to. `t3 agent token` reads this file for you; you only need it by hand for the curl fallback below. A dev server inside a worktree writes the same file under that worktree's data directory (pass `--base-dir` to point the CLI at it).

## 2. Mint a token

**You usually do not have to.** P3 connects itself: at startup, every twelve hours, and whenever you switch the setting back on, it writes a `p3` entry — this server's `/mcp` plus an `Authorization` header — into the config of every harness installed on the machine (Phi, Codex, Claude Code, Cursor, Grok, OpenCode), and rotates the token a week before it expires. Harnesses you do not have are left alone, and a harness that is already connected is not rewritten. Each harness gets its own session, listed in Settings › Authorized Clients as `p3-auto:<harness>` — revoke one there and the next run mints a replacement.

The switch is Settings › Customize › MCP › **Connectors** › **Keep P3 connected**, with **Reconnect now** beside it when you do not want to wait. The same row's **Add to** buttons still write a single harness on demand, and the CLI route below is for other machines, for scripts, and for a harness on a box where P3 is not running.

```bash
npx t3 agent token --label claude-code
```

This issues a 30-day bearer session with the standard client scopes (read and operate threads; no access-management rights) and prints a paste-ready config:

```json
{
  "mcpServers": {
    "p3": {
      "url": "http://127.0.0.1:3773/mcp",
      "headers": { "Authorization": "Bearer eyJ…" }
    }
  }
}
```

Flags:

- `--label <name>`: what shows up in Settings › Authorized Clients (default `coding-agent`).
- `--ttl 7d`: shorter or longer lifetime.
- `--client cursor|claude-code|json`: shape of the printed snippet (default `cursor`; `claude-code` adds `"type": "http"`, `json` is for scripts).
- `--origin http://…`: override the server origin instead of reading `server-runtime.json`.
- `--base-dir <dir>`: target a non-default data directory.

The token is shown once. Treat it like a password: keep it out of git (Cursor's `.cursor/mcp.json` and Claude Code's `.mcp.json` are usually ignored; check your repo's `.gitignore`).

## 3. Connect the agent

**Cursor**: merge the snippet into `.cursor/mcp.json` in the workspace (or `~/.cursor/mcp.json` for every workspace), then reload MCP servers from Cursor Settings › MCP. The server appears as `p3` with the tools below.

**Claude Code**: merge the `--client claude-code` snippet into `.mcp.json` at the repo root, or run:

```bash
claude mcp add --transport http p3 http://127.0.0.1:3773/mcp \
  --header "Authorization: Bearer eyJ…"
```

## 4. What the agent can do

Every action in the app has a tool: the sidebar's right-click menu, the thread header, the composer controls, the Project Settings dialog, the Settings pages, and Settings › Customize › MCP / Skills / Plugins / Extensions. Tool results are JSON with the typed payload under `structuredContent`.

**Reading threads**

| Tool                | What it does                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_list`      | Projects on this server (needed for `thread_create`).                                                                                                                                                                                                                                                                                  |
| `thread_list`       | Threads, filtered by state (`needs-you`, `running`, `idle`, `archived`, …) or project. Each row carries `settled` (plus the raw `settledAt` / `settledOverride`), and `includeSettled: false` drops the threads you already moved to the settled shelf — `state: ["needs-you"], includeSettled: false` is what you must still look at. |
| `thread_search`     | Find threads by text across titles, your messages and the replies.                                                                                                                                                                                                                                                                     |
| `thread_status`     | Where one thread stands, and what it is waiting on you for.                                                                                                                                                                                                                                                                            |
| `thread_detail`     | The rest of the thread: model, permission and interaction modes, branch, worktree, linked PR, pinned/snoozed/settled.                                                                                                                                                                                                                  |
| `thread_transcript` | A thread's user/assistant messages, newest first, paginated.                                                                                                                                                                                                                                                                           |
| `thread_summaries`  | Digests without an LLM call: the latest run's final assistant message and the results its subagents reported.                                                                                                                                                                                                                          |
| `thread_diff`       | The code a thread changed, as a diff between its turn checkpoints — one turn, a range, or everything.                                                                                                                                                                                                                                  |

**Running work**

| Tool               | What it does                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_create`    | Start a thread in a project with a first message (`text`; the agent writes a brief for the receiving thread; model, plan mode, branch and worktree optional). |
| `thread_forward`   | Send a message (`text`) to an existing thread; the agent writes a brief for the receiving thread.                                                             |
| `thread_respond`   | Answer a pending approval or question.                                                                                                                        |
| `thread_listen`    | Block until a thread finishes its current turn (or times out).                                                                                                |
| `thread_interrupt` | Stop the turn a thread is running, the way the composer's stop button does.                                                                                   |
| `thread_stop`      | Shut down a thread's provider session without archiving it.                                                                                                   |

**Organizing threads**

| Tool                                | What it does                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_update`                     | Rename (or regenerate the title), change model, permission mode, interaction mode, branch or worktree, pin, snooze, settle/unsettle, archive/unarchive. |
| `thread_pin` / `thread_unpin`       | Pin a thread to the top of the sidebar, or unpin it.                                                                                                    |
| `thread_pin_reorder`                | Move a pinned thread within the pinned order.                                                                                                           |
| `thread_snooze` / `thread_unsnooze` | Hide a thread until a time you name, or wake it now.                                                                                                    |

**Projects** (destructive ones need `confirm: true`)

| Tool             | What it does                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `project_create` | Add a project rooted at a directory, optionally creating the directory.                                     |
| `project_update` | Change any Project Settings field: name, root, default model, default thread environment, favicon, scripts. |
| `project_delete` | Delete a project (with `force: true` when it still has threads).                                            |
| `thread_delete`  | Delete a thread and its history, permanently. Prefer `thread_update` with `archived: true`.                 |
| `thread_revert`  | Roll a thread's workspace back to one of its turn checkpoints, discarding later file changes.               |

**Settings**

| Tool                                                          | What it does                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings_get` / `settings_update`                            | Read or patch the server settings: provider settings, background activity, auto-settle, agent browser access, text-generation model, source-control writing style, observability. |
| `client_settings_apply` / `client_settings_push_get`          | Push appearance, font, sidebar, accent and confirmation preferences to every P3 client of this environment (they live in each client, so this is a push, not a read).             |
| `thread_focus`                                                | Bring a thread on screen in every connected P3 client (there is no per-thread deep link); the thread itself is not changed.                                                       |
| `thread_hub_pin`                                              | Pin, hide or unhide an item in a thread's Hub (Outputs and Sources), or add a link, file path or note to it by hand; every connected P3 client updates live.                      |
| `server_config_get`                                           | The server's bootstrap config: environment, auth policy, providers, keybindings, editors.                                                                                         |
| `keybinding_list` / `keybinding_upsert` / `keybinding_remove` | Read and edit the keybindings file.                                                                                                                                               |
| `provider_list` / `provider_refresh` / `provider_update`      | Provider instances and their models (the two halves of a `modelSelection`), re-probe them, or install/update a provider CLI.                                                      |
| `theme_list` / `theme_set`                                    | The built-in and published themes, and the environment theme every client adopts (`t3 theme set`).                                                                                |

**Harness configuration**

| Tool                                                                 | What it does                                                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness_mcp_list` / `harness_mcp_add` / `harness_mcp_toggle`        | The MCP servers configured in each harness (Phi, Codex, Claude Code, Cursor, Grok, OpenCode); add one; enable or disable one.                         |
| `harness_mcp_status` / `harness_mcp_connect`                         | Phi's and Claude Code's runtime view of their MCP servers — for Claude Code including the claude.ai connectors — and the OAuth login for one of them. |
| `harness_asset_list` / `harness_asset_toggle`                        | Skills, plugins and extensions per harness; enable or disable one.                                                                                    |
| `connector_list` / `connector_add`                                   | The local P3 connector catalog; add the P3 entry to a harness. Configure external services separately.  |
| `connector_reconcile`                                                | Run the automatic connection now: every installed harness gets a valid `p3` entry, and says what changed per harness.                                 |
| `feads_status` / `feads_configure` / `feads_clear` / `feads_test`    | The feads integration on Settings › Sharing & access.                                                                                                 |
| `feads_agentwatch` / `feads_my_issues` / `feads_inbox` / `feads_ack` | Who is active on the board, your in-progress beads, your inbox, and acknowledging notifications.                                                      |

Typical flow for an agent: `project_list` → `thread_create` → `thread_listen` → `thread_transcript`, `thread_summaries` or `thread_diff` → `thread_update` with `settled: true` when done.

The tables above are exactly what `tools/list` returns to an agent token, and what P3's own in-app agent sessions get as well. The browser-preview tools (`preview_*`) that in-app sessions use need a provider session bound to a browser tab, so they are the one group an agent token does not get.

## Reach your other environments

If the desktop app connects to more than one P3 server — your laptop and a devbox, say — agents on your laptop can work with threads on the devbox too. Turn on Settings › Sharing & access › **Agents reach my other environments** (off by default, desktop app only). Choose **All environments** in the settings scope picker to set every connected environment at once.

While it is on, the desktop app links each environment it is connected to over SSH or a paired bearer session. For each one it creates a session on that environment, labelled `p3-peer:<this environment> (<its id>)` in that environment's Settings › Authorized Clients, and replaces the one it created before. Revoke it there to cut the link; turning the switch off drops every link at once. Agents never see the credential. Only you can turn the switch on: an agent cannot change it through the settings tools.

This link lets agents on your laptop start and message threads on the devbox, and those threads run agent turns there at the permission level they are given, capped at the calling agent's own level. Treat turning it on like giving the devbox's agents a login from your laptop. **This direction needs no setting on the devbox, before or after upgrading**: your laptop already holds operate access to any environment it connects to (it launched it over SSH, or you paired a bearer session with it), so nothing on the devbox's side can withhold or interrupt this link.

Agents then:

1. Call `environment_list` to see this environment and the linked ones.
2. Pass `environmentId` to `project_list`, `thread_list`, `thread_search`, `thread_status`, `thread_detail`, `thread_transcript`, `thread_summaries`, `thread_listen`, `thread_forward` or `thread_create`.

Every other tool works only on the environment the agent runs on. A thread an agent starts elsewhere runs at no higher permission level than that agent's own thread, and a message to an existing thread there runs at that thread's own permission level. `thread_create` on another environment needs that environment's `projectId`, so call `project_list` with the same `environmentId` first.

Good to know:

- An SSH-connected environment is reachable only while the desktop app holds its connection open; otherwise the tool says the environment is unreachable.
- Links renew automatically while the desktop app runs. If a tool says a link expired or was revoked, reopen the desktop app.
- The other environment must run a P3 build that has these tools; an older one is reported by name rather than failing silently.
- Relay-connected environments are not linked yet.

### The other direction: an SSH-connected environment reaching your laptop

An SSH-connected environment (a devbox) can also reach back into the machine running the desktop app — the reverse of the direction above — over a private socket carried inside the same SSH connection, while that connection is open. An agent on the devbox uses the exact same tools and the same `environmentId` mechanism as above, just pointed the other way: it passes your laptop's `environmentId` to `project_list`, `thread_create`, `thread_forward` and the rest.

This is the one direction your laptop (or whichever machine runs the desktop app) must explicitly allow, because the devbox is the less trusted side here: it is where a reverse link's bearer is stored, and that bearer grants access back into your laptop. Turn on Settings › Sharing & access › **Agents from my other environments may act here**, scoped to your laptop's own environment (never "All"), and pick a level: Approval required, Auto-accept edits or Full access. It is off by default.

This control only matters on the machine running the desktop app — a devbox has no way to be the _target_ of a reverse link, so the control is only editable when you have **This device** selected in Settings › Sharing & access, and is disabled on any other environment. Off refuses the devbox's agents, revokes their session on your laptop and cancels work they queued that has not started yet; lowering the level, or raising a thread above it, cancels queued work that would now run above it, while a turn already running is left to finish. A `thread_create` from the devbox defaults to, and is capped at, this level; it may target only your laptop's project root or a worktree one of that project's threads already uses. Treat **Full access** here like giving the devbox's agents a login on your laptop. The level bounds what the devbox's agents ask for directly, not what the laptop thread they start does next: if that thread's agent has the Threads tools (Settings › Sharing & access), it can start or message threads at any level, subject to its own approval prompts, so pick the level with that in mind.

This control is entirely separate from **Agents reach my other environments** above: it never gates that direction, and that direction never gates this one — upgrading changes nothing about your laptop reaching the devbox. If a tool run from the devbox says your laptop does not accept agents from its other environments, turn this control on there.

## 5. Revoke

```bash
npx t3 auth session list
npx t3 auth session revoke <session-id>
```

or remove the client from Settings › Authorized Clients. Either takes effect immediately for the MCP endpoint.

## 6. curl fallback

The endpoint speaks MCP over streamable HTTP (JSON-RPC 2.0) with server-side sessions: `initialize` once, then echo the returned `mcp-session-id` and the protocol version on every call. Without an MCP client:

```bash
ORIGIN=$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.t3/userdata/server-runtime.json"))["origin"])')
TOKEN=$(npx t3 agent token --label curl --client json | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

SID=$(curl -sS -i "$ORIGIN/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')

mcp() {
  curl -sS "$ORIGIN/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "mcp-session-id: $SID" \
    -H "mcp-protocol-version: 2025-06-18" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
  echo
}

mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"thread_list","arguments":{"state":["needs-you"]}}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"thread_transcript","arguments":{"threadId":"<thread-id>","turnLimit":5}}}'
```

Tool results are JSON with the typed payload under `result.structuredContent`. An empty `400` means the session or protocol-version header is missing; `401` means the token is missing, expired, or revoked; `403` means the session lacks `orchestration:operate`.

## Troubleshooting

- **`401 Unauthorized` right after minting**: the agent is pointed at a different server than the one whose data directory issued the token. Compare `server-runtime.json` against the `url` in your config.
- **`thread_create` fails with "projectId is required"**: agents connected this way are not themselves threads, so they must name a project. Call `project_list` first.
- **Tools missing after an app update**: reload the MCP server in your agent; the tool list is fetched once at connect time.
- **No `preview_*` tools**: expected. They are only available to P3's in-app agent sessions; see section 4.
