import { Schema } from "effect";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const EXPANDED_SUBAGENTS_KEY = "t3code:sidebar:exowatt-subagent-disclosure:v1";
const EMPTY: Readonly<Record<string, boolean>> = {};
const DisclosureSchema = Schema.Record(Schema.String, Schema.Boolean);

/**
 * Device-local disclosure state for parents with nested subagents. Rows the
 * user never toggled follow their fallback (the `exowatt.sidebarNestDispatched`
 * setting, or expanded while one of the children is open); a toggle stores an
 * explicit choice for that parent, which then wins over the fallback.
 */
export function useExowattSidebarSubagentDisclosure(): {
  readonly isExpanded: (parentKey: string, fallback: boolean) => boolean;
  readonly setExpanded: (parentKey: string, expanded: boolean) => void;
} {
  const [overrides, setOverrides] = useLocalStorage(
    EXPANDED_SUBAGENTS_KEY,
    EMPTY,
    DisclosureSchema,
  );
  return {
    isExpanded: (parentKey: string, fallback: boolean) => overrides[parentKey] ?? fallback,
    setExpanded: (parentKey: string, expanded: boolean) =>
      setOverrides((current) =>
        current[parentKey] === expanded ? current : { ...current, [parentKey]: expanded },
      ),
  };
}
