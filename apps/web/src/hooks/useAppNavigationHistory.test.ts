import { describe, expect, it, vi } from "vite-plus/test";

import {
  installAppNavigationHistory,
  navigationHistoryDirectionFromMouseButton,
} from "./useAppNavigationHistory";

describe("navigationHistoryDirectionFromMouseButton", () => {
  it("maps auxiliary mouse buttons to browser history", () => {
    expect(navigationHistoryDirectionFromMouseButton(3)).toBe("back");
    expect(navigationHistoryDirectionFromMouseButton(4)).toBe("forward");
  });

  it("ignores ordinary and unknown buttons", () => {
    expect(navigationHistoryDirectionFromMouseButton(0)).toBeNull();
    expect(navigationHistoryDirectionFromMouseButton(2)).toBeNull();
    expect(navigationHistoryDirectionFromMouseButton(8)).toBeNull();
  });
});

describe("installAppNavigationHistory", () => {
  it("uses renderer mouseup once on macOS and cleans it up", () => {
    const listeners = new Set<(event: MouseEvent) => void>();
    const navigate = vi.fn();
    const target = {
      desktopBridge: { getClientPlatform: () => "darwin" },
      addEventListener: (_type: "mouseup", listener: (event: MouseEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: "mouseup", listener: (event: MouseEvent) => void) =>
        listeners.delete(listener),
    };
    const cleanup = installAppNavigationHistory({ target, navigate });
    const event = {
      button: 3,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;
    for (const listener of listeners) listener(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("back");
    cleanup();
    expect(listeners).toHaveLength(0);
  });

  it("uses desktop app-command IPC on Windows/Linux and leaves browser history native", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: (direction: "back" | "forward") => void) => {
      listener("forward");
      return unsubscribe;
    });
    const navigate = vi.fn();
    const target = {
      desktopBridge: { getClientPlatform: () => "win32", onNavigationHistory: subscribe },
      addEventListener,
      removeEventListener,
    };
    const cleanup = installAppNavigationHistory({ target, navigate });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("forward");
    expect(addEventListener).not.toHaveBeenCalled();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const browserTarget = {
      addEventListener,
      removeEventListener,
    };
    installAppNavigationHistory({ target: browserTarget, navigate });
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
