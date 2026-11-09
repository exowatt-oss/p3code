/**
 * "Open as P3 thread": turn a feads bead into a thread whose first message is its brief,
 * built on the server (`FeadsBeadBrief`) so the token never leaves here. Writing back to
 * feads is best effort: a bead that cannot be commented on still gets its thread.
 *
 * @module FeadsOpenThread
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ExowattFeadsError,
  type ExowattFeadsOpenThreadInput,
  type ExowattFeadsOpenThreadResult,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous ids for P3 commands and messages.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { buildFeadsBeadBrief } from "./FeadsBeadBrief.ts";
import * as FeadsBridge from "./FeadsBridge.ts";

const failure = (reason: string) => new ExowattFeadsError({ operation: "open_thread", reason });

/**
 * What lands on the bead once its thread exists. The thread id rather than a
 * URL on purpose: a P3 environment is reached at whatever host its owner runs
 * it on, so a link built here would be right for one reader and wrong for the
 * rest, while the id identifies the thread on every surface.
 */
export function feadsOpenedThreadComment(threadTitle: string, threadId: string): string {
  return `Opened as a P3 thread: "${threadTitle}" (thread \`${threadId}\`). Work and updates happen there; this bead stays the record.`;
}

export const openBeadThread: (
  input: ExowattFeadsOpenThreadInput,
) => Effect.Effect<
  ExowattFeadsOpenThreadResult,
  ExowattFeadsError,
  | FeadsBridge.FeadsBridge
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | ThreadLaunch.ThreadLaunchService
> = Effect.fn("FeadsOpenThread.openBeadThread")(function* (input) {
  const issueId = input.issueId.trim();
  if (issueId.length === 0) return yield* failure("no_issue_id");
  const bridge = yield* FeadsBridge.FeadsBridge;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;

  const project = yield* projects
    .getShell(input.projectId)
    .pipe(Effect.mapError((cause) => failure(cause.message)));
  if (Option.isNone(project)) return yield* failure("project_not_found");

  // The project's own default first, then the server's; a thread with no model
  // cannot start, and /agents has no composer to pick one in.
  const serverSettings = yield* settings.getSettings.pipe(
    Effect.mapError((cause) => failure(cause.message)),
  );
  const modelSelection =
    input.modelSelection ??
    project.value.defaultModelSelection ??
    serverSettings.defaultModelSelection;
  if (modelSelection === undefined || modelSelection === null) {
    return yield* failure("no_default_model");
  }

  const bead = yield* bridge.readBead(issueId);
  const brief = buildFeadsBeadBrief(bead);
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const messageId = MessageId.make(NodeCrypto.randomUUID());
  yield* launches
    .launch({
      commandId: CommandId.make(`feads:open-thread:${NodeCrypto.randomUUID()}`),
      threadId,
      projectId: input.projectId,
      title: brief.title,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId, text: brief.text, attachments: [] },
      // The user asked for it; the server wrote the brief.
      createdBy: "user",
      creationSource: "server",
    })
    .pipe(Effect.mapError((cause) => failure(cause.message)));

  // Past this point the thread exists, so nothing feads says can turn the call
  // into a failure — the note is what the client reports instead.
  const comment = yield* bridge.commentOnBead({
    issueId,
    text: feadsOpenedThreadComment(brief.title, threadId),
  });
  return {
    threadId,
    title: brief.title,
    commentPosted: comment.kind === "posted",
    commentError: comment.kind === "posted" ? null : comment.error,
  };
});
