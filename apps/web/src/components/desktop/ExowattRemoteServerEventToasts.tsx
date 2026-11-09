// Exowatt distro: surfaces background remote server upgrades (main process ->
// renderer) as toasts; see apps/desktop/src/ssh/ExowattRemoteServerSource.ts.
import { describeExowattRemoteServerEvent } from "../chat/exowattRemoteServer";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function startExowattRemoteServerEventToasts(): () => void {
  const bridge = window.desktopBridge;
  if (!bridge?.onExowattRemoteServerEvent) return () => undefined;
  return bridge.onExowattRemoteServerEvent((event) => {
    toastManager.add(stackedThreadToast(describeExowattRemoteServerEvent(event)));
  });
}
