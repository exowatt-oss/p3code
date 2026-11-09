import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertSimpleOutput } from "./codex_output.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function lastPiResponseData(transcript: ProviderReplayTranscript, command: string): unknown {
  const frame = transcript.entries
    .flatMap((entry) => (entry.type === "emit_inbound" ? [entry.frame] : []))
    .findLast(
      (candidate) =>
        field(candidate, "type") === "response" && field(candidate, "command") === command,
    );
  assert.isDefined(frame, `transcript must record a ${command} response`);
  return field(frame, "data");
}

function count(value: unknown, key: string): number {
  const raw = field(value, key);
  return typeof raw === "number" ? raw : 0;
}

/**
 * exowatt: a settled turn's usage is its last assistant `message_end` usage (input includes cache
 * reads and writes); `get_session_stats` only supplies the window, falling back for turns without
 * message usage. The turn's own tokens sum every assistant message.
 */
export function assertPiSettledTokenUsage(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const segments: Array<{ stats: unknown; usages: Array<unknown> }> = [];
  let usages: Array<unknown> = [];
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound") continue;
    const frame = entry.frame;
    if (
      field(frame, "type") === "message_end" &&
      field(field(frame, "message"), "role") === "assistant" &&
      count(field(field(frame, "message"), "usage"), "totalTokens") > 0
    ) {
      usages.push(field(field(frame, "message"), "usage"));
    }
    if (field(frame, "type") === "response" && field(frame, "command") === "get_session_stats") {
      segments.push({ stats: field(frame, "data"), usages });
      usages = [];
    }
  }
  const turns = projectionFor(result, transcript.scenario).providerTurns;
  assert.lengthOf(turns, segments.length);
  for (const [index, turn] of turns.entries()) {
    const { stats, usages: turnUsages } = segments[index]!;
    const contextUsage = field(stats, "contextUsage");
    const last = turnUsages.at(-1);
    assert.isDefined(last, "each recorded Pi turn must report message usage");
    const input = (usage: unknown) =>
      count(usage, "input") + count(usage, "cacheRead") + count(usage, "cacheWrite");
    const { updatedAt: _updatedAt, ...tokenUsage } = turn.tokenUsage ?? { updatedAt: "" };
    assert.deepEqual(tokenUsage, {
      usedTokens: count(last, "totalTokens"),
      maxTokens: field(contextUsage, "contextWindow"),
      inputTokens: input(last),
      cachedInputTokens: count(last, "cacheRead"),
      outputTokens: count(last, "output"),
      ...(field(last, "reasoning") === undefined
        ? {}
        : { reasoningOutputTokens: count(last, "reasoning") }),
      costUsd: field(stats, "cost"),
    });
    const sum = (read: (usage: unknown) => number) =>
      turnUsages.reduce<number>((total, usage) => total + read(usage), 0);
    assert.deepInclude(turn.turnTokenUsage, {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: sum(input),
      cachedInputTokens: sum((usage) => count(usage, "cacheRead")),
      cacheCreationTokens: sum((usage) => count(usage, "cacheWrite")),
      outputTokens: sum((usage) => count(usage, "output")),
    });
  }
}

/**
 * Pi-specific additions to the shared simple contract: the streamed thinking
 * block becomes a reasoning item, the settled turn carries its last message's
 * real context usage, and the turn's native ref is the session-tree id
 * of its user message (the point rollback and fork re-root at).
 */
export function assertPiSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleOutput(result, transcript);
  const projection = projectionFor(result, transcript.scenario);

  const recordedThinking = transcript.entries.flatMap((entry) => {
    const update = field(
      entry.type === "emit_inbound" ? entry.frame : undefined,
      "assistantMessageEvent",
    );
    return field(update, "type") === "thinking_end" ? [field(update, "content")] : [];
  });
  assert.lengthOf(recordedThinking, 1, "the recording must stream one thinking block");
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "reasoning" ? [item.text] : [])),
    recordedThinking,
    "Pi thinking deltas must project as one reasoning item with the recorded text",
  );

  assertPiSettledTokenUsage(result, transcript);
  const [turn] = projection.providerTurns;

  // Pi streams cumulative usage, initially zeros until the provider reports.
  const streamedTotals = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && field(entry.frame, "type") === "message_update"
      ? [field(field(entry.frame, "usage"), "totalTokens")]
      : [],
  );
  const liveUsage = result.domainEvents.flatMap((event) =>
    event.type === "provider-turn.updated" &&
    event.payload.status === "running" &&
    event.payload.tokenUsage !== undefined
      ? [event.payload.tokenUsage.usedTokens]
      : [],
  );
  assert.deepEqual(liveUsage, [...new Set(streamedTotals.filter((total) => total !== 0))]);

  const entries = field(lastPiResponseData(transcript, "get_entries"), "entries");
  const userEntryId = (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) =>
        field(entry, "type") === "message" && field(field(entry, "message"), "role") === "user",
    )
    .map((entry) => field(entry, "id"))
    .at(0);
  assert.isString(userEntryId);
  assert.equal(turn?.nativeTurnRef?.nativeId, userEntryId);
  assert.equal(turn?.nativeTurnRef?.strength, "strong");
}
