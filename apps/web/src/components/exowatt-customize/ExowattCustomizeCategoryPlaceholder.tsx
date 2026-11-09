import { useAtomValue } from "@effect/atom-react";
import type {
  ExowattHarnessAssetInventory,
  ExowattHarnessAssetInventoryResult,
  ExowattHarnessAssetKind,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LoaderIcon,
  PuzzleIcon,
  RefreshCwIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { cn } from "../../lib/utils";
import { exowattHarnessConfigEnvironment } from "../../state/exowattHarnessConfig";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerAvailableEditorsAtom } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { revealInFileExplorerLabelForOs } from "../preview/fileExplorerLabel";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Switch } from "../ui/switch";

const CATEGORY_COPY = {
  Skills: {
    icon: WandSparklesIcon,
    kind: "skills",
    description: "Reusable instructions each harness discovers from its native skill locations.",
  },
  Plugins: {
    icon: BlocksIcon,
    kind: "plugins",
    description: "Installed harness packages and plugin bundles.",
  },
  Extensions: {
    icon: PuzzleIcon,
    kind: "extensions",
    description: "Native extension directories and package-backed extensions.",
  },
} as const satisfies Record<
  string,
  {
    readonly icon: LucideIcon;
    readonly kind: ExowattHarnessAssetKind;
    readonly description: string;
  }
>;

const EMPTY_INVENTORY: ExowattHarnessAssetInventoryResult = { harnesses: [] };

function HarnessAssetSection({
  inventory,
  Icon,
  busyId,
  revealLabel,
  onOpen,
  onReveal,
  onToggle,
}: {
  readonly inventory: ExowattHarnessAssetInventory;
  readonly Icon: LucideIcon;
  readonly busyId: string | null;
  readonly revealLabel: string;
  readonly onOpen: (path: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onToggle: (
    inventory: ExowattHarnessAssetInventory,
    name: string,
    path: string,
    enabled: boolean,
  ) => void;
}) {
  return (
    <SettingsSection title={inventory.label} icon={<Icon className="size-4.5" />}>
      {inventory.assets.length === 0 ? (
        <div className="mx-3 rounded-xl border border-dashed sm:mx-4">
          <Empty size="compact" className="min-h-36">
            <EmptyMedia variant="icon">
              <Icon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No {inventory.kind} configured</EmptyTitle>
              <EmptyDescription>
                {inventory.sourcePaths.length === 0
                  ? `${inventory.label} does not expose a separate ${inventory.kind} surface.`
                  : `Add items under ${inventory.sourcePaths.join(" or ")}.`}
              </EmptyDescription>
            </EmptyHeader>
            {inventory.sourcePaths[0] ? (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpen(inventory.sourcePaths[0]!)}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open in editor
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onReveal(inventory.sourcePaths[0]!)}
                >
                  <FolderOpenIcon className="size-3.5" />
                  {revealLabel}
                </Button>
              </div>
            ) : null}
          </Empty>
        </div>
      ) : (
        <div className="space-y-1">
          {inventory.assets.map((asset) => {
            const itemId = `${inventory.harness}:${inventory.kind}:${asset.name}`;
            return (
              <div
                key={asset.id}
                className="flex flex-col gap-3 rounded-xl px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium">{asset.name}</h3>
                    <Badge variant={asset.status === "enabled" ? "success" : "secondary"}>
                      {asset.status}
                    </Badge>
                  </div>
                  <p className="mt-1 break-all font-mono text-2xs text-muted-foreground">
                    {asset.sourcePath}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => onOpen(asset.sourcePath)}>
                    <ExternalLinkIcon className="size-3.5" />
                    Open in editor
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onReveal(asset.sourcePath)}>
                    <FolderOpenIcon className="size-3.5" />
                    {revealLabel}
                  </Button>
                  {inventory.supportsToggle ? (
                    busyId === itemId ? (
                      <LoaderIcon className="mx-2 size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        aria-label={`${asset.status === "enabled" ? "Disable" : "Enable"} ${asset.name}`}
                        checked={asset.status === "enabled"}
                        onCheckedChange={(enabled) =>
                          onToggle(inventory, asset.name, asset.sourcePath, enabled)
                        }
                      />
                    )
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

export function ExowattCustomizeCategoryPlaceholder({
  category,
}: {
  readonly category: keyof typeof CATEGORY_COPY;
}) {
  const copy = CATEGORY_COPY[category];
  const Icon = copy.icon;
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : exowattHarnessConfigEnvironment.assetInventory({
          environmentId,
          input: { kind: copy.kind },
        }),
  );
  const toggleAsset = useAtomCommand(exowattHarnessConfigEnvironment.toggleAsset, {
    reportFailure: false,
  });
  const revealPath = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const [inventory, setInventory] = useState(EMPTY_INVENTORY);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A toggle's fresh result shows until the query reports new data.
  const [syncedData, setSyncedData] = useState<typeof query.data>(null);
  if (query.data && query.data !== syncedData) {
    setSyncedData(query.data);
    setInventory(query.data);
  }

  const os = primaryEnvironment?.serverConfig?.environment.platform.os ?? "unknown";
  const revealLabel = revealInFileExplorerLabelForOs(os);
  const open = (path: string) => void openInEditor(path);
  const reveal = (path: string) => {
    if (environmentId === null) return;
    void revealPath({
      environmentId,
      input: { cwd: path, editor: "file-manager", reveal: true },
    });
  };
  const toggle = (
    item: ExowattHarnessAssetInventory,
    name: string,
    sourcePath: string,
    enabled: boolean,
  ) => {
    if (environmentId === null) return;
    const itemId = `${item.harness}:${item.kind}:${name}`;
    setBusyId(itemId);
    void (async () => {
      const result = await toggleAsset({
        environmentId,
        input: { harness: item.harness, kind: item.kind, name, sourcePath, enabled },
      });
      setBusyId(null);
      if (result._tag === "Success") setInventory(result.value);
    })();
  };

  return (
    <SettingsPageContainer className="gap-10" width="wide">
      <section className="flex flex-col gap-3 px-3 sm:flex-row sm:items-end sm:justify-between sm:px-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{category}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {copy.description} Discovery runs on the active environment, including SSH remotes.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <RefreshCwIcon className={cn("size-4", query.isPending && "animate-spin")} />
          Refresh
        </Button>
      </section>
      {environmentId === null ? (
        <Empty className="min-h-80">
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No environment selected</EmptyTitle>
            <EmptyDescription>
              Connect a P3 environment to inspect its harness configs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : query.isPending && inventory.harnesses.length === 0 ? (
        <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
          <LoaderIcon className="mr-2 size-4 animate-spin" />
          Reading {category.toLowerCase()}…
        </div>
      ) : query.error ? (
        <Empty className="min-h-80">
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Could not read {category.toLowerCase()}</EmptyTitle>
            <EmptyDescription>Check the active environment and try again.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        inventory.harnesses.map((item) => (
          <HarnessAssetSection
            key={item.harness}
            inventory={item}
            Icon={Icon}
            busyId={busyId}
            revealLabel={revealLabel}
            onOpen={open}
            onReveal={reveal}
            onToggle={toggle}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}
