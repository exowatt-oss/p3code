# Phi

Phi is an optional coding-agent provider in P3 Code. Its default provider slot is enabled for discovery, but no Phi process starts until you install its binary and choose it for a thread. P3 launches the `phi` binary in native RPC mode:

```text
phi --mode rpc
```

Install the `phi` binary using the source and release instructions at [exowatt-oss/phi](https://github.com/exowatt-oss/phi). The upstream `pi` npm package does not provide this fork’s `phi` executable.

P3 does not replace Phi's home or session directory. Phi continues to load the user's
`~/.pi/agent` settings, credentials, extensions, skills, prompts, and session history. P3's own
configuration and data remain in their existing locations.

## Start threads from the CLI

`t3 thread start` creates a real P3 sidebar thread and sends its first message through the running
P3 server. This is useful for automation and for coordinators that need to hand durable work to a
separate thread:

```bash
t3 thread start <project-id-or-workspace-root> "Investigate the failing deploy" \
  --title "Investigate deploy" \
  --instance phi \
  --model your-provider/your-model \
  --thinking-level high \
  --json
```

Omit `--instance`, `--model`, and `--thinking-level` to inherit the project's configured default.
When a project has no default, pass both `--instance` and `--model`. The command validates an
explicit model and thinking level against the running installation's provider catalog before it
creates the thread.

Use `--existing-worktree <path>` to bind the thread to an existing checkout of the project. The path must already exist;
the command does not create a Git worktree.

The macOS desktop bundle does not currently install `t3` on `PATH`. Invoke its bundled CLI as:

```bash
P3_APP="/Applications/P3 Code.app"
ELECTRON_RUN_AS_NODE=1 "$P3_APP/Contents/MacOS/P3 Code" \
  "$P3_APP/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
  thread start <project-id-or-workspace-root> "Initial instruction" --json
```

The command discovers the running local server, creates a short-lived authenticated session scoped
to orchestration read/write, starts the thread through the server's `thread_create` MCP tool, and
revokes that session before exiting. Creating the thread and its first message is one step, so a
failure leaves no empty thread behind.

## Supported now

- new persistent sessions and resume from Phi's native session file
- streamed assistant text, thinking, and tool activity
- images and readable local-file attachments
- queued follow-ups (Enter queues, Cmd+Enter stops and sends)
- delivery status that waits for Phi to report the input entering its context
- cancellation and model changes between turns
- Phi's inherited/default model plus its provider-qualified model catalog
- automatic model reroutes: when Phi falls back to another model (a refusal or a gateway error) the
  work log names the model that took over and why. Your next message puts your choice back, so one
  reroute never silently redefines the session. Errors name both the requested and the served model,
  so a failure is never attributed to the wrong one. The model picker keeps showing your selection
  throughout — it is what the next turn runs on.
- thinking level follows the model: switching models sends the new model's own supported level, so a
  level the previous model allowed is not carried onto one that rejects it
- P3 runtime modes, with safe read tools allowed automatically and other tools routed through P3
  approval
- P3 preview/browser tools through a session-scoped extension
- P3 tools (`p3_thread_list`, `p3_thread_create`, `p3_thread_forward`, `p3_settings_update`, `p3_harness_mcp_add`, …) through the same extension, on by default (Settings › Sharing & access › Agent P3 tools). Every ordinary Phi thread can coordinate other threads; older stored model selections that contain the removed relay option continue as ordinary sessions.
- hard failure and process termination on malformed or desynchronized RPC traffic
- Phi's end-of-turn hand-back: when Phi records that it is waiting on your decision, the thread
  shows that question as pending input and the thread is flagged as needing you. Your answer is
  sent to Phi as the next message; sending any other message clears the question. Phi builds
  without this record behave as before.

## Temporary stable-adapter limits

This adapter is intentionally isolated until P3 adopts Orchestration V2. It does not yet provide
provider-side rewind/rollback, Phi-backed title or commit-message generation, session-wide approval
grants, Phi command/prompt discovery in P3, or V2's richer native activity and session-history
representation. Approval-required operations support allow-once or decline; full-access and
auto-accept-edits remain explicit runtime-mode choices.

P3 never silently permits an unrecognized blocking UI request or tool execution outside an active
turn. It stops the Phi process instead.
