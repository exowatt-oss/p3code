/**
 * The Hub overlay (pins, hides, manual entries) from the server's `ExowattThreadHubStore`, laid
 * over `deriveHubArtifacts` rows by the same `kind` + `key`. A pinned item whose turn items are
 * not loaded is rebuilt from its key so the pin survives unloaded history.
 */
import type {
  ExowattThreadHubEntry,
  ExowattThreadHubManual,
  ExowattThreadHubUpsertInput,
  ThreadId,
} from "@t3tools/contracts";

import {
  hubArtifactBasename,
  hubArtifactKey,
  hubNormalizePath,
  hubNormalizeUrl,
  hubRefFromIdentity,
  hubUrlLabel,
  type HubArtifact,
  type HubArtifactKind,
  type HubArtifactRef,
} from "./hubArtifacts";

export interface HubOverlayResult {
  /** Rows to show, with `pinned` set from the overlay. */
  readonly visible: readonly HubArtifact[];
  /** Rows the user hid, for "Show N hidden". */
  readonly hidden: readonly HubArtifact[];
}

const MAX_NOTE_TITLE_CHARS = 80;
/** The contract's caps (`exowattThreadHub.ts`). */
const MAX_TITLE_CHARS = 200;
export const MAX_HUB_NOTE_CHARS = 4000;

function clampTitle(title: string): string {
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function manualRef(entry: ExowattThreadHubEntry, manual: ExowattThreadHubManual): HubArtifactRef {
  return {
    kind: entry.kind,
    key: entry.key,
    label: manual.title,
    ...(manual.path ? { path: manual.path } : {}),
    ...(manual.url ? { url: manual.url } : {}),
  };
}

function overlayRow(
  ref: HubArtifactRef,
  entry: ExowattThreadHubEntry,
  manual: ExowattThreadHubManual | null,
): HubArtifact {
  return {
    ...ref,
    count: 0,
    firstSeenAt: entry.createdAt,
    lastSeenAt: entry.createdAt,
    lastItemId: null,
    lastRunId: null,
    runIds: [],
    pinned: entry.pinned,
    ...(manual ? { manual: true } : {}),
    ...(manual?.note ? { note: manual.note } : {}),
  };
}

export function applyHubOverlay(
  derived: readonly HubArtifact[],
  entries: readonly ExowattThreadHubEntry[],
): HubOverlayResult {
  if (entries.length === 0) return { visible: derived, hidden: [] };
  const byKey = new Map(entries.map((entry) => [hubArtifactKey(entry), entry] as const));
  const visible: HubArtifact[] = [];
  const hidden: HubArtifact[] = [];
  const matched = new Set<string>();

  for (const artifact of derived) {
    const key = hubArtifactKey(artifact);
    const entry = byKey.get(key);
    if (entry === undefined) {
      visible.push(artifact);
      continue;
    }
    matched.add(key);
    // A hand-added item the agent also produced is one row: the derived data
    // (count, jump target) with the name the user gave it.
    const row: HubArtifact = {
      ...artifact,
      pinned: entry.pinned,
      ...(entry.manual
        ? {
            label: entry.manual.title,
            manual: true,
            ...(entry.manual.note ? { note: entry.manual.note } : {}),
          }
        : {}),
    };
    (entry.hidden ? hidden : visible).push(row);
  }

  for (const entry of entries) {
    if (matched.has(hubArtifactKey(entry))) continue;
    if (entry.manual) {
      const row = overlayRow(manualRef(entry, entry.manual), entry, entry.manual);
      (entry.hidden ? hidden : visible).push(row);
      continue;
    }
    // A hidden item with nothing loaded has nothing to hide; a pinned one is
    // drawn from its key when the key carries enough to draw it.
    if (!entry.pinned || entry.hidden) continue;
    const ref = hubRefFromIdentity(entry.kind, entry.key);
    if (ref) visible.push(overlayRow(ref, entry, null));
  }
  return { visible, hidden };
}

// ── Manual add ──────────────────────────────────────────────────────────

export type HubSectionId = "outputs" | "sources";
export type HubManualType = "link" | "file" | "note";

const PATH_SHAPE = /^(?:~|\.{1,2})?[\\/]|[\\/]|^[^\s]+\.[A-Za-z0-9]{1,10}$/u;

/** What a typed value most likely is: an http(s) URL, a path, or free text. */
export function inferHubManualType(value: string): HubManualType {
  const trimmed = value.trim();
  if (hubNormalizeUrl(trimmed)) return "link";
  // Another scheme (ftp://, slack://) is not a path the Hub can open either.
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)) return "note";
  if (!/\s/u.test(trimmed) && PATH_SHAPE.test(trimmed)) return "file";
  return "note";
}

const MANUAL_KIND: Record<HubSectionId, Record<HubManualType, HubArtifactKind>> = {
  outputs: { link: "link-output", file: "file-output", note: "note-output" },
  sources: { link: "url-fetch", file: "file-read", note: "note-source" },
};

function noteTitle(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? text;
  return firstLine.length <= MAX_NOTE_TITLE_CHARS
    ? firstLine
    : `${firstLine.slice(0, MAX_NOTE_TITLE_CHARS - 1)}…`;
}

/**
 * The upsert that adds a typed value to a section, or null when the value is
 * not what `type` says (a "link" that is not an http(s) URL). Links and files
 * get the same key the derivation would give them, so an item the agent later
 * touches stays one row; notes get a fresh id.
 */
export function hubManualUpsert(input: {
  readonly threadId: ThreadId;
  readonly section: HubSectionId;
  readonly type: HubManualType;
  readonly value: string;
  readonly newId: () => string;
}): ExowattThreadHubUpsertInput | null {
  const value = input.value.trim();
  if (value.length === 0 || value.length > MAX_HUB_NOTE_CHARS) return null;
  const kind = MANUAL_KIND[input.section][input.type];
  switch (input.type) {
    case "link": {
      const url = hubNormalizeUrl(value);
      if (!url) return null;
      return {
        threadId: input.threadId,
        kind,
        key: url,
        manual: { title: clampTitle(hubUrlLabel(url)), url },
      };
    }
    case "file": {
      const path = hubNormalizePath(value);
      if (!path) return null;
      return {
        threadId: input.threadId,
        kind,
        key: path,
        manual: { title: clampTitle(hubArtifactBasename(path) || path), path },
      };
    }
    case "note":
      return {
        threadId: input.threadId,
        kind,
        key: `note:${input.newId()}`,
        manual: { title: noteTitle(value), note: value },
      };
  }
}
