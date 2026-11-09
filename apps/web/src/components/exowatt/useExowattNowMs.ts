import { useSyncExternalStore } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";

const subscribeToNothing = () => () => {};
// Whole seconds, rounded up: stable between back-to-back reads, as
// useSyncExternalStore requires, and never earlier than a timestamp written
// just before the render.
const readNowCeilSecond = () => Math.ceil(Date.now() / 1000) * 1000;

/**
 * Wall-clock milliseconds, re-read on every render and at least once a minute.
 * Reading it through a hook keeps the React Compiler from caching a
 * `Date.now()` on the component's other inputs alone.
 */
export function useExowattNowMs(): number {
  useNowMinute();
  return useSyncExternalStore(subscribeToNothing, readNowCeilSecond, readNowCeilSecond);
}
