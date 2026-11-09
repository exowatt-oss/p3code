import { type ExowattThreadIcon, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export type ExowattThreadIconMap = ReadonlyMap<ThreadId, ExowattThreadIcon>;

/**
 * Exowatt: every thread's Font Awesome icon in one environment. The server
 * sends a snapshot, then upserts and removals; this folds them into a map so
 * a sidebar row reads its icon by thread id. A reconnect starts from a fresh
 * snapshot, which replaces the map.
 */
export function createExowattThreadIconsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    icons: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:thread-icons",
      tag: WS_METHODS.exowattThreadIconsSubscribe,
      // The sidebar stays mounted; keep the map across brief unmounts.
      idleTtlMs: 60_000,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(
            (): ExowattThreadIconMap => new Map(),
            (current, event) => {
              if (event.type === "snapshot") {
                return new Map(event.icons.map((icon) => [icon.threadId, icon]));
              }
              const next = new Map(current);
              if (event.type === "upsert") {
                for (const icon of event.icons) next.set(icon.threadId, icon);
              } else {
                for (const threadId of event.threadIds) next.delete(threadId);
              }
              return next;
            },
          ),
          // `scan` emits its seed first; wait for the snapshot instead.
          Stream.drop(1),
        ),
    }),
  };
}
