import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ExowattSidebarRelationshipChip } from "./ExowattSidebarRelationshipChip";
import type { ExowattSidebarOrigin } from "./exowattSidebarProvenance";

const origin = {
  environmentId: EnvironmentId.make("remote"),
  id: ThreadId.make("parent"),
  title: "The parent thread",
};

// The parent stands in for the sidebar row, which must never see the chip's events.
function chipInRow(
  originOverride: ExowattSidebarOrigin | undefined,
  handlers: {
    readonly onNavigate: () => void;
    readonly onRowClick: () => void;
    readonly onRowKeyDown: () => void;
  },
) {
  return (
    <div role="presentation" onClick={handlers.onRowClick} onKeyDown={handlers.onRowKeyDown}>
      <ExowattSidebarRelationshipChip origin={originOverride} onNavigate={handlers.onNavigate} />
    </div>
  );
}

function handlers() {
  return { onNavigate: vi.fn(), onRowClick: vi.fn(), onRowKeyDown: vi.fn() };
}

async function click(element: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  await act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

describe("ExowattSidebarRelationshipChip", () => {
  it("keeps the inline label bounded and navigates to the origin without selecting the row", async () => {
    const spies = handlers();
    await using screen = await render(chipInRow(origin, spies));
    const link = screen.container.querySelector("a")!;
    expect(link.className).toContain("max-w-32");
    expect(link.getAttribute("href")).toBe("/remote/parent");
    expect(link.textContent).toContain("The parent thread");

    const event = await click(link);
    expect(event.defaultPrevented).toBe(true);
    expect(spies.onRowClick).not.toHaveBeenCalled();
    expect(spies.onNavigate).toHaveBeenCalledWith({ environmentId: "remote", threadId: "parent" });

    await act(() => {
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(spies.onRowKeyDown).not.toHaveBeenCalled();
  });

  it("preserves modified links for opening in a new tab", async () => {
    const spies = handlers();
    await using screen = await render(chipInRow(origin, spies));
    const link = screen.container.querySelector("a")!;
    // Keep the browser on the test page whatever the modifier would open.
    link.addEventListener("click", (event) => event.preventDefault());
    const event = await click(link, { metaKey: true });
    expect(spies.onNavigate).not.toHaveBeenCalled();
    expect(spies.onRowClick).not.toHaveBeenCalled();
    expect(event.metaKey).toBe(true);
  });

  it("does not offer a broken link for an unavailable origin", async () => {
    await using screen = await render(chipInRow({ ...origin, title: null }, handlers()));
    expect(screen.container.querySelector("a")).toBeNull();
    expect(screen.container.textContent).toContain("another thread");
  });

  it("does not render a chip without lineage", async () => {
    await using screen = await render(chipInRow(undefined, handlers()));
    expect(screen.container.querySelector("[data-exowatt-relationship-chip]")).toBeNull();
    expect(screen.container.textContent).toBe("");
  });
});
