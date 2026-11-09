import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { resolveSidebarUpdateControlState, SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: [],
    restarts: [],
  }),
}));

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(update: DesktopUpdateState | null, { hasUpdates = false } = {}) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("SidebarUpdatePill release notes", () => {
  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(
      nightlyUpdate([
        {
          version: "0.0.50-nightly.2",
          items: ["**One-time tasks.** Pick a date."],
          totalItems: 1,
          stats: "3 changes from 2 contributors",
          footer: "Plus 2 more bug fixes.",
        },
      ]),
    );
    await expect.element(page.getByText("One-time tasks.", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Plus 2 more bug fixes.")).toBeVisible();
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not refocus the update button after a pointer cancel", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();

    await userEvent.click(cancel);
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(document.activeElement).not.toBe(button.element());
  });

  it("returns focus to the update button after Escape", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element()));
  });
});

// exowatt: P3's Homebrew updater control (one-click restart, force-check, P3 wording).
const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function resolve(state: DesktopUpdateState, showCheckIcon = false) {
  return resolveSidebarUpdateControlState({
    state,
    showCheckIcon,
    isActionPending: false,
  });
}

describe("sidebar updater control", () => {
  it("keeps the updater check control clickable when idle", () => {
    expect(resolve(baseState)).toMatchObject({
      action: "none",
      cursorClass: "cursor-pointer",
      disabled: false,
      tooltip: "Check for updates",
    });
  });

  it("shows clear up-to-date feedback while keeping force-check available", () => {
    expect(resolve({ ...baseState, status: "up-to-date" })).toMatchObject({
      cursorClass: "cursor-pointer",
      disabled: false,
      tooltip: "P3 Code is up to date. Check again",
    });
  });

  it("shows a loading state without a misleading not-allowed cursor", () => {
    expect(resolve({ ...baseState, status: "checking" }, true)).toMatchObject({
      cursorClass: "cursor-wait",
      disabled: true,
      iconStatus: "checking",
      tooltip: "Checking for updates…",
    });
  });

  it("shows the one-click install action when an update is available", () => {
    expect(
      resolve({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        downloadPercent: 100,
      }),
    ).toMatchObject({
      action: "install",
      cursorClass: "cursor-pointer",
      disabled: false,
      iconStatus: "downloaded",
      tooltip: "Update 1.1.0 is ready. Restart to update.",
    });
  });

  it("keeps recovered errors actionable through force-check", () => {
    const message = "The Exowatt Homebrew tap could not be updated.";
    expect(
      resolve({
        ...baseState,
        status: "error",
        message,
        errorContext: "install",
        canRetry: true,
      }),
    ).toMatchObject({
      action: "none",
      cursorClass: "cursor-pointer",
      disabled: false,
      iconStatus: "error",
      tooltip: message,
    });
  });

  it("uses not-allowed only when updater prerequisites are unavailable, and says why", () => {
    expect(resolve({ ...baseState, enabled: false, status: "disabled" })).toMatchObject({
      cursorClass: "cursor-not-allowed",
      disabled: true,
      tooltip: "Updates unavailable",
      idleTooltip: {
        title: "Updates unavailable",
        detail: "Automatic updates are not available in this build.",
      },
    });
  });

  it("labels the rendered control with P3's up-to-date wording", async () => {
    setup({ ...baseState, status: "up-to-date" });
    await using screen = await render(<SidebarUpdatePill />);
    await expect
      .element(screen.getByRole("button", { name: "P3 Code is up to date. Check again" }))
      .toBeInTheDocument();
  });
});
