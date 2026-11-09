import { Link } from "@tanstack/react-router";

import { APP_GIT_SHA, APP_VERSION, IS_DEV_BUILD } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { EXOWATT_CHANGELOG_ROUTE } from "./exowattChangelog";
import { useExowattOpenLogs } from "./ExowattLogsButton";
import { formatExowattVersionLabel } from "./ExowattVersionLabel";

/** The build, What's new and logs, which the sidebar footer used to show (Settings › General › About). */
export function ExowattAboutSettingsRows() {
  const version = formatExowattVersionLabel(APP_VERSION, IS_DEV_BUILD, APP_GIT_SHA);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "P3 Code version information",
    timeout: 1_200,
  });
  const logs = useExowattOpenLogs();

  return (
    <>
      <SettingsRow
        {...searchableSetting("exowatt-build")}
        description={`${version.p3VersionLabel}, based on ${version.t3VersionLabel}.`}
        control={
          <Button size="sm" variant="outline" onClick={() => copyToClipboard(version.copyText)}>
            {isCopied ? "Copied" : "Copy"}
          </Button>
        }
      />
      <SettingsRow
        {...searchableSetting("exowatt-whats-new")}
        description="Release notes for every P3 Code build."
        control={
          <Button render={<Link to={EXOWATT_CHANGELOG_ROUTE} />} size="sm" variant="outline">
            Open
          </Button>
        }
      />
      <SettingsRow
        {...searchableSetting("exowatt-logs")}
        description="This app's log files, for bug reports."
        control={
          <Button size="sm" variant="outline" onClick={() => void logs.openLogs()}>
            {logs.label}
          </Button>
        }
      />
    </>
  );
}
