import type { DesktopAppBranding } from "@t3tools/contracts";
import { PRODUCT_BASE_NAME } from "@t3tools/shared/productBranding";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? PRODUCT_BASE_NAME;
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Beta");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
// Public source builds do not have prebuilt installers; do not use upstream T3 binaries.
export const DESKTOP_DOWNLOAD_URL = "https://github.com/exowatt-oss/p3code/releases";
// exowatt: short sha of the serving checkout (apps/web/vite.config.ts); empty in
// packaged builds.
export const APP_GIT_SHA = import.meta.env.APP_GIT_SHA || "";
// exowatt: the same signal that selects the blueprint dev icon (an unpackaged
// desktop build served from the Vite dev server, or a browser dev session).
export const IS_DEV_BUILD = APP_STAGE_LABEL === "Dev";
