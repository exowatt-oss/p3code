/**
 * The Hub's inline "Add" form: one field that takes a link, a file path or a
 * note, with the type guessed from what was typed and a toggle to correct it.
 */
import { FileTextIcon, LinkIcon, StickyNoteIcon } from "lucide-react";
import { useState } from "react";

import {
  inferHubManualType,
  MAX_HUB_NOTE_CHARS,
  type HubManualType,
  type HubSectionId,
} from "~/lib/hubOverlay";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

const PLACEHOLDER: Record<HubSectionId, string> = {
  outputs: "Link, file path or note this thread produced",
  sources: "Link, file path or note this thread drew on",
};

const INVALID: Record<HubManualType, string> = {
  link: "Enter an http(s) link.",
  file: "Enter a file path.",
  note: "Enter a note.",
};

export function HubAddForm({
  section,
  onSubmit,
  onCancel,
}: {
  section: HubSectionId;
  /** Resolves to null once added, or the reason it was not. */
  onSubmit: (type: HubManualType, value: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<HubManualType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const type = override ?? inferHubManualType(value);

  const submit = async () => {
    if (busy) return;
    if (value.trim().length === 0) {
      setError(INVALID[type]);
      return;
    }
    setBusy(true);
    const failure = await onSubmit(type, value);
    setBusy(false);
    if (failure === null) {
      setValue("");
      setOverride(null);
      setError(null);
      onCancel();
    } else {
      setError(failure);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        aria-label={section === "outputs" ? "Add output" : "Add source"}
        autoFocus
        maxLength={MAX_HUB_NOTE_CHARS}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={PLACEHOLDER[section]}
        size="sm"
        value={value}
      />
      <div className="flex items-center gap-1.5">
        <ToggleGroup
          aria-label="Type"
          onValueChange={(next) => {
            const picked = next[0];
            if (picked === "link" || picked === "file" || picked === "note") setOverride(picked);
            setError(null);
          }}
          value={[type]}
          variant="segmented"
        >
          <Toggle aria-label="Link" value="link">
            <LinkIcon className="size-3" />
            <span className="pr-0.5 text-2xs">Link</span>
          </Toggle>
          <Toggle aria-label="File" value="file">
            <FileTextIcon className="size-3" />
            <span className="pr-0.5 text-2xs">File</span>
          </Toggle>
          <Toggle aria-label="Note" value="note">
            <StickyNoteIcon className="size-3" />
            <span className="pr-0.5 text-2xs">Note</span>
          </Toggle>
        </ToggleGroup>
        <span className="flex-1" />
        <Button onClick={onCancel} size="micro" type="button" variant="ghost-muted">
          Cancel
        </Button>
        <Button disabled={busy} size="micro" type="submit">
          Add
        </Button>
      </div>
      {error ? <p className="px-1 text-2xs text-destructive-foreground">{error}</p> : null}
    </form>
  );
}

export { INVALID as HUB_ADD_INVALID_MESSAGE };
