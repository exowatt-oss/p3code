import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Exowatt: Phi chat-display toggles on the Phi provider card. Client-local, like Customize › Chat. */
export function ExowattPhiDisplaySection() {
  const callouts = useClientSettings((settings) => settings["exowatt.workspaceStateCallouts"]);
  const mcpNotices = useClientSettings((settings) => settings["exowatt.phiMcpNotices"]);
  return (
    <SettingsSection title="Display">
      <SettingsRow
        title="Session-state callouts"
        description="The end-of-turn state chip in the chat header and the open-items card in the timeline. This device only."
        control={
          <Switch
            aria-label="Session-state callouts"
            checked={callouts}
            onCheckedChange={(checked) =>
              updateClientSettings({ "exowatt.workspaceStateCallouts": Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        title="MCP notices"
        description="Phi's yellow MCP connection notices in the timeline. This device only."
        control={
          <Switch
            aria-label="MCP notices"
            checked={mcpNotices}
            onCheckedChange={(checked) =>
              updateClientSettings({ "exowatt.phiMcpNotices": Boolean(checked) })
            }
          />
        }
      />
    </SettingsSection>
  );
}
