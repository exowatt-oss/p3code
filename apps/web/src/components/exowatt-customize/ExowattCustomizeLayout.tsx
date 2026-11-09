import { Link, useLocation } from "@tanstack/react-router";
import {
  BlocksIcon,
  CableIcon,
  PaintbrushIcon,
  PawPrintIcon,
  PuzzleIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export type ExowattCustomizePath =
  | "/settings/customize"
  | "/settings/customize/pets"
  | "/settings/customize/mcp"
  | "/settings/customize/skills"
  | "/settings/customize/plugins"
  | "/settings/customize/extensions";

interface CustomizeSection {
  readonly label: string;
  readonly to: ExowattCustomizePath;
  readonly icon: LucideIcon;
}

const EXOWATT_CUSTOMIZE_SECTIONS: ReadonlyArray<CustomizeSection> = [
  { label: "Appearance", to: "/settings/customize", icon: PaintbrushIcon },
  { label: "Pets", to: "/settings/customize/pets", icon: PawPrintIcon },
  { label: "MCP", to: "/settings/customize/mcp", icon: CableIcon },
  { label: "Skills", to: "/settings/customize/skills", icon: WandSparklesIcon },
  { label: "Plugins", to: "/settings/customize/plugins", icon: BlocksIcon },
  { label: "Extensions", to: "/settings/customize/extensions", icon: PuzzleIcon },
];

/**
 * Exowatt: Settings › Customize. P3's appearance, pets and harness pages share
 * one settings tab; this strip switches between them under the settings header.
 */
export function ExowattCustomizeLayout({ children }: { readonly children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/+$/, "") });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Customize sections"
        className="shrink-0 border-b border-border px-3 py-2 sm:px-4"
      >
        <div className="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {EXOWATT_CUSTOMIZE_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = pathname === section.to;
            return (
              <Link
                key={section.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  active && "bg-accent text-foreground",
                )}
                to={section.to}
              >
                <Icon className="size-4" />
                <span>{section.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
