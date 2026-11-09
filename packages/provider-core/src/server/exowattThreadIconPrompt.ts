/**
 * exowatt: the prompt and output schema for picking a thread's Font Awesome
 * icon. The schema is an enum of `EXOWATT_THREAD_ICON_NAMES`, so a provider
 * with structured output can only answer with an icon the client draws.
 */
import { EXOWATT_THREAD_ICON_NAMES, ExowattThreadIconName } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { limitSection } from "./textGenerationUtils.ts";

export interface ThreadIconPromptInput {
  readonly title: string;
  readonly context?: string | undefined;
}

export function buildThreadIconPrompt(input: ThreadIconPromptInput) {
  const context = input.context?.trim();
  const prompt = [
    "You pick one icon that best represents a coding-agent thread, shown at 14px in a sidebar.",
    "Choose by what the work is about (its subject), not by generic words like 'task' or 'help'.",
    "Answer with exactly one name from this list:",
    EXOWATT_THREAD_ICON_NAMES.join(", "),
    "",
    `Thread title: ${limitSection(input.title, 300)}`,
    ...(context ? ["", "Opening request:", limitSection(context, 2_000)] : []),
  ].join("\n");
  const outputSchema = Schema.Struct({ icon: ExowattThreadIconName });
  return { prompt, outputSchema };
}
