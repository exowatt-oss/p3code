import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import type {
  ExowattHarnessId,
  ExowattHarnessMcpInventory,
  ExowattHarnessMcpInventoryResult,
  ExowattHarnessMcpStatusResult,
  ExowattMcpRuntimeStatus,
  ExowattMcpTransport,
} from "@t3tools/contracts";
import {
  CableIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { cn } from "../../lib/utils";
import { exowattHarnessConfigEnvironment } from "../../state/exowattHarnessConfig";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerAvailableEditorsAtom } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { revealInFileExplorerLabelForOs } from "../preview/fileExplorerLabel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ExowattConnectorIcon } from "./ExowattConnectorIcon";
import { ExowattConnectorsSection } from "./ExowattConnectorsSection";
import {
  CLAUDE_AI_CONNECTORS_URL,
  claudeRuntimeStatusLine,
  claudeServersOutsideInventory,
  describeClaudeLoginOutcome,
  mcpStatusBadge,
  summarizeMcpStatuses,
} from "./exowattClaudeMcp.logic";
import { connectorDisplayName } from "./exowattConnectorIcon.logic";
import { environmentScopedValue, resolveMcpEnablementControl } from "./exowattMcp.logic";

const EMPTY_INVENTORY: ExowattHarnessMcpInventoryResult = { harnesses: [] };
const EMPTY_RUNTIME_STATUSES: ReadonlyMap<string, ExowattMcpRuntimeStatus> = new Map();
const EMPTY_EXTRA_SERVERS: ReadonlyArray<ExowattMcpRuntimeStatus> = [];

interface RowMessage {
  readonly operationName: string;
  readonly message: string;
}

/**
 * Wall-clock time that ticks on an interval, for "checked 2 min ago" lines.
 * Reading `Date.now()` during render would make the output differ between
 * renders for no reason; a state value updated from a timer does not.
 */
function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- interval timer for relative timestamps.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

function splitLines(value: string): ReadonlyArray<string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnvironment(value: string): ReadonlyArray<{ name: string; value: string }> {
  return splitLines(value).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0
      ? { name: line, value: "" }
      : { name: line.slice(0, separator).trim(), value: line.slice(separator + 1) };
  });
}

function McpRuntimeStatusBadge({
  status,
}: {
  readonly status: ExowattMcpRuntimeStatus | undefined;
}) {
  if (!status) return null;
  const { label, variant, title } = mcpStatusBadge(status);
  return (
    <Badge variant={variant} title={title}>
      {label}
    </Badge>
  );
}

// phi resolves ${VAR} references from the environment it was launched with. P3
// hands harnesses the user's login-shell environment, so the fix is always the
// same: define the variable where login shells pick it up, then restart P3 Code
// (phi re-reads mcp.json on /reload, but it cannot re-read its own environment).
function McpConfigErrorHint({ status }: { readonly status: ExowattMcpRuntimeStatus }) {
  if (!status.configError) return null;
  const missing = status.missingEnv ?? [];
  return (
    <span className="block text-2xs text-destructive">
      {missing.length > 0 ? (
        <>
          Missing environment: {missing.map((name) => `$${name}`).join(", ")}. Set{" "}
          {missing.length === 1 ? "it" : "them"} in <code>~/.pi/agent/phi.env</code> (sourced by{" "}
          <code>~/.zprofile</code>) and restart P3 Code; this server is skipped until then.
        </>
      ) : (
        <>{status.configError} (this server is skipped until the config is fixed)</>
      )}
    </span>
  );
}

function HarnessSourceActions({
  path,
  onOpen,
  onReveal,
  revealLabel,
}: {
  readonly path: string;
  readonly onOpen: (path: string) => void;
  readonly onReveal: (path: string) => void;
  readonly revealLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="xs" variant="outline" onClick={() => onOpen(path)}>
        <ExternalLinkIcon className="size-3.5" />
        Open in editor
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onReveal(path)}>
        <FolderOpenIcon className="size-3.5" />
        {revealLabel}
      </Button>
    </div>
  );
}

