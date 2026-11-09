import type { KeybindingRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "./keybindings.ts";

/**
 * Every default shortcut shipped by upstream t3code v0.0.37
 * (packages/shared/src/keybindings.ts at that tag). P3 may add shortcuts, but
 * it must never rebind, retire, or shadow one of these: users coming from
 * upstream keep their muscle memory, and rebases stay conflict-free.
 */
const UPSTREAM_V0_0_37_DEFAULTS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  ...Array.from({ length: 9 }, (_, index) => ({
    key: `mod+${index + 1}`,
    command: `thread.jump.${index + 1}` as KeybindingRule["command"],
    // Upstream scoped numbered jumps to the desktop app in v0.0.43, and to "model picker
    // closed" by v0.1.1 so they no longer overlap its jumps.
    when: "!modelPickerOpen && isDesktop",
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    key: `mod+${index + 1}`,
    command: `modelPicker.jump.${index + 1}` as KeybindingRule["command"],
    when: "modelPickerOpen && isDesktop",
  })),
];

/** Upstream contexts that can both be true for one keydown outside the terminal. */
const OVERLAPPING_CONTEXTS: ReadonlyArray<ReadonlySet<string | undefined>> = [
  new Set([undefined, "!terminalFocus", "previewFocus", "modelPickerOpen"]),
  new Set([undefined, "terminalFocus"]),
];

function shortcutId(rule: KeybindingRule): string {
  const shortcut = parseKeybindingShortcut(rule.key);
  expect(shortcut, `unparseable default shortcut ${rule.key}`).not.toBeNull();
  const { key, modKey, metaKey, ctrlKey, shiftKey, altKey } = shortcut!;
  return [key, modKey, metaKey, ctrlKey, shiftKey, altKey].join("|");
}

function isSameRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.key === right.key &&
    left.command === right.command &&
    (left.when ?? "") === (right.when ?? "")
  );
}

describe("P3 default keybindings preserve upstream", () => {
  it("keeps every upstream v0.0.37 default shortcut exactly", () => {
    const missing = UPSTREAM_V0_0_37_DEFAULTS.filter(
      (upstream) => !DEFAULT_KEYBINDINGS.some((rule) => isSameRule(rule, upstream)),
    );
    expect(missing).toEqual([]);
  });

  it("never binds a P3 shortcut to a key an upstream default already uses in the same context", () => {
    const p3Additions = DEFAULT_KEYBINDINGS.filter(
      (rule) => !UPSTREAM_V0_0_37_DEFAULTS.some((upstream) => isSameRule(rule, upstream)),
    );
    expect(p3Additions.length).toBeGreaterThan(0);

    const collisions = p3Additions.flatMap((added) =>
      UPSTREAM_V0_0_37_DEFAULTS.filter(
        (upstream) =>
          shortcutId(upstream) === shortcutId(added) &&
          OVERLAPPING_CONTEXTS.some(
            (contexts) => contexts.has(upstream.when) && contexts.has(added.when),
          ),
      ).map((upstream) => ({ added, upstream })),
    );
    expect(collisions).toEqual([]);
  });
});
