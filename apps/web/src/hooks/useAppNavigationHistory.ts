import type { AnyRouter } from "@tanstack/react-router";

export type AppNavigationHistoryDirection = "back" | "forward";

export function navigationHistoryDirectionFromMouseButton(
  button: number,
): AppNavigationHistoryDirection | null {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

interface NavigationHistoryWindow {
  readonly desktopBridge?: {
    readonly getClientPlatform?: () => string;
    readonly onNavigationHistory?: (
      listener: (direction: AppNavigationHistoryDirection) => void,
    ) => () => void;
  };
  addEventListener(type: "mouseup", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "mouseup", listener: (event: MouseEvent) => void): void;
}

/** Install exactly one history input path: native browser, macOS renderer, or desktop IPC. */
export function installAppNavigationHistory(input: {
  readonly target: NavigationHistoryWindow;
  readonly navigate: (direction: AppNavigationHistoryDirection) => void;
}): () => void {
  const platform = input.target.desktopBridge?.getClientPlatform?.();
  if (platform === undefined) {
    // Outside the desktop shell, the browser owns auxiliary-button history.
    return () => undefined;
  }

  if (platform === "darwin") {
    const onMouseUp = (event: MouseEvent) => {
      const direction = navigationHistoryDirectionFromMouseButton(event.button);
      if (direction === null) return;
      event.preventDefault();
      input.navigate(direction);
    };
    input.target.addEventListener("mouseup", onMouseUp);
    return () => input.target.removeEventListener("mouseup", onMouseUp);
  }

  if (platform !== "win32" && platform !== "linux") return () => undefined;
  const unsubscribe = input.target.desktopBridge?.onNavigationHistory?.(input.navigate);
  return () => unsubscribe?.();
}

/** Mouse back/forward buttons move through the app's history for the life of the app. */
export function startAppNavigationHistory(router: AnyRouter): () => void {
  return installAppNavigationHistory({
    target: window,
    navigate: (direction) => {
      if (direction === "back") router.history.back();
      else router.history.forward();
    },
  });
}
