/**
 * "Jump to source" for Hub rows. The transcript is virtualized and groups tool calls under the
 * first call's id, so try the item's row, then its work group, then the turn's user message, and
 * report false when none is mounted so the caller can say so.
 */
export function transcriptRowElement(rowId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const id = CSS.escape(rowId);
  return document.querySelector<HTMLElement>(
    [
      `[data-timeline-row-id="${id}"]`,
      `[data-timeline-row-id="work-group:${id}"]`,
      `[data-timeline-row-id="work-live:${id}"]`,
      `[data-timeline-row-id="work-toggle:${id}"]`,
      `[data-message-id="${id}"]`,
    ].join(","),
  );
}

function flash(element: HTMLElement) {
  element.scrollIntoView({ block: "center" });
  // Brief, one-shot highlight: no repeating animation, so idle GPU stays idle.
  element.animate?.([{ backgroundColor: "var(--accent)" }, { backgroundColor: "transparent" }], {
    duration: 700,
    easing: "ease-out",
  });
}

export function jumpToTranscriptRow(
  rowId: string | null | undefined,
  fallbackRowIds: ReadonlyArray<string | null | undefined> = [],
): boolean {
  for (const candidate of [rowId, ...fallbackRowIds]) {
    if (!candidate) continue;
    const element = transcriptRowElement(candidate);
    if (element) {
      flash(element);
      return true;
    }
  }
  return false;
}
