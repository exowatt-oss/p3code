import { cn } from "../../lib/utils";
import {
  brandFill,
  type ExowattConnectorGlyph,
  resolveConnectorGlyph,
} from "./exowattConnectorIcon.logic";

/** P3's own mark, served from the web app's public directory. */
const P3_ICON_URL = "/favicon-32x32.png";

function ExowattMark({ className }: { readonly className?: string }) {
  // A plain "E" in the tile: the brand mark itself is not in this bundle, and
  // a monogram in the foreground color reads the same way in both themes.
  return (
    <span className={cn("text-2xs font-semibold tracking-tight", className)} aria-hidden>
      E
    </span>
  );
}

function GlyphBody({ glyph }: { readonly glyph: ExowattConnectorGlyph }) {
  switch (glyph.kind) {
    case "brand": {
      const fill = brandFill(glyph.hex);
      return (
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill={fill ?? "currentColor"}
          aria-hidden
          focusable="false"
        >
          <path d={glyph.path} />
        </svg>
      );
    }
    case "p3":
      return <img src={P3_ICON_URL} alt="" className="size-4 rounded-xs" draggable={false} />;
    case "exowatt":
      return <ExowattMark />;
    case "monogram":
      return (
        <span className="text-3xs font-semibold tracking-tight" aria-hidden>
          {glyph.letters}
        </span>
      );
  }
}

/**
 * Exowatt distro: the tile in front of a connector row on Customize › MCP: a brand mark, P3's
 * icon for this server, "E" for Exowatt's servers, or initials. Decorative (the row title
 * carries the name), so it is hidden from assistive technology.
 */
export function ExowattConnectorIcon({
  name,
  url,
  className,
}: {
  readonly name: string;
  readonly url?: string | null | undefined;
  readonly className?: string;
}) {
  const glyph = resolveConnectorGlyph({ name, url });
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-foreground/80",
        className,
      )}
      aria-hidden
    >
      <GlyphBody glyph={glyph} />
    </span>
  );
}
