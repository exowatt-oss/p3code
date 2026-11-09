import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { buildExowattPaletteMenu, EXOWATT_PALETTE_MENU_GROUP } from "./exowattPaletteMenu";

const action = (value: string): CommandPaletteActionItem => ({
  kind: "action",
  value,
  searchTerms: [],
  title: value,
  icon: null,
  run: async () => {},
});

describe("buildExowattPaletteMenu", () => {
  it("groups the footer's utilities from the palette's own actions, in menu order", () => {
    const menu = buildExowattPaletteMenu([
      action("action:exowatt-logs"),
      action("action:usage"),
      action("action:settings"),
      action("action:exowatt-changelog"),
      action("action:exowatt-about"),
      action("action:new-thread"),
    ]);

    expect(menu.groups.map((group) => group.value)).toEqual([
      EXOWATT_PALETTE_MENU_GROUP,
      "exowatt-about",
    ]);
    expect(menu.groups[0]!.items.map((item) => item.value)).toEqual([
      "action:settings",
      "action:usage",
      "action:exowatt-changelog",
    ]);
    expect(menu.groups[1]!.items.map((item) => item.value)).toEqual([
      "action:exowatt-about",
      "action:exowatt-logs",
    ]);
  });

  it("shows the thread group only when the active thread offers its pull request actions", () => {
    const menu = buildExowattPaletteMenu([
      action("action:settings"),
      action("action:copy-thread-reference"),
      action("action:open-thread-pull-requests"),
    ]);

    expect(menu.groups.find((group) => group.value === "exowatt-this-thread")?.items).toEqual([
      expect.objectContaining({ value: "action:open-thread-pull-requests" }),
      expect.objectContaining({ value: "action:copy-thread-reference" }),
    ]);
  });
});