/**
 * A server Claude Code reports that is in no config file P3 read for it: a
 * claude.ai connector (Gmail, Slack, Drive, …) or one from another scope. There
 * is no file to open, so the row links to claude.ai instead, and login goes
 * through `claude mcp login` like any other Claude Code server.
 */
function ReportedServerRow({
  harness,
  status,
  connecting,
  connectDisabled,
  connectError,
  connectNotice,
  onConnect,
}: {
  readonly harness: ExowattHarnessId;
  readonly status: ExowattMcpRuntimeStatus;
  readonly connecting: boolean;
  readonly connectDisabled: boolean;
  readonly connectError: RowMessage | null;
  readonly connectNotice: RowMessage | null;
  readonly onConnect: (harness: ExowattHarnessId, name: string) => void;
}) {
  const operationName = `${harness}:${status.name}`;
  const managed = status.managedBy === "claude.ai";
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ExowattConnectorIcon name={status.name} url={status.target ?? null} />
          {connectorDisplayName(status.name)}
          <McpRuntimeStatusBadge status={status} />
        </span>
      }
      description={
        <span className="space-y-1">
          {status.target ? <span className="block break-all">{status.target}</span> : null}
          <span className="block text-2xs">
            {managed
              ? "claude.ai connector: configured in your claude.ai account, not in a file on this machine."
              : "Reported by Claude Code from a scope outside the configs P3 reads, such as a project .mcp.json."}
          </span>
          {status.connectionError ? (
            <span className="block break-all text-2xs text-destructive">
              {status.connectionError}
            </span>
          ) : null}
          {connectNotice?.operationName === operationName ? (
            <span className="block text-2xs text-info-foreground">{connectNotice.message}</span>
          ) : null}
          {connectError?.operationName === operationName ? (
            <span className="block text-2xs text-destructive">{connectError.message}</span>
          ) : null}
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {status.needsLogin ? (
            <Button
              size="xs"
              variant="outline"
              disabled={connecting || connectDisabled}
              onClick={() => onConnect(harness, status.name)}
            >
              {connecting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          ) : null}
          {managed ? (
            <Button
              size="xs"
              variant="ghost"
              render={<a href={CLAUDE_AI_CONNECTORS_URL} rel="noreferrer" target="_blank" />}
            >
              <ExternalLinkIcon className="size-3.5" />
              Manage on claude.ai
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function HarnessMcpSection({
  inventory,
  runtimeStatuses,
  reportedServers,
  statusLine,
  busyName,
  connectBusyName,
  connectError,
  connectNotice,
  runtimeRefreshing,
  runtimeSupportsEnablement,
  onAdd,
  onToggle,
  onConnect,
  onOpen,
  onReveal,
  revealLabel,
}: {
  readonly inventory: ExowattHarnessMcpInventory;
  readonly runtimeStatuses: ReadonlyMap<string, ExowattMcpRuntimeStatus>;
  /** Servers the harness reports that the config files do not have. */
  readonly reportedServers: ReadonlyArray<ExowattMcpRuntimeStatus>;
  /** One line under the heading about the harness's own status read, when it has one. */
  readonly statusLine: string | null;
  readonly busyName: string | null;
  readonly connectBusyName: string | null;
  readonly connectError: RowMessage | null;
  readonly connectNotice: RowMessage | null;
  readonly runtimeRefreshing: boolean;
  readonly runtimeSupportsEnablement: boolean;
  readonly onAdd: (harness: ExowattHarnessId) => void;
  readonly onToggle: (harness: ExowattHarnessId, name: string, enabled: boolean) => void;
  readonly onConnect: (harness: ExowattHarnessId, name: string) => void;
  readonly onOpen: (path: string) => void;
  readonly onReveal: (path: string) => void;
  readonly revealLabel: string;
}) {
  const sourcePath = inventory.sourcePaths[0] ?? inventory.rootPath;
  return (
    <SettingsSection
      title={inventory.label}
      icon={<ServerIcon className="size-4.5" />}
      headerAction={
        <Button size="xs" variant="outline" onClick={() => onAdd(inventory.harness)}>
          <PlusIcon className="size-3.5" />
          Add server
        </Button>
      }
    >
      {statusLine ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">{statusLine}</p>
      ) : null}
      {inventory.warnings.map((warning) => (
        <div
          key={warning}
          className="mx-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:mx-4"
        >
          {warning}
        </div>
      ))}
      {inventory.servers.length === 0 && reportedServers.length === 0 ? (
        <div className="mx-3 rounded-xl border border-dashed sm:mx-4">
          <Empty size="compact" className="min-h-40">
            <EmptyMedia variant="icon">
              <CableIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No MCP servers configured</EmptyTitle>
              <EmptyDescription>
                Add a server here or edit <span className="font-mono">{sourcePath}</span>.
              </EmptyDescription>
            </EmptyHeader>
            <HarnessSourceActions
              path={sourcePath}
              onOpen={onOpen}
              onReveal={onReveal}
              revealLabel={revealLabel}
            />
          </Empty>
        </div>
      ) : (
        inventory.servers.map((server) => {
          const operationName = `${inventory.harness}:${server.name}`;
          const runtimeStatus = runtimeStatuses.get(server.name);
          const { enabled, canToggle: hasEnablementControl } = resolveMcpEnablementControl({
            harness: inventory.harness,
            rawStatus: server.status,
            runtimeStatus,
            runtimeSupportsEnablement,
          });
          const canToggle = inventory.supportsToggle && hasEnablementControl;
          const connecting = connectBusyName === operationName;
          return (
            <SettingsRow
              key={server.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <ExowattConnectorIcon name={server.name} url={server.url ?? null} />
                  {server.name}
                  <Badge variant={enabled ? "success" : "secondary"}>
                    {enabled === undefined
                      ? "status unavailable"
                      : enabled
                        ? "enabled"
                        : "disabled"}
                  </Badge>
                  <McpRuntimeStatusBadge status={runtimeStatus} />
                </span>
              }
              description={
                <span className="space-y-1">
                  <span className="block">
                    {server.transport === "http"
                      ? server.url
                      : [server.command, ...server.args].filter(Boolean).join(" ")}
                  </span>
                  <span className="block break-all font-mono text-2xs">{server.sourcePath}</span>
                  {inventory.harness === "phi" ? (
                    <span className="block text-2xs">
                      Changes apply to new or reloaded Phi sessions.
                    </span>
                  ) : null}
                  {server.envNames.length > 0 ? (
                    <span className="block text-2xs">
                      Environment: {server.envNames.join(", ")}
                    </span>
                  ) : null}
                  {runtimeStatus ? <McpConfigErrorHint status={runtimeStatus} /> : null}
                  {runtimeStatus?.connectionError ? (
                    <span className="block break-all text-2xs text-destructive">
                      {runtimeStatus.connectionError}
                    </span>
                  ) : null}
                  {connectNotice?.operationName === operationName ? (
                    <span className="block text-2xs text-info-foreground">
                      {connectNotice.message}
                    </span>
                  ) : null}
                  {connectError?.operationName === operationName ? (
                    <span className="block text-2xs text-destructive">{connectError.message}</span>
                  ) : null}
                </span>
              }
              control={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {enabled === true && runtimeStatus?.needsLogin && !runtimeStatus.configError ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={
                        connecting ||
                        busyName === operationName ||
                        runtimeRefreshing ||
                        runtimeStatus.loginInProgress
                      }
                      onClick={() => onConnect(inventory.harness, server.name)}
                    >
                      {connecting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                      {connecting ? "Connecting…" : "Connect"}
                    </Button>
                  ) : null}
                  <HarnessSourceActions
                    path={server.sourcePath}
                    onOpen={onOpen}
                    onReveal={onReveal}
                    revealLabel={revealLabel}
                  />
                  {canToggle ? (
                    busyName === operationName ? (
                      <LoaderIcon className="mx-2 size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        aria-label={`${enabled ? "Disable" : "Enable"} ${server.name}`}
                        checked={enabled ?? false}
                        onCheckedChange={(enabled) =>
                          onToggle(inventory.harness, server.name, enabled)
                        }
                      />
                    )
                  ) : null}
                </div>
              }
            />
          );
        })
      )}
      {reportedServers.map((status) => (
        <ReportedServerRow
          key={status.name}
          harness={inventory.harness}
          status={status}
          connecting={connectBusyName === `${inventory.harness}:${status.name}`}
          connectDisabled={connectBusyName !== null || busyName !== null}
          connectError={connectError}
          connectNotice={connectNotice}
          onConnect={onConnect}
        />
      ))}
    </SettingsSection>
  );
}

function AddMcpServerDialog({
  harness,
  label,
  open,
  saving,
  error,
  onOpenChange,
  onSave,
}: {
  readonly harness: ExowattHarnessId | null;
  readonly label: string;
  readonly open: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (input: {
    readonly name: string;
    readonly transport: ExowattMcpTransport;
    readonly command: string;
    readonly url: string;
    readonly args: string;
    readonly env: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<ExowattMcpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  // Opening the dialog, or switching its harness while open, starts an empty form.
  const [formFor, setFormFor] = useState({ harness, open });
  if (formFor.harness !== harness || formFor.open !== open) {
    setFormFor({ harness, open });
    if (open) {
      setName("");
      setTransport("stdio");
      setCommand("");
      setUrl("");
      setArgs("");
      setEnv("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add MCP server to {label}</DialogTitle>
          <DialogDescription>
            P3 writes this on the selected environment using the harness&apos;s native config
            format.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Transport</span>
            <Select
              value={transport}
              onValueChange={(value) => {
                if (value === "stdio" || value === "http") setTransport(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {transport === "stdio" ? "Command (stdio)" : "URL (HTTP)"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="stdio">Command (stdio)</SelectItem>
                <SelectItem value="http">URL (HTTP)</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          {transport === "stdio" ? (
            <>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Command</span>
                <Input
                  placeholder="npx"
                  value={command}
                  onChange={(event) => setCommand(event.currentTarget.value)}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Arguments</span>
                <Textarea
                  placeholder={"One argument per line\n-y\n@example/server"}
                  value={args}
                  onChange={(event) => setArgs(event.currentTarget.value)}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Environment</span>
                <Textarea
                  placeholder={"One KEY=value per line\nAPI_KEY=${API_KEY}"}
                  value={env}
                  onChange={(event) => setEnv(event.currentTarget.value)}
                />
              </label>
            </>
          ) : (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">URL</span>
              <Input
                placeholder="https://example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
              />
            </label>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              saving ||
              harness === null ||
              name.trim() === "" ||
              (transport === "stdio" ? command.trim() === "" : url.trim() === "")
            }
            onClick={() => onSave({ name, transport, command, url, args, env })}
          >
            {saving ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
            Add server
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The latest settled query value for the current environment. A local write (a mutation's
 * fresh result) shows until the query reports new data; a value from another environment
 * never shows.
 */
function useEnvironmentQueryState<T>(
  environmentId: string | null,
  query: { readonly data: NonNullable<T> | null; readonly isPending: boolean },
  empty: T,
) {
  const [state, setState] = useState<{
    readonly environmentId: string | null;
    readonly value: T;
  }>({ environmentId: null, value: empty });
  const [synced, setSynced] = useState<{
    readonly environmentId: string | null;
    readonly data: NonNullable<T> | null;
  }>({ environmentId: null, data: null });
  if (
    environmentId !== null &&
    query.data &&
    !query.isPending &&
    (synced.environmentId !== environmentId || synced.data !== query.data)
  ) {
    setSynced({ environmentId, data: query.data });
    setState({ environmentId, value: query.data });
  }
  return [environmentScopedValue(environmentId, state, empty), setState] as const;
}

export function ExowattCustomizeMcpPage() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : exowattHarnessConfigEnvironment.mcpInventory({ environmentId, input: {} }),
  );
  const runtimeQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : exowattHarnessConfigEnvironment.mcpStatus({
          environmentId,
          input: { harness: "phi" },
        }),
  );
  // Claude Code answers from `claude mcp list`, which health-checks every server
  // and takes a minute for a long list; the server caches it, the page shows
  // the file inventory meanwhile.
  const claudeRuntimeQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : exowattHarnessConfigEnvironment.mcpStatus({
          environmentId,
          input: { harness: "claude" },
        }),
  );
  // Codex answers from `codex mcp list --json`: config plus its credential
  // store, no health check, so it is quick.
  const codexRuntimeQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : exowattHarnessConfigEnvironment.mcpStatus({
          environmentId,
          input: { harness: "codex" },
        }),
  );
  const addMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.addMcpServer, {
    reportFailure: false,
  });
  const toggleMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.toggleMcpServer, {
    reportFailure: false,
  });
  const connectMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.connectMcpServer, {
    reportFailure: false,
  });
  const revealPath = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  // Never render rows from a previous environment under the newly selected ID.
  // This makes stale rows non-actionable on the very first switched render, before
  // the new query resolves.
  const [inventory, setInventoryState] = useEnvironmentQueryState(
    environmentId,
    query,
    EMPTY_INVENTORY,
  );
  const [runtimeData] = useEnvironmentQueryState<ExowattHarnessMcpStatusResult | undefined>(
    environmentId,
    runtimeQuery,
    undefined,
  );
  const [claudeRuntimeData] = useEnvironmentQueryState<ExowattHarnessMcpStatusResult | undefined>(
    environmentId,
    claudeRuntimeQuery,
    undefined,
  );
  const [codexRuntimeData] = useEnvironmentQueryState<ExowattHarnessMcpStatusResult | undefined>(
    environmentId,
    codexRuntimeQuery,
    undefined,
  );
  const [addingHarness, setAddingHarness] = useState<ExowattHarnessId | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [connectBusyName, setConnectBusyName] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<RowMessage | null>(null);
  const [connectNotice, setConnectNotice] = useState<RowMessage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Read inside async completions so a resolved login only touches state when the user is
  // still looking at the environment it was started in.
  const environmentIdRef = useRef(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a ref read by async login completions in step with the open environment.
  useEffect(() => {
    environmentIdRef.current = environmentId;
  }, [environmentId]);
  // Switching environments drops every in-flight row state from the previous one.
  const [rowStateEnvironmentId, setRowStateEnvironmentId] = useState(environmentId);
  if (rowStateEnvironmentId !== environmentId) {
    setRowStateEnvironmentId(environmentId);
    setAddingHarness(null);
    setSaving(false);
    setBusyName(null);
    setConnectBusyName(null);
    setConnectError(null);
    setConnectNotice(null);
    setFormError(null);
  }

  const selectedHarness =
    inventory.harnesses.find((item) => item.harness === addingHarness) ?? null;
  const runtimeStatuses = runtimeData?.available
    ? new Map(runtimeData.servers.map((status) => [status.name, status]))
    : EMPTY_RUNTIME_STATUSES;
  const claudeStatuses = claudeRuntimeData?.available
    ? new Map(claudeRuntimeData.servers.map((status) => [status.name, status]))
    : EMPTY_RUNTIME_STATUSES;
  const codexStatuses = codexRuntimeData?.available
    ? new Map(codexRuntimeData.servers.map((status) => [status.name, status]))
    : EMPTY_RUNTIME_STATUSES;
  const codexStatusLine =
    codexRuntimeData === undefined
      ? codexRuntimeQuery.isPending
        ? "Asking Codex about its servers…"
        : null
      : codexRuntimeData.available
        ? summarizeMcpStatuses(codexRuntimeData.servers)
        : "Codex did not answer: the codex command was not found or is too old for `codex mcp list --json`. Only the config file is shown.";
  const claudeInventory = inventory.harnesses.find((item) => item.harness === "claude") ?? null;
  const claudeReportedServers =
    claudeRuntimeData?.available && claudeInventory
      ? claudeServersOutsideInventory({
          inventoryServers: claudeInventory.servers,
          statuses: claudeRuntimeData.servers,
        })
      : EMPTY_EXTRA_SERVERS;
  const nowMs = useNowMs(15_000);
  const claudeStatusLine = claudeRuntimeStatusLine({
    status: claudeRuntimeData,
    pending: claudeRuntimeQuery.isPending,
    nowMs,
  });
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
  const toggle = (harness: ExowattHarnessId, name: string, enabled: boolean) => {
    if (environmentId === null) return;
    const startedInEnvironmentId = environmentId;
    const operationName = `${harness}:${name}`;
    setBusyName(operationName);
    setConnectError(null);
    void (async () => {
      const result = await toggleMcpServer({
        environmentId: startedInEnvironmentId,
        input: { harness, name, enabled },
      });
      if (environmentIdRef.current !== startedInEnvironmentId) return;
      setBusyName(null);
      // A timeout can race a successful sidecar commit. Always re-read effective
      // state before deciding what the row should show.
      runtimeQuery.refresh();
      if (result._tag === "Success") {
        if (result.value.inventory) {
          setInventoryState({
            environmentId: startedInEnvironmentId,
            value: result.value.inventory,
          });
        }
        return;
      }
      const failure = Cause.squash(result.cause);
      const reason =
        failure && typeof failure === "object" && "reason" in failure
          ? String(failure.reason)
          : failure instanceof Error
            ? failure.message
            : `P3 could not ${enabled ? "enable" : "disable"} this MCP server.`;
      setConnectError({ operationName, message: reason });
    })();
  };
  const connect = (harness: ExowattHarnessId, name: string) => {
    if (environmentId === null) return;
    // A login can block for minutes, so capture the environment it belongs to: without
    // this, switching environments mid-login shows this spinner (or its failure) against
    // a same-named server in the new environment.
    const startedInEnvironmentId = environmentId;
    const operationName = `${harness}:${name}`;
    setConnectBusyName(operationName);
    setConnectError(null);
    setConnectNotice(null);
    void (async () => {
      const result = await connectMcpServer({
        environmentId: startedInEnvironmentId,
        input: { harness, name },
      });
      if (environmentIdRef.current !== startedInEnvironmentId) return;
      setConnectBusyName(null);
      if (harness === "codex") {
        if (result._tag === "Success" && result.value.connected) {
          codexRuntimeQuery.refresh();
          return;
        }
        setConnectError({
          operationName,
          message:
            result._tag === "Success"
              ? (result.value.error ?? "Codex MCP login did not complete.")
              : "P3 could not start Codex MCP login.",
        });
        return;
      }
      if (harness === "claude") {
        if (result._tag !== "Success") {
          setConnectError({ operationName, message: "P3 could not start Claude Code MCP login." });
          return;
        }
        const outcome = describeClaudeLoginOutcome(result.value);
        if (outcome.kind === "notice")
          setConnectNotice({ operationName, message: outcome.message });
        else setConnectError({ operationName, message: outcome.message });
        claudeRuntimeQuery.refresh();
        return;
      }
      if (result._tag === "Success" && result.value.connected) {
        runtimeQuery.refresh();
        return;
      }
      setConnectError({
        operationName,
        message:
          result._tag === "Success"
            ? (result.value.error ?? "Phi MCP login did not complete.")
            : "P3 could not start Phi MCP login.",
      });
    })();
  };
  const save = (form: {
    readonly name: string;
    readonly transport: ExowattMcpTransport;
    readonly command: string;
    readonly url: string;
    readonly args: string;
    readonly env: string;
  }) => {
    if (environmentId === null || addingHarness === null) return;
    const startedInEnvironmentId = environmentId;
    const targetHarness = addingHarness;
    setSaving(true);
    setFormError(null);
    void (async () => {
      const result = await addMcpServer({
        environmentId: startedInEnvironmentId,
        input: {
          harness: targetHarness,
          name: form.name.trim(),
          transport: form.transport,
          ...(form.transport === "stdio"
            ? { command: form.command.trim() }
            : { url: form.url.trim() }),
          args: [...splitLines(form.args)],
          env: [...parseEnvironment(form.env)],
        },
      });
      if (environmentIdRef.current !== startedInEnvironmentId) return;
      setSaving(false);
      if (result._tag === "Success") {
        setInventoryState({ environmentId: startedInEnvironmentId, value: result.value });
        setAddingHarness(null);
      } else {
        setFormError(
          "P3 could not update this harness config. Check the values and file permissions.",
        );
      }
    })();
  };

  return (
    <>
      <SettingsPageContainer className="gap-10" width="wide">
        <section className="flex flex-col gap-3 px-3 sm:flex-row sm:items-end sm:justify-between sm:px-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Model Context Protocol</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Servers are discovered on the active P3 environment, including SSH remotes. Secret
              environment values are never returned to the browser.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isPending || runtimeQuery.isPending}
            onClick={() => {
              query.refresh();
              runtimeQuery.refresh();
              claudeRuntimeQuery.refresh();
              codexRuntimeQuery.refresh();
            }}
          >
            <RefreshCwIcon
              className={cn(
                "size-4",
                (query.isPending || runtimeQuery.isPending || claudeRuntimeQuery.isPending) &&
                  "animate-spin",
              )}
            />
            Refresh
          </Button>
        </section>

        {environmentId === null ? (
          <Empty className="min-h-80">
            <EmptyMedia variant="icon">
              <ServerIcon />
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
            Reading harness configs…
          </div>
        ) : query.error ? (
          <Empty className="min-h-80">
            <EmptyMedia variant="icon">
              <CableIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Could not read harness configs</EmptyTitle>
              <EmptyDescription>Check the active environment and try again.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ExowattConnectorsSection
              environmentId={environmentId}
              inventories={inventory.harnesses}
              onInventoryChange={(value) => setInventoryState({ environmentId, value })}
            />
            {inventory.harnesses.map((item) => (
              <HarnessMcpSection
                key={item.harness}
                inventory={item}
                runtimeStatuses={
                  item.harness === "phi"
                    ? runtimeStatuses
                    : item.harness === "claude"
                      ? claudeStatuses
                      : item.harness === "codex"
                        ? codexStatuses
                        : EMPTY_RUNTIME_STATUSES
                }
                reportedServers={
                  item.harness === "claude" ? claudeReportedServers : EMPTY_EXTRA_SERVERS
                }
                statusLine={
                  item.harness === "claude"
                    ? claudeStatusLine
                    : item.harness === "codex"
                      ? codexStatusLine
                      : null
                }
                busyName={busyName}
                connectBusyName={connectBusyName}
                connectNotice={connectNotice}
                // A Claude Code status read takes a minute; a login must not wait on it.
                runtimeRefreshing={
                  item.harness === "phi"
                    ? runtimeQuery.isPending
                    : item.harness === "codex"
                      ? codexRuntimeQuery.isPending
                      : false
                }
                runtimeSupportsEnablement={
                  runtimeData?.available === true && runtimeData.supportsEnablement === true
                }
                connectError={connectError}
                onAdd={(harness) => {
                  setFormError(null);
                  setAddingHarness(harness);
                }}
                onToggle={toggle}
                onConnect={connect}
                onOpen={open}
                onReveal={reveal}
                revealLabel={revealLabel}
              />
            ))}
          </>
        )}
      </SettingsPageContainer>

      <AddMcpServerDialog
        harness={addingHarness}
        label={selectedHarness?.label ?? "harness"}
        open={addingHarness !== null}
        saving={saving}
        error={formError}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !saving) setAddingHarness(null);
        }}
        onSave={save}
      />
    </>
  );
}
