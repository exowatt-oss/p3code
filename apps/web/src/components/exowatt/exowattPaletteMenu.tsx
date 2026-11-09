import { CircleEllipsisIcon, InfoIcon } from "lucide-react";

import { APP_GIT_SHA, APP_VERSION, IS_DEV_BUILD } from "../../branding";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatExowattVersionLabel } from "./ExowattVersionLabel";

export const EXOWATT_PALETTE_MENU_VALUE = "action:exowatt-menu";
export const EXOWATT_PALETTE_MENU_GROUP = "exowatt-go-to";
export const EXOWATT_PALETTE_MENU_TITLE = "P3 Code";
const EXOWATT_ABOUT_VALUE = "action:exowatt-about";

// Everything the sidebar footer used to hold, grouped like a settings page. The items are the
// palette's own root actions, so a shortcut or a search finds the same command either way.
const EXOWATT_MENU_SECTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}> = [
  {
    value: EXOWATT_PALETTE_MENU_GROUP,
    label: "Go to",
    items: ["action:settings", "action:usage", "action:pull-requests", "action:exowatt-changelog"],
  },
  {
    value: "exowatt-this-thread",
    label: "This thread",
    items: [
      "action:open-thread-pull-requests",
      "action:copy-thread-reference",
      "action:link-pull-request",
    ],
  },
  { value: "exowatt-about", label: "About", items: [EXOWATT_ABOUT_VALUE, "action:exowatt-logs"] },
];

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export function makeExowattAboutItem(): CommandPaletteActionItem {
  const version = formatExowattVersionLabel(APP_VERSION, IS_DEV_BUILD, APP_GIT_SHA);
  return {
    kind: "action",
    value: EXOWATT_ABOUT_VALUE,
    searchTerms: ["about", "version", "build", "p3 code", "t3 code", "release"],
    title: "About P3 Code",
    description: version.compactLabel,
    icon: <InfoIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      try {
        if (!(await writeTextToClipboard(version.copyText, "P3 Code version information"))) return;
        toastManager.add({
          type: "success",
          title: "Copied version",
          description: version.copyText,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not copy the version",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
  };
}

export function buildExowattPaletteMenu(
  actionItems: ReadonlyArray<PaletteItem>,
): CommandPaletteSubmenuItem {
  const byValue = new Map(actionItems.map((item) => [item.value, item]));
  const groups: CommandPaletteGroup[] = EXOWATT_MENU_SECTIONS.flatMap((section) => {
    const items = section.items.flatMap((value) => {
      const item = byValue.get(value);
      return item ? [item] : [];
    });
    return items.length > 0 ? [{ value: section.value, label: section.label, items }] : [];
  });
  return {
    kind: "submenu",
    value: EXOWATT_PALETTE_MENU_VALUE,
    searchTerms: [
      "p3",
      "p3 code",
      "menu",
      "settings",
      "usage",
      "pull requests",
      "what's new",
      "version",
      "about",
      "logs",
    ],
    title: EXOWATT_PALETTE_MENU_TITLE,
    description: "Settings, usage, pull requests, what's new and version",
    icon: <CircleEllipsisIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <CircleEllipsisIcon className={ADDON_ICON_CLASS} />,
    groups,
  };
}
