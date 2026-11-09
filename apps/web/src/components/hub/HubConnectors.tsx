/**
 * Hub connectors: the MCP servers this thread's harness reaches. Folded by default; only servers
 * whose tools failed on auth in this thread show unasked. Writes reuse `harnessMcp.*` commands;
 * anything needing more than a click goes to Customize › MCP. Only the thread's harness is asked.
 */
import type {
  EnvironmentId,
  ExowattHarnessMcpInventoryResult,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { EXOWATT_CONNECTOR_CATALOG } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, LoaderIcon, PlugIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { ExowattConnectorIcon } from "~/components/exowatt-customize/ExowattConnectorIcon";
import { connectorDisplayName } from "~/components/exowatt-customize/exowattConnectorIcon.logic";
import {
  buildConnectorAddInput,
  preferredServerOrigin,
} from "~/components/exowatt-customize/exowattConnectors.logic";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { exowattHarnessConfigEnvironment } from "~/state/exowattHarnessConfig";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  buildHubConnectors,
  deriveThreadMcpServers,
  hubConnectorsSummary,
  mcpLoginCommand,
  type ExowattMcpServersHarness,
  type HubConnectorRow,
  type HubMcpRuntimeStatus,
} from "./hubConnectors.logic";
import { HubDisclosure, HubIconTile, HubSection } from "./HubPrimitives";

/** Above this many healthy rows the section collapses them behind a summary. */
const HEALTHY_ROWS_BEFORE_COLLAPSE = 5;
/**
 * Above this many attention rows, show the first few and fold the rest. A
 * Claude harness with 30 signed-out claude.ai connectors is a settings
 * problem, not something the Hub should scroll through on every thread.
 */
const ATTENTION_ROWS_BEFORE_COLLAPSE = 3;

const EMPTY_INVENTORY: ExowattHarnessMcpInventoryResult = { harnesses: [] };

const STATUS_TONE: Record<HubConnectorRow["status"], string> = {
  "needs-auth": "text-warning-foreground",
  failed: "text-destructive",
  "config-error": "text-destructive",
  pending: "text-muted-foreground",
  connected: "text-secondary-label",
  disabled: "text-muted-foreground",
  "not-added": "text-muted-foreground",
};

const STATUS_LABEL: Record<HubConnectorRow["status"], string> = {
  "needs-auth": "Needs sign-in",
  failed: "Unreachable",
  "config-error": "Config error",
  pending: "Connecting",
  connected: "Connected",
  disabled: "Disabled",
  "not-added": "Not added",
};

/** `mcp login` only exists for the three harnesses P3 drives logins for. */
function loginCommandFor(row: HubConnectorRow): string {
  return row.harness === "phi" || row.harness === "codex" || row.harness === "claude"
    ? mcpLoginCommand(row.harness, row.name)
    : `Sign in to ${row.name}`;
}

function readClientOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function ConnectorRow({
  row,
  busy,
  onToggle,
  onAction,
}: {
  row: HubConnectorRow;
  busy: boolean;
  onToggle: (row: HubConnectorRow, enabled: boolean) => void;
  onAction: (row: HubConnectorRow) => void;
}) {
  const actionLabel =
    row.action.kind === "login"
      ? "Log in"
      : row.action.kind === "reconnect"
        ? "Reconnect"
        : row.action.kind === "manage"
          ? "Fix"
          : row.action.kind === "add-token"
            ? "Add token"
            : row.action.kind === "add"
              ? "Add"
              : null;
  return (
    <div
      className={cn(
        "flex h-11 items-center gap-2.5 rounded-lg px-1",
        row.status === "not-added" ? "opacity-60" : null,
      )}
      data-hub-connector={row.name}
      data-hub-connector-status={row.status}
    >
      <HubIconTile>
        <ExowattConnectorIcon name={row.name} url={row.url} className="size-3.5 rounded-sm" />
      </HubIconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground">{connectorDisplayName(row.name)}</span>
        <span className="flex min-w-0 items-center gap-1 text-2xs">
          <span className={cn("shrink-0", STATUS_TONE[row.status])}>
            {row.failedInThread ? "Failed in this thread" : STATUS_LABEL[row.status]}
          </span>
          {row.detail ? (
            <span className="min-w-0 truncate text-muted-foreground/60">· {row.detail}</span>
          ) : null}
        </span>
      </span>
      {actionLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="shrink-0"
                disabled={busy}
                onClick={() => onAction(row)}
                size="micro"
                variant="outline"
              >
                {busy ? <LoaderIcon className="size-3 animate-spin" /> : null}
                {row.action.kind === "add" || row.action.kind === "add-token" ? (
                  <PlusIcon className="size-3" />
                ) : null}
                {actionLabel}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {row.action.kind === "login" ? (
              <code className="text-2xs">{loginCommandFor(row)}</code>
            ) : row.action.kind === "manage" ? (
              "Open Customize › MCP to fix the configuration"
            ) : row.action.kind === "add-token" ? (
              "Add this connector in Customize › MCP, where the token goes"
            ) : row.action.kind === "add" ? (
              `Add ${row.name} to ${row.harnessLabel}`
            ) : (
              "Ask the harness for this server's status again"
            )}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {row.canToggle ? (
        busy ? (
          <LoaderIcon className="mx-1 size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
            checked={row.enabled ?? false}
            className="shrink-0"
            onCheckedChange={(enabled) => onToggle(row, enabled)}
          />
        )
      ) : null}
    </div>
  );
}

export function HubConnectors({
  environmentId,
  harness,
  items,
}: {
  environmentId: EnvironmentId | null;
  /** The thread's harness; null renders nothing. */
  harness: ExowattMcpServersHarness | null;
  items: readonly OrchestrationV2TurnItem[];
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [healthyOpen, setHealthyOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const queryEnvironmentId = harness === null ? null : environmentId;

  const inventoryQuery = useEnvironmentQuery(
    queryEnvironmentId === null
      ? null
      : exowattHarnessConfigEnvironment.mcpInventory({
          environmentId: queryEnvironmentId,
          input: {},
        }),
  );
  // One status read, for the thread's own harness: the same call Customize › MCP makes.
  const statusQuery = useEnvironmentQuery(
    queryEnvironmentId === null || harness === null
      ? null
      : exowattHarnessConfigEnvironment.mcpStatus({
          environmentId: queryEnvironmentId,
          input: { harness },
        }),
  );
  const toggleMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.toggleMcpServer, {
    reportFailure: true,
  });
  const connectMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.connectMcpServer, {
    reportFailure: true,
  });
  const addMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.addMcpServer, {
    reportFailure: true,
  });

  const threadServers = deriveThreadMcpServers(items);
  const runtimeStatusesByHarness = new Map<
    ExowattMcpServersHarness,
    ReadonlyMap<string, HubMcpRuntimeStatus>
  >();
  if (harness !== null) {
    const statuses = new Map<string, HubMcpRuntimeStatus>();
    if (statusQuery.data?.available) {
      for (const status of statusQuery.data.servers) statuses.set(status.name, status);
    }
    runtimeStatusesByHarness.set(harness, statuses);
  }

  const serverOrigin = preferredServerOrigin({
    issuedOrigin: null,
    clientOrigin: readClientOrigin(),
  });

  const model = buildHubConnectors({
    threadHarness: harness,
    threadServers,
    inventories: (inventoryQuery.data ?? EMPTY_INVENTORY).harnesses,
    runtimeStatusesByHarness,
    runtimeSupportsEnablement: harness === "phi" && statusQuery.data?.available === true,
    catalog: EXOWATT_CONNECTOR_CATALOG,
    serverOrigin,
  });

  const openMcpSettings = () => void navigate({ to: "/settings/customize/mcp" });

  const toggle = (row: HubConnectorRow, enabled: boolean) => {
    if (environmentId === null) return;
    setBusyId(row.id);
    void (async () => {
      await toggleMcpServer({
        environmentId,
        input: { harness: row.harness, name: row.name, enabled },
      });
      setBusyId(null);
      inventoryQuery.refresh();
      statusQuery.refresh();
    })();
  };

  const act = (row: HubConnectorRow) => {
    if (environmentId === null) return;
    const action = row.action;
    switch (action.kind) {
      case "login": {
        setBusyId(row.id);
        void (async () => {
          await connectMcpServer({
            environmentId,
            input: { harness: row.harness, name: row.name },
          });
          setBusyId(null);
          statusQuery.refresh();
        })();
        return;
      }
      case "reconnect": {
        statusQuery.refresh();
        return;
      }
      case "add": {
        const url = row.url;
        if (url === null) {
          openMcpSettings();
          return;
        }
        setBusyId(row.id);
        void (async () => {
          await addMcpServer({
            environmentId,
            input: buildConnectorAddInput({ entry: action.entry, harness: row.harness, url }),
          });
          setBusyId(null);
          inventoryQuery.refresh();
        })();
        return;
      }
      // A pasted token and a broken config both belong on the page that owns
      // those forms; this panel would only be a second, thinner copy.
      case "add-token":
      case "manage":
        openMcpSettings();
        return;
      case "none":
        return;
    }
  };

  if (harness === null || model.rows.length === 0) return null;
  const urgent = model.urgent;
  // The rest of the attention list is what the session merely started signed
  // out of; it only appears once the section is opened.
  const rest = model.attention.filter((row) => !row.failedInThread);
  const collapseHealthy = model.healthyCount > HEALTHY_ROWS_BEFORE_COLLAPSE;
  const collapseAttention = rest.length > ATTENTION_ROWS_BEFORE_COLLAPSE + 1;
  const summary = hubConnectorsSummary(model);

  const renderRow = (row: HubConnectorRow) => (
    <ConnectorRow
      key={row.id}
      busy={busyId === row.id}
      onAction={act}
      onToggle={toggle}
      row={row}
    />
  );

  return (
    <HubSection
      title="Connectors"
      icon={<PlugIcon />}
      tone={urgent.length > 0 ? "warning" : "neutral"}
      description={
        urgent.length > 0
          ? "MCP servers the agent can call. The ones shown failed in this thread; open the card for everything else."
          : "MCP servers the agent can call. Nothing failed in this thread; open the card to see the full list."
      }
      onToggle={() => setOpen((it) => !it)}
      open={open}
      action={
        <span className="flex min-w-0 items-center gap-1.5">
          {summary ? (
            <span
              className={cn(
                "truncate text-2xs",
                urgent.length > 0 ? "text-warning-foreground" : "text-muted-foreground",
              )}
            >
              {summary}
            </span>
          ) : null}
          <Button className="shrink-0" onClick={openMcpSettings} size="micro" variant="ghost-muted">
            Manage
            <ArrowUpRightIcon />
          </Button>
        </span>
      }
    >
      {urgent.length > 0 || open ? (
        <>
          {urgent.map(renderRow)}
          {open ? (
            <>
              {(collapseAttention && !attentionOpen
                ? rest.slice(0, ATTENTION_ROWS_BEFORE_COLLAPSE)
                : rest
              ).map(renderRow)}
              {collapseAttention ? (
                <HubDisclosure onToggle={() => setAttentionOpen((it) => !it)} open={attentionOpen}>
                  {attentionOpen
                    ? "Show fewer"
                    : `${rest.length - ATTENTION_ROWS_BEFORE_COLLAPSE} more signed out or broken`}
                </HubDisclosure>
              ) : null}
              {collapseHealthy ? (
                <HubDisclosure onToggle={() => setHealthyOpen((it) => !it)} open={healthyOpen}>
                  {model.healthyCount} connected
                </HubDisclosure>
              ) : null}
              {!collapseHealthy || healthyOpen ? model.healthy.map(renderRow) : null}
              {model.disabled.map(renderRow)}
              {model.available.map(renderRow)}
            </>
          ) : null}
        </>
      ) : null}
    </HubSection>
  );
}
