import {
  EXOWATT_CONNECTOR_CATALOG,
  type EnvironmentId,
  type ExowattConnectorCatalogEntry,
  type ExowattHarnessId,
  type ExowattHarnessMcpInventory,
  type ExowattHarnessMcpInventoryResult,
} from "@t3tools/contracts";
import { CheckIcon, LoaderIcon, PlugIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { exowattConnectorsEnvironment } from "../../state/exowattConnectors";
import { exowattHarnessConfigEnvironment } from "../../state/exowattHarnessConfig";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ExowattConnectorIcon } from "./ExowattConnectorIcon";
import {
  buildConnectorAddInput,
  connectorHarnessActions,
  connectorUnavailableSummary,
  preferredServerOrigin,
  resolveConnectorUrl,
  summarizeAutoConnectReport,
} from "./exowattConnectors.logic";

/** The origin this browser reaches P3 on, used until the server tells us its own. */
function readClientOrigin(): string | null {
  try {
    return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin;
  } catch {
    return null;
  }
}

interface TokenPrompt {
  readonly entry: ExowattConnectorCatalogEntry;
  readonly harness: ExowattHarnessId;
  readonly harnessLabel: string;
}

function ConnectorTokenDialog({
  prompt,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  readonly prompt: TokenPrompt | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  const auth = prompt?.entry.auth;
  const fields = auth?.kind === "user-token" ? auth : null;

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && !saving) {
          setToken("");
          onCancel();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Add {prompt?.entry.title ?? "connector"} to {prompt?.harnessLabel ?? "harness"}
          </DialogTitle>
          <DialogDescription>
            {fields?.help ?? "This connector needs a token before it can be added."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{fields?.fieldLabel ?? "Token"}</span>
            <Input
              autoFocus
              type="password"
              placeholder={fields?.placeholder ?? ""}
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setToken("");
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={saving || token.trim() === ""}
            onClick={() => {
              onSubmit(token);
              setToken("");
            }}
          >
            {saving ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
            Add connector
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The switch that makes the rows below unnecessary: the server writes the `p3`
 * entry into every installed harness itself. "Reconnect now" runs the same
 * reconciliation on demand and reports what it did to each harness.
 */
function AutoConnectRow({
  environmentId,
  inventories,
}: {
  readonly environmentId: EnvironmentId;
  readonly inventories: ReadonlyArray<ExowattHarnessMcpInventory>;
}) {
  const autoConnect = usePrimarySettings((settings) => settings.exowattAutoConnectHarnesses);
  const updateSettings = useUpdatePrimarySettings();
  const reconcile = useAtomCommand(exowattConnectorsEnvironment.reconcile, {
    reportFailure: false,
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reconnect = () => {
    setBusy(true);
    setStatus(null);
    void (async () => {
      const result = await reconcile({ environmentId, input: {} });
      setStatus(
        result._tag === "Success"
          ? summarizeAutoConnectReport({ report: result.value, inventories })
          : "P3 could not reconnect the harnesses. You may not have permission to manage access on this server.",
      );
      setBusy(false);
    })();
  };

  return (
    <SettingsRow
      title="Keep P3 connected"
      description={
        <span>
          Keep P3 connected to every installed harness. P3 writes a{" "}
          <span className="font-mono text-2xs">p3</span> entry with a fresh token into each harness
          config at startup, and rotates it before it expires.
        </span>
      }
      status={status}
      control={
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="ghost" disabled={busy} onClick={reconnect}>
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Reconnect now
          </Button>
          <Switch
            checked={autoConnect}
            onCheckedChange={(checked) =>
              updateSettings({ exowattAutoConnectHarnesses: Boolean(checked) })
            }
            aria-label="Keep P3 connected to every installed harness"
          />
        </div>
      }
    />
  );
}

/**
 * Exowatt distro: the connector catalog above the per-harness inventories. One
 * row per Exowatt MCP server, with a button per harness that can hold it, so
 * connecting a coding agent is a click instead of a pasted JSON block.
 */
export function ExowattConnectorsSection({
  environmentId,
  inventories,
  onInventoryChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly inventories: ReadonlyArray<ExowattHarnessMcpInventory>;
  readonly onInventoryChange: (result: ExowattHarnessMcpInventoryResult) => void;
}) {
  const addMcpServer = useAtomCommand(exowattHarnessConfigEnvironment.addMcpServer, {
    reportFailure: false,
  });
  const issueAgentToken = useAtomCommand(exowattConnectorsEnvironment.issueAgentToken, {
    reportFailure: false,
  });
  const clientOrigin = readClientOrigin();
  const [issuedOrigin, setIssuedOrigin] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [prompt, setPrompt] = useState<TokenPrompt | null>(null);

  const serverOrigin = preferredServerOrigin({ issuedOrigin, clientOrigin });

  const setError = (connectorId: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[connectorId];
      else next[connectorId] = message;
      return next;
    });
  };

  const write = async (input: {
    readonly entry: ExowattConnectorCatalogEntry;
    readonly harness: ExowattHarnessId;
    readonly url: string;
    readonly token?: string | undefined;
  }) => {
    const result = await addMcpServer({
      environmentId,
      input: buildConnectorAddInput(input),
    });
    if (result._tag === "Success") {
      onInventoryChange(result.value);
      setError(input.entry.id, null);
      return true;
    }
    setError(
      input.entry.id,
      `P3 could not add ${input.entry.title} to this harness. Check the config file's permissions.`,
    );
    return false;
  };

  const add = (entry: ExowattConnectorCatalogEntry, harness: ExowattHarnessId, label: string) => {
    if (entry.auth.kind === "user-token") {
      setError(entry.id, null);
      setPrompt({ entry, harness, harnessLabel: label });
      return;
    }
    const key = `${entry.id}:${harness}`;
    setBusy(key);
    setError(entry.id, null);
    void (async () => {
      if (entry.auth.kind === "p3-agent-token") {
        const issued = await issueAgentToken({
          environmentId,
          input: { label: entry.auth.tokenLabel },
        });
        if (issued._tag !== "Success") {
          setError(
            entry.id,
            "P3 could not issue an agent token. You may not have permission to manage access on this server.",
          );
          setBusy(null);
          return;
        }
        const origin = preferredServerOrigin({
          issuedOrigin: issued.value.origin,
          clientOrigin,
        });
        setIssuedOrigin(origin);
        const url = resolveConnectorUrl(entry, origin);
        if (url === null) {
          setError(entry.id, "P3 could not work out this server's own address.");
          setBusy(null);
          return;
        }
        await write({ entry, harness, url, token: issued.value.token });
        setBusy(null);
        return;
      }
      const url = resolveConnectorUrl(entry, serverOrigin);
      if (url !== null) await write({ entry, harness, url });
      setBusy(null);
    })();
  };

  const submitToken = (token: string) => {
    if (prompt === null) return;
    const { entry, harness } = prompt;
    const url = resolveConnectorUrl(entry, serverOrigin);
    if (url === null) return;
    const key = `${entry.id}:${harness}`;
    setBusy(key);
    void (async () => {
      const added = await write({ entry, harness, url, token });
      setBusy(null);
      if (added) setPrompt(null);
    })();
  };

  return (
    <>
      <SettingsSection title="Connectors" icon={<PlugIcon className="size-4.5" />}>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Exowatt&apos;s own MCP servers. Adding one writes it into that harness&apos;s config on
          the active environment, with a token where the server needs one.
        </p>
        <AutoConnectRow environmentId={environmentId} inventories={inventories} />
        {EXOWATT_CONNECTOR_CATALOG.map((entry) => {
          const url = resolveConnectorUrl(entry, serverOrigin);
          const actions = connectorHarnessActions({ entry, url, inventories });
          const unavailable = connectorUnavailableSummary(actions);
          const error = errors[entry.id];
          return (
            <SettingsRow
              key={entry.id}
              title={
                <span className="flex items-center gap-2">
                  <ExowattConnectorIcon name={entry.title} url={url} />
                  {entry.title}
                </span>
              }
              description={
                <span className="space-y-1">
                  <span className="block">{entry.description}</span>
                  <span className="block break-all font-mono text-2xs">
                    {url ?? "Address unknown until this server reports one."}
                  </span>
                </span>
              }
              status={
                error ? (
                  <span className="text-destructive">{error}</span>
                ) : unavailable ? (
                  <span>{unavailable}</span>
                ) : null
              }
              control={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {actions.flatMap((action) => {
                    if (action.state.kind === "unavailable") return [];
                    const key = `${entry.id}:${action.harness}`;
                    if (action.state.kind === "added") {
                      return [
                        <Button key={key} size="xs" variant="ghost" disabled>
                          <CheckIcon className="size-3.5" />
                          Added to {action.label}
                        </Button>,
                      ];
                    }
                    return [
                      <Button
                        key={key}
                        size="xs"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => add(entry, action.harness, action.label)}
                      >
                        {busy === key ? (
                          <LoaderIcon className="size-3.5 animate-spin" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        Add to {action.label}
                      </Button>,
                    ];
                  })}
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <ConnectorTokenDialog
        prompt={prompt}
        saving={prompt !== null && busy === `${prompt.entry.id}:${prompt.harness}`}
        error={prompt === null ? null : (errors[prompt.entry.id] ?? null)}
        onCancel={() => setPrompt(null)}
        onSubmit={submitToken}
      />
    </>
  );
}
