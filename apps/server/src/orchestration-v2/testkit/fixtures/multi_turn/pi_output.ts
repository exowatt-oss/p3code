import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertPiSettledTokenUsage } from "../simple/pi_output.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

/**
 * The second turn's settled usage is its own last message usage, not the
 * session-wide totals `get_session_stats` reports alongside it.
 */
export function assertPiMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assertPiSettledTokenUsage(result, transcript);
}
