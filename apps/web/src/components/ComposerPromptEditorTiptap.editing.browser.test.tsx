import { useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { listContinuationForEnter } from "../composer-list-continuation";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

let editor: ComposerPromptEditorHandle | null;

// Mirrors ChatComposer: its command-key handler continues plain Markdown list markers on Enter
// (composerCommandKey.ts) and leaves real list and task items to the editor.
function ComposerProbe({ initial, richText }: { initial: string; richText: boolean }) {
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const ref = useRef<ComposerPromptEditorHandle>(null);
  useLayoutEffect(() => {
    editor = ref.current;
  });
  useLayoutEffect(() => {
    if (focusRequest !== null) ref.current?.focusAt(focusRequest);
  }, [focusRequest]);
  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      richTextEnabled={richText}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onPaste={() => {}}
      editorRef={ref}
      onChange={(next, nextCursor) => {
        setValue(next);
        setCursor(nextCursor);
      }}
      onCommandKeyDown={(key, event, isListItem = false) => {
        if (key !== "Enter" || isListItem || event.isComposing) return false;
        const selection = ref.current?.readSelectionRange();
        const snapshot = ref.current?.readSnapshot();
        if (!selection || !snapshot || selection.start !== selection.end) return false;
        const edit = listContinuationForEnter(snapshot.value, selection.start);
        if (!edit) return false;
        setValue(
          snapshot.value.slice(0, edit.start) + edit.replacement + snapshot.value.slice(edit.end),
        );
        setCursor(edit.cursorAfter);
        setFocusRequest(edit.cursorAfter);
        return true;
      }}
    />
  );
}

async function pressShiftEnter(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLElement>("[data-testid=composer-editor]")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function expectSnapshot(value: string, expandedCursor: number) {
  await vi.waitFor(() => {
    expect(editor!.readSnapshot().value).toBe(value);
    expect(editor!.readSnapshot().expandedCursor).toBe(expandedCursor);
  });
}

describe("composer dictation selection", () => {
  it("reports the selected text range instead of collapsing it to the caret", async () => {
    await using screen = await render(
      <ComposerProbe initial="replace target now" richText={false} />,
    );
    await act(() => editor!.focusAt(8));
    const paragraph = screen.container.querySelector('[data-testid="composer-editor"] p')!;
    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, 8);
    range.setEnd(text, 14);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));

    expect(editor!.readSnapshot().value).toBe("replace target now");
    expect(editor!.readSelectionRange()).toEqual({ start: 8, end: 14 });
  });
});

describe("composer list continuation before trailing paragraph", () => {
  it.each([
    { richText: true, separator: "\n" },
    { richText: true, separator: "\n\n" },
    { richText: false, separator: "\n" },
    { richText: false, separator: "\n\n" },
  ])(
    "keeps a new item before the following paragraph (rich: $richText, separator: $separator)",
    async ({ richText, separator }) => {
      const before = "- first\n- last";
      const initial = `${before}${separator}following paragraph`;
      await using screen = await render(<ComposerProbe initial={initial} richText={richText} />);
      await act(() => editor!.focusAt(before.length));
      await pressShiftEnter(screen.container);
      await expectSnapshot(`${before}\n- ${separator}following paragraph`, `${before}\n- `.length);
      // Plain mode keeps the marker as paragraph text; rich mode renders upstream's
      // real list item, so only the serialized value and cursor are comparable there.
      if (!richText) {
        const anchor = window.getSelection()?.anchorNode;
        expect(anchor?.parentElement?.closest("p")?.textContent).toBe("- ");
      }
      await pressShiftEnter(screen.container);
      await expectSnapshot(`${before}\n${separator}following paragraph`, `${before}\n`.length);
    },
  );

  it("renumbers the following items when continuing a plain numbered list", async () => {
    const initial = "1. first\n2. second\nfollowing paragraph";
    await using screen = await render(<ComposerProbe initial={initial} richText={false} />);
    await act(() => editor!.focusAt("1. first".length));
    await pressShiftEnter(screen.container);
    await expectSnapshot("1. first\n2. \n3. second\nfollowing paragraph", "1. first\n2. ".length);
  });

  it("continues after marked text without formatting the next marker", async () => {
    const initial = "- **last**\nfollowing paragraph";
    await using screen = await render(<ComposerProbe initial={initial} richText />);
    await act(() => editor!.focusAt(initial.indexOf("\nfollowing")));
    await pressShiftEnter(screen.container);
    await expectSnapshot("- **last**\n- \nfollowing paragraph", "- **last**\n- ".length);
  });

  it("continues a task item before trailing text and exits on empty", async () => {
    const initial = "- [ ] first\n- [ ] last\n\nfollowing paragraph";
    await using screen = await render(<ComposerProbe initial={initial} richText />);
    await act(() => editor!.focusAt(initial.indexOf("\n\nfollowing")));
    await pressShiftEnter(screen.container);
    await expectSnapshot(
      "- [ ] first\n- [ ] last\n- [ ] \n\nfollowing paragraph",
      "- [ ] first\n- [ ] last\n- [ ] ".length,
    );
    await pressShiftEnter(screen.container);
    await vi.waitFor(() =>
      expect(editor!.readSnapshot().value).toBe(
        initial.replace("\n\nfollowing", "\n\n\nfollowing"),
      ),
    );
  });

  it("splits an item at the caret without moving the rest of the item", async () => {
    const initial = "- first\nfollowing paragraph";
    await using screen = await render(<ComposerProbe initial={initial} richText />);
    await act(() => editor!.focusAt("- fi".length));
    await pressShiftEnter(screen.container);
    await expectSnapshot("- fi\n- rst\nfollowing paragraph", "- fi\n- ".length);
  });

  it("continues an item in the middle without displacing later items", async () => {
    const initial = "- first\n- middle\n- last\nfollowing paragraph";
    await using screen = await render(<ComposerProbe initial={initial} richText />);
    await act(() => editor!.focusAt(initial.indexOf("\n- last")));
    await pressShiftEnter(screen.container);
    await expectSnapshot(
      "- first\n- middle\n- \n- last\nfollowing paragraph",
      "- first\n- middle\n- ".length,
    );
  });
});
