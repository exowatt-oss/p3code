import type {
  ExowattAccent,
  ExowattSidebarDensity,
  ExowattSidebarProjectSort,
  ExowattSidebarThreadSortMode,
  ExowattStatusLightBlink,
} from "@t3tools/contracts/settings";

import type { CSSProperties } from "react";

import { IS_DEV_BUILD } from "../../branding";
import { useTheme } from "../../hooks/useTheme";
import {
  useBoringSidebarEnabled,
  useClientSettings,
  updateClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getThemeDefinition, resolveThemeHalf } from "../../themePalette";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS } from "../exowatt/exowattSidebarProjectSort";
import { EXOWATT_SIDEBAR_THREAD_SORT_DIRECTION_LABELS } from "../exowatt/exowattSidebarThreadSort";
import { EXOWATT_ACCENT_PRESETS, selectExowattCustomization } from "./exowattCustomize";

/*
 * Exowatt: P3's own rows on Settings › Customize › Appearance, mounted by upstream's
 * AppearanceSettingsPanel next to the rows they extend. Experimental rows sit in Labs.
 */

const BLINK_LABELS: Record<Exclude<ExowattStatusLightBlink, "off">, string> = {
  subtle: "Subtle",
  standard: "Standard",
  strong: "Strong",
};

const SORT_LABELS: Record<ExowattSidebarThreadSortMode, string> = {
  activity: "Recent activity",
  created_at: "Date created",
  name: "Name",
  status: "Status",
  manual: "Manual",
};

export const DEV_ACCENT_LOCK_NOTE = "Dev build uses the blueprint theme";

function AccentPicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: ExowattAccent;
  readonly onChange: (accent: ExowattAccent) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 @min-[32rem]/settings-row:items-end">
      <div
        aria-disabled={disabled || undefined}
        aria-label="Accent color"
        className={cn(
          "flex flex-wrap gap-1.5 @min-[32rem]/settings-row:justify-end",
          disabled && "opacity-50",
        )}
        role="radiogroup"
      >
        {/* exowatt: "Default" keeps upstream's colours (D9); the presets are opt-in. */}
        {[{ id: "default" as const, label: "Default" }, ...EXOWATT_ACCENT_PRESETS].map((preset) => (
          <button
            key={preset.id}
            aria-checked={!disabled && preset.id === value}
            aria-label={preset.label}
            className={cn(
              "flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed",
              !disabled && preset.id === value
                ? "border-ring bg-accent text-accent-foreground"
                : "border-border bg-background text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground",
            )}
            disabled={disabled}
            onClick={() => onChange(preset.id)}
            role="radio"
            type="button"
          >
            {"color" in preset ? (
              <span
                aria-hidden="true"
                className="size-3.5 rounded-full bg-(--swatch) ring-1 ring-black/10 dark:bg-(--swatch-dark) dark:ring-white/15"
                style={
                  { "--swatch": preset.color, "--swatch-dark": preset.darkColor } as CSSProperties
                }
              />
            ) : (
              <span
                aria-hidden="true"
                className="size-3.5 rounded-full border border-dashed border-muted-foreground/60"
              />
            )}
            {preset.label}
          </button>
        ))}
      </div>
      {disabled ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-dev-accent-note>
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full bg-primary ring-1 ring-black/10 dark:ring-white/15"
          />
          {DEV_ACCENT_LOCK_NOTE}
        </p>
      ) : null}
    </div>
  );
}

/** The P3 accent, right below upstream's theme library. */
export function ExowattAccentSection() {
  const settings = useClientSettings(selectExowattCustomization);
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const namedTheme = getThemeDefinition(resolveThemeHalf(theme, themeHalves, resolvedTheme));
  return (
    <SettingsSection id="exowatt-accent-section" title="Accent">
      <SettingsRow
        {...searchableSetting("exowatt-accent")}
        description={
          IS_DEV_BUILD
            ? "Locked to blueprint blue so the dev build is never mistaken for production."
            : namedTheme
              ? `The ${namedTheme.label} theme uses its own action color. Your accent returns when you switch back to the P3 Code theme.`
              : "Default keeps the theme's own colors; pick a signal color to override them."
        }
        control={
          <AccentPicker
            disabled={IS_DEV_BUILD}
            value={settings["exowatt.accent"]}
            onChange={(value) => updateClientSettings({ "exowatt.accent": value })}
          />
        }
      />
    </SettingsSection>
  );
}

