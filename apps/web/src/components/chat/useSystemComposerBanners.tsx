import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  isExowattNoCompatibleRemoteServerError,
  isExowattStockRemoteServerError,
} from "@t3tools/contracts";
import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WifiOffIcon } from "lucide-react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { environmentCatalog } from "../../connection/catalog";
import { ConnectionDiagnosisHeadline } from "../settings/ConnectionDiagnosisDetails";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentDisconnectDelay,
  useEnvironmentStateHeldFor,
} from "../../hooks/useEnvironmentDisconnectDelay";
import { serverEnvironment } from "../../state/server";
import { type EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ServerUpdateAction, serverUpdateStageLabel } from "../ServerUpdateAction";
import { useAutoBalanceUpdateBanner } from "./useAutoBalanceUpdateBanner";
// exowatt: SSH remote recovery actions (stop stock T3 server, push dev server).
import {
  describeExowattStockRemoteServerStop,
  EXOWATT_STOP_STOCK_REMOTE_SERVER_LABEL,
  resolveExowattStockRemoteServerAction,
} from "./exowattStockRemoteServer";
import {
  EXOWATT_PUSH_DEV_SERVER_LABEL,
  resolveExowattPushDevServerAction,
  shouldOfferExowattPushDevServer,
} from "./exowattRemoteServer";
import { ComposerServerUpdateIcon } from "./ComposerServerUpdateStatus";
import {
  dismissServerUpdateFailure,
  isServerUpdateFailureDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "../../versionSkew";

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

interface SystemComposerBannersInput {
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly serverConfig: EnvironmentPresentation["serverConfig"] | null;
  readonly hasMultipleRegisteredEnvironments: boolean;
  readonly automaticEnvironment: boolean;
  readonly autoUpdateEnvironments: ReadonlyArray<EnvironmentPresentation>;
}

/**
 * The composer banners about the machine itself: offline or reconnecting,
 * a server update, and auto-balanced machines that need one.
 */
export function useSystemComposerBanners(input: SystemComposerBannersInput) {
  const {
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId,
    serverConfig,
    hasMultipleRegisteredEnvironments,
    automaticEnvironment,
    autoUpdateEnvironments,
  } = input;
  const navigate = useNavigate();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  // Each reconnect attempt gets its own grace period, including a later one to
  // the same environment.
  const reconnectWarningGraceElapsed = useEnvironmentStateHeldFor(
    activeReconnectingEnvironmentId,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    // A retry does nothing while the environment is switched off.
    const result =
      activeEnvironment?.entry.enabled === false
        ? await setEnvironmentEnabled({ environmentId, enabled: true })
        : await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  // exowatt: the remote refused because a stock T3 server owns ~/.t3 there.
  const exowattStockRemoteServerAction = resolveExowattStockRemoteServerAction({
    environment: activeEnvironment,
    error: activeEnvironment?.connection.error ?? null,
    bridge: window.desktopBridge,
  });
  const [exowattStoppingStockRemoteServer, setExowattStoppingStockRemoteServer] = useState(false);
  const handleExowattStopStockRemoteServer = async (environmentId: EnvironmentId) => {
    if (exowattStockRemoteServerAction === null) return;
    setExowattStoppingStockRemoteServer(true);
    // Promise chaining, not try/finally: the React Compiler skips a component with a finalizer.
    const stopped = await exowattStockRemoteServerAction
      .stop()
      .then(
        (result) => {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Stopped the stock T3 Code server",
              description: describeExowattStockRemoteServerStop(result),
            }),
          );
          return true;
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not stop the stock T3 Code server",
              description:
                error instanceof Error ? error.message : "The remote host rejected the request.",
            }),
          );
          return false;
        },
      )
      .finally(() => setExowattStoppingStockRemoteServer(false));
    if (!stopped) return;
    await handleReconnectActiveEnvironment(environmentId);
  };
  // exowatt (dev builds): nothing compatible on the remote and no bundled
  // server; offer to install the worktree's packed server instead of stock t3.
  const exowattPushDevServerCandidate = resolveExowattPushDevServerAction({
    environment: activeEnvironment,
    bridge: window.desktopBridge,
    isDevelopment: import.meta.env.DEV,
  });
  const exowattPushDevServerAction = shouldOfferExowattPushDevServer({
    action: exowattPushDevServerCandidate,
    error: activeEnvironment?.connection.error ?? null,
  })
    ? exowattPushDevServerCandidate
    : null;
  const [exowattPushingDevServer, setExowattPushingDevServer] = useState(false);
  const handleExowattPushDevServer = async (environmentId: EnvironmentId) => {
    if (exowattPushDevServerAction === null) return;
    setExowattPushingDevServer(true);
    const pushed = await exowattPushDevServerAction
      .push()
      .then(
        (result) => {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Dev server ${result.version} installed on ${exowattPushDevServerAction.host}`,
              description: "Reconnecting with the pushed server.",
            }),
          );
          return true;
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not push the dev server",
              description:
                error instanceof Error ? error.message : "The remote host rejected the install.",
            }),
          );
          return false;
        },
      )
      .finally(() => setExowattPushingDevServer(false));
    if (!pushed) return;
    await handleReconnectActiveEnvironment(environmentId);
  };
  const exowattRemoteRecoveryOffered =
    exowattStockRemoteServerAction !== null || exowattPushDevServerAction !== null;
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable && activeEnvironment ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    setDisconnectingEnvironment(true);
    const result = await setEnvironmentEnabled({ environmentId, enabled: false });
    setDisconnectingEnvironment(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disconnect server",
            description: error instanceof Error ? error.message : "Failed to disconnect.",
          }),
        );
      }
      return;
    }
    void navigate({ to: "/", replace: true });
  };
  const handleDisconnectActiveEnvironmentStable = useStableCallback(
    handleDisconnectActiveEnvironment,
  );
  const autoBalanceUpdateBanner = useAutoBalanceUpdateBanner(autoUpdateEnvironments);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThreadEnvironmentId !== null
      ? `${activeEnvironment?.label ?? serverConfig?.environment.label ?? activeThreadEnvironmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThreadEnvironmentId;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchInstallation = serverConfig?.environment.capabilities.serverInstallation;
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);
  return (() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Environments."
          onClick={() =>
            void handleDisconnectActiveEnvironmentStable(
              activeEnvironmentUnavailableState.environmentId,
            )
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    const suppressUnavailableBanner =
      environmentReconnecting && (updateRunning || !reconnectWarningGraceElapsed);
    const showUnavailableBanner =
      activeEnvironmentUnavailableState !== null &&
      unavailableConnection !== null &&
      !suppressUnavailableBanner;
    if (showUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        group: "environment",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        // exowatt: a P3 remote refusal explains itself; show it instead of the generic headline.
        description:
          unavailableConnection.error &&
          (isExowattStockRemoteServerError(unavailableConnection.error) ||
            isExowattNoCompatibleRemoteServerError(unavailableConnection.error)) ? (
            unavailableConnection.error
          ) : activeEnvironment ? (
            <ConnectionDiagnosisHeadline environment={activeEnvironment} />
          ) : undefined,
        actions: (
          <>
            {/* exowatt: stop a stock T3 server / push the dev server on SSH remotes. */}
            {exowattStockRemoteServerAction !== null ? (
              <Button
                size="xs"
                disabled={exowattStoppingStockRemoteServer}
                onClick={() =>
                  void handleExowattStopStockRemoteServer(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {exowattStoppingStockRemoteServer
                  ? "Stopping..."
                  : EXOWATT_STOP_STOCK_REMOTE_SERVER_LABEL}
              </Button>
            ) : null}
            {exowattPushDevServerAction !== null ? (
              <Button
                size="xs"
                disabled={exowattPushingDevServer}
                onClick={() =>
                  void handleExowattPushDevServer(activeEnvironmentUnavailableState.environmentId)
                }
              >
                {exowattPushingDevServer ? "Pushing..." : EXOWATT_PUSH_DEV_SERVER_LABEL}
              </Button>
            ) : null}
            {!environmentReconnecting ? (
              <Button
                size="xs"
                variant={exowattRemoteRecoveryOffered ? "outline" : "ghost"}
                onClick={() =>
                  void handleReconnectActiveEnvironmentStable(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                Reconnect
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ),
      });
    }
    // An available update is offered by the sidebar's update pill; the composer only shows one
    // that is running or failed, since either explains what this thread's server is doing.
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      serverUpdateState.status !== "idle" &&
      !serverUpdateFailureDismissed
    ) {
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        group: "environment",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title: `${updateFailed ? "Could not update" : "Updating"} ${versionMismatchServerLabel}`,
        description:
          serverUpdateState.status === "failed"
            ? serverUpdateState.message
            : serverUpdateStageLabel(serverUpdateState.stage),
        actions: !updateFailed ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            installation={versionMismatchInstallation}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            targetVersion={versionMismatch.clientVersion}
            serverVersion={versionMismatch.serverVersion}
            label="Retry"
            variant="ghost"
          />
        ),
        ...(updateFailed
          ? {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                dismissServerUpdateFailure(serverUpdateState);
                setDismissedServerUpdateState(serverUpdateState);
              },
            }
          : {}),
      });
    }
    if (autoBalanceUpdateBanner) items.push(autoBalanceUpdateBanner);
    return items;
  })() as ComposerBannerStackItem[];
}
