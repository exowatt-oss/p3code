/**
 * One Hub output or source row: the icon, the primary action, the kind's trailing action and
 * the overlay's pin / hide / remove controls when the server offers them. Every list in the
 * panel renders through here so a row looks and acts the same wherever it is.
 */
import {
  CodeIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  LinkIcon,
  MonitorPlayIcon,
  PaperclipIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SparklesIcon,
  StickyNoteIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  hubArtifactBasename,
  hubArtifactHostname,
  hubDisplayPath,
  hubFileGroupId,
  hubWorkspaceRelativePath,
  type HubArtifact,
  type HubPathRoots,
} from "~/lib/hubArtifacts";
import { FaviconImage } from "~/components/preview/PreviewFaviconIcon";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";

import { HubIconAction, HubRow } from "./HubPrimitives";

/** Overlay controls a row shows; an absent handler hides its button. */
export interface HubRowOverlayActions {
  readonly onTogglePin?: (() => void) | undefined;
  readonly onHide?: (() => void) | undefined;
  readonly onUnhide?: (() => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
}

export interface HubArtifactRowProps {
  artifact: HubArtifact;
  pathRoots: HubPathRoots;
  onOpenFile: (relativePath: string) => void;
  openUrl: (url: string | undefined) => void;
  copyText: (value: string, what: string) => void;
  onJump?: (() => void) | undefined;
  overlay?: HubRowOverlayActions | undefined;
  dimmed?: boolean | undefined;
}

function LinkFavicon({ url }: { url: string | undefined }) {
  return (
    <FaviconImage
      className="size-3.5 shrink-0 rounded-sm object-contain"
      fallback={<GlobeIcon className="size-3.5 shrink-0" />}
      sources={[faviconUrlForOrigin(url ?? null, 32)]}
    />
  );
}

/**
 * Containing folder of a display path ("src" for "apps/web/src/a.ts"), or null
 * for a bare name. The row label is the basename and the tooltip has the full
 * path, so the secondary column only needs enough to tell two README.md apart.
 */
function hubParentFolder(display: string): string | null {
  const segments = display.split("/").filter((segment) => segment.length > 0);
  return segments.length < 2 ? null : (segments.at(-2) ?? null);
}

function overlayButtons(artifact: HubArtifact, overlay: HubRowOverlayActions | undefined) {
  if (!overlay) return null;
  return (
    <>
      {overlay.onTogglePin ? (
        <HubIconAction label={artifact.pinned ? "Unpin" : "Pin"} onClick={overlay.onTogglePin}>
          {artifact.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </HubIconAction>
      ) : null}
      {overlay.onUnhide ? (
        <HubIconAction label="Unhide" onClick={overlay.onUnhide}>
          <EyeIcon className="size-3.5" />
        </HubIconAction>
      ) : overlay.onHide ? (
        <HubIconAction label="Hide" onClick={overlay.onHide}>
          <EyeOffIcon className="size-3.5" />
        </HubIconAction>
      ) : null}
      {overlay.onRemove ? (
        <HubIconAction label="Remove" onClick={overlay.onRemove}>
          <Trash2Icon className="size-3.5" />
        </HubIconAction>
      ) : null}
    </>
  );
}

export function HubArtifactRow({
  artifact,
  pathRoots,
  onOpenFile,
  openUrl,
  copyText,
  onJump,
  overlay,
  dimmed,
}: HubArtifactRowProps) {
  const host = hubArtifactHostname(artifact.url);
  const hostDetail = host && !artifact.label.includes(host) ? host : null;
  const shared = {
    count: artifact.count,
    dimmed: dimmed ?? false,
    onJump,
  };
  const withOverlay = (own: ReactNode) => (
    <>
      {own}
      {overlayButtons(artifact, overlay)}
    </>
  );

  switch (artifact.kind) {
    case "file-output":
    case "file-read": {
      const path = artifact.path;
      const display = path === undefined ? null : hubDisplayPath(path, pathRoots);
      const openable = path === undefined ? null : hubWorkspaceRelativePath(path, pathRoots);
      const code =
        artifact.kind === "file-output" && hubFileGroupId(path ?? artifact.label) === "code";
      return (
        <HubRow
          {...shared}
          actions={withOverlay(
            <HubIconAction
              label="Copy path"
              onClick={() => copyText(path ?? artifact.label, "path")}
            >
              <CopyIcon className="size-3.5" />
            </HubIconAction>,
          )}
          detail={display === null ? null : hubParentFolder(display)}
          icon={code ? <CodeIcon /> : <FileTextIcon />}
          label={artifact.manual ? artifact.label : hubArtifactBasename(path ?? artifact.label)}
          onActivate={openable ? () => onOpenFile(openable) : undefined}
          title={display ?? artifact.label}
        />
      );
    }
    case "pull-request":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          detail={artifact.detail ?? null}
          icon={<PullRequestGlyph.pullRequest />}
          label={artifact.label}
          onActivate={artifact.url ? () => openUrl(artifact.url) : undefined}
          title={artifact.detail ? `${artifact.label}: ${artifact.detail}` : undefined}
        />
      );
    case "commit":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(
            <HubIconAction
              label="Copy commit hash"
              onClick={() => copyText(artifact.key, "commit hash")}
            >
              <CopyIcon className="size-3.5" />
            </HubIconAction>,
          )}
          detail={artifact.detail ?? null}
          icon={<GitCommitHorizontalIcon />}
          label={artifact.label}
        />
      );
    case "link-output":
    case "preview":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          detail={hostDetail}
          icon={artifact.kind === "preview" ? <MonitorPlayIcon /> : <LinkIcon />}
          label={artifact.label}
          onActivate={artifact.url ? () => openUrl(artifact.url) : undefined}
          title={artifact.url ?? artifact.label}
        />
      );
    case "url-fetch":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(
            <HubIconAction label="Open externally" onClick={() => openUrl(artifact.url)}>
              <ExternalLinkIcon className="size-3.5" />
            </HubIconAction>,
          )}
          detail={hostDetail}
          icon={<LinkFavicon url={artifact.url} />}
          label={artifact.label}
          onActivate={() => openUrl(artifact.url)}
          title={artifact.url ?? artifact.label}
        />
      );
    case "attachment":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          icon={<PaperclipIcon />}
          label={artifact.label}
        />
      );
    case "web-search":
    case "skill":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          icon={artifact.kind === "skill" ? <SparklesIcon /> : <SearchIcon />}
          label={artifact.detail ?? artifact.label}
        />
      );
    case "mcp-tool":
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          icon={<WrenchIcon />}
          label={artifact.label}
        />
      );
    case "note-output":
    case "note-source": {
      const note = artifact.note ?? artifact.label;
      return (
        <HubRow
          {...shared}
          actions={withOverlay(null)}
          icon={<StickyNoteIcon />}
          label={artifact.label}
          onActivate={() => copyText(note, "note")}
          title={note}
        />
      );
    }
  }
}
