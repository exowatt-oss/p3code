import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ExowattSidebarChildList } from "./ExowattSidebarChildThreads";
import { makeExowattSidebarThread as makeThread } from "./exowattSidebarTestFixtures";
import type { ExowattSidebarOrigin } from "./exowattSidebarProvenance";

describe("ExowattSidebarChildList", () => {
  it("links a flattened grandchild to its actual parent, without a chip on the direct child", async () => {
    const root = makeThread({ id: "root" });
    const middle = makeThread({ id: "middle" });
    const grandchild = makeThread({ id: "grandchild" });
    const originByKey = new Map<string, ExowattSidebarOrigin>([
      [
        "local:grandchild",
        { environmentId: root.environmentId, id: middle.id, title: middle.title },
      ],
    ]);
    const onOpenChild = vi.fn();
    const onParentRowClick = vi.fn();
    await using screen = await render(
      <div role="presentation" onClick={onParentRowClick}>
        <ExowattSidebarChildList
          nesting={{
            children: [middle, grandchild],
            originByKey,
            summary: { count: 2, running: 0, needsUser: 0, latestActivityMs: 0 },
            expanded: true,
            activeChildKey: null,
            onToggle: vi.fn(),
          }}
          onOpenChild={onOpenChild}
        />
      </div>,
    );

    const rows = screen.container.querySelectorAll('[data-testid="exowatt-sidebar-subagent-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll("a")).toHaveLength(0);
    const link = rows[1]!.querySelector("a")!;
    expect(link.getAttribute("aria-label")).toBe("Open origin thread: middle");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(() => {
      link.dispatchEvent(event);
    });
    expect(onOpenChild).toHaveBeenCalledOnce();
    expect(onOpenChild).toHaveBeenCalledWith({
      environmentId: root.environmentId,
      threadId: middle.id,
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onParentRowClick).not.toHaveBeenCalled();
  });
});
