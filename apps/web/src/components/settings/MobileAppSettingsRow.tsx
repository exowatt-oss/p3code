import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="P3 Code mobile apps are not published to app stores yet. Build the mobile client from source."
      control={null}
    />
  );
}