/** A row beside upstream's panel-animation row (Interface › Advanced). */
export function ExowattStatusLightBlinkRow() {
  const blink = useClientSettings((settings) => settings["exowatt.statusLightBlink"]);
  const blinkEnabled = blink !== "off";
  const blinkIntensity = blinkEnabled ? blink : "standard";
  const updateBlinkIntensity = (value: string | null) => {
    if (value === "subtle" || value === "standard" || value === "strong") {
      updateClientSettings({ "exowatt.statusLightBlink": value });
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("exowatt-status-light-blink")}
      description="Pulse the Working lights in the sidebar at your preferred intensity."
      control={
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 text-3xs text-info-foreground"
          >
            <span
              className="size-1.5 rounded-full bg-info motion-safe:animate-status-pulse"
              data-status-light="running"
            />
            Working
          </span>
          <Switch
            aria-label="Blink status lights"
            checked={blinkEnabled}
            onCheckedChange={(checked) =>
              updateClientSettings({
                "exowatt.statusLightBlink": checked ? blinkIntensity : "off",
              })
            }
          />
          <Select value={blinkIntensity} onValueChange={updateBlinkIntensity}>
            <SelectTrigger
              aria-label="Status-light blink intensity"
              className="w-28"
              disabled={!blinkEnabled}
              size="compact"
            >
              <SelectValue>{BLINK_LABELS[blinkIntensity]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(BLINK_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

function SidebarSection() {
  const settings = useClientSettings(selectExowattCustomization);
  // exowatt: upstream's boring sidebar folders and P3 grouping are never on together.
  const boringSidebarEnabled = useBoringSidebarEnabled();
  const updateDensity = (value: string | null) => {
    if (value === "comfortable" || value === "compact") {
      updateClientSettings({ "exowatt.sidebarDensity": value as ExowattSidebarDensity });
    }
  };
  const updateSort = (value: string | null) => {
    if (value === "activity" || value === "created_at" || value === "name" || value === "status") {
      updateClientSettings({ "exowatt.sidebarSort": value });
    }
  };

  const sortMode = settings["exowatt.sidebarSort"];
  const directionLabels =
    sortMode === "manual" ? null : EXOWATT_SIDEBAR_THREAD_SORT_DIRECTION_LABELS[sortMode];

  return (
    <SettingsSection id="exowatt-sidebar" title="Sidebar">
      <SettingsRow
        {...searchableSetting("exowatt-sidebar-density")}
        description="Choose roomier rows or fit more navigation into the same space."
        control={
          <Select value={settings["exowatt.sidebarDensity"]} onValueChange={updateDensity}>
            <SelectTrigger aria-label="Sidebar density" className="w-36">
              <SelectValue>
                {settings["exowatt.sidebarDensity"] === "compact" ? "Compact" : "Comfortable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("exowatt-sidebar-group-by-project")}
        description={
          boringSidebarEnabled
            ? "Off while the boring sidebar in Labs is on; its project folders group threads instead."
            : "Section threads under collapsible project headers; off keeps one flat stream. To merge the same repository across environments into one project, use Settings › General › Sidebar."
        }
        control={
          <Switch
            aria-label="Group threads by project"
            disabled={boringSidebarEnabled}
            checked={settings["exowatt.sidebarGroupByProject"] && !boringSidebarEnabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ "exowatt.sidebarGroupByProject": checked })
            }
          />
        }
      />
      {settings["exowatt.sidebarGroupByProject"] && !boringSidebarEnabled ? (
        <SettingsRow
          {...searchableSetting("exowatt-sidebar-project-sort")}
          description="Choose how project sections appear. Manual lets you drag section headers to reorder them."
          control={
            <Select
              value={settings["exowatt.sidebarProjectSort"]}
              onValueChange={(value) => {
                if (EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS.some((option) => option.value === value)) {
                  updateClientSettings({
                    "exowatt.sidebarProjectSort": value as ExowattSidebarProjectSort,
                  });
                }
              }}
            >
              <SelectTrigger aria-label="Project sort order" className="w-44">
                <SelectValue>
                  {
                    EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS.find(
                      (option) => option.value === settings["exowatt.sidebarProjectSort"],
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        {...searchableSetting("exowatt-sidebar-nest-dispatched")}
        description="Show visible dispatched threads directly below the thread that created them, with collapsible parent rows."
        control={
          <Switch
            aria-label="Nest dispatched threads under their origin"
            checked={settings["exowatt.sidebarNestDispatched"]}
            onCheckedChange={(checked) =>
              updateClientSettings({ "exowatt.sidebarNestDispatched": checked })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("exowatt-sidebar-sort")}
        description="Set the initial ordering used by the thread sidebar."
        control={
          <Select value={settings["exowatt.sidebarSort"]} onValueChange={updateSort}>
            <SelectTrigger aria-label="Default thread sort" className="w-40">
              <SelectValue>{SORT_LABELS[settings["exowatt.sidebarSort"]]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(SORT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {directionLabels ? (
        <SettingsRow
          {...searchableSetting("exowatt-sidebar-sort-direction")}
          description="Flip the thread order, for example to keep the oldest threads at the top."
          control={
            <Select
              value={settings["exowatt.sidebarSortReversed"] ? "reversed" : "normal"}
              onValueChange={(value) =>
                updateClientSettings({ "exowatt.sidebarSortReversed": value === "reversed" })
              }
            >
              <SelectTrigger aria-label="Thread sort direction" className="w-40">
                <SelectValue>
                  {settings["exowatt.sidebarSortReversed"]
                    ? directionLabels.reversed
                    : directionLabels.normal}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="normal">{directionLabels.normal}</SelectItem>
                <SelectItem value="reversed">{directionLabels.reversed}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function ChatSection() {
  const callouts = useClientSettings((settings) => settings["exowatt.workspaceStateCallouts"]);
  return (
    <SettingsSection id="exowatt-chat" title="Chat">
      <SettingsRow
        {...searchableSetting("exowatt-session-state-callouts")}
        description="Show how Phi turns ended: the state chip and question in the chat header, and the timeline card with open items and the feads epic. The pending-question banner is unaffected."
        control={
          <Switch
            aria-label="Session-state callouts"
            checked={callouts}
            onCheckedChange={(checked) =>
              updateClientSettings({ "exowatt.workspaceStateCallouts": checked })
            }
          />
        }
      />
    </SettingsSection>
  );
}

/** Experimental P3 features, each off by default; mounted in Settings › Labs. */
export function ExowattExperimentalSection() {
  const threadSignals = usePrimarySettings((settings) => settings.exowattThreadSignals);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsSection id="exowatt-experimental" title="Experimental">
      <SettingsRow
        {...searchableSetting("exowatt-thread-signals")}
        description="Give agents on this server the t3_signal_emit, t3_thread_signals and t3_signal_ack tools, so threads report green, yellow and red signals an orchestrator thread can read."
        control={
          <Switch
            aria-label="Thread signals for agents"
            checked={threadSignals}
            onCheckedChange={(checked) =>
              updateSettings({ exowattThreadSignals: Boolean(checked) })
            }
          />
        }
      />
    </SettingsSection>
  );
}

/** Sidebar and chat sections, after upstream's Typography. */
export function ExowattWorkspaceSections() {
  return (
    <>
      <SidebarSection />
      <ChatSection />
    </>
  );
}
