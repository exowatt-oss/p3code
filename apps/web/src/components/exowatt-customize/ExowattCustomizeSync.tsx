import { IS_DEV_BUILD } from "../../branding";
import { getClientSettings, subscribeClientSettings } from "../../hooks/useSettings";
import {
  applyExowattCustomization,
  EXOWATT_CUSTOMIZATION_STYLES,
  selectExowattCustomization,
  type ExowattCustomizationSettings,
} from "./exowattCustomize";

function sameCustomization(
  left: ExowattCustomizationSettings | null,
  right: ExowattCustomizationSettings,
): boolean {
  if (left === null) return false;
  for (const key of Object.keys(right) as Array<keyof ExowattCustomizationSettings>) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** Writes P3's accent, density and motion choices onto the document for the life of the app. */
export function startExowattCustomization(): () => void {
  const root = document.documentElement;
  const style = document.createElement("style");
  style.dataset.exowattCustomization = "";
  style.textContent = EXOWATT_CUSTOMIZATION_STYLES;
  document.head.append(style);

  let applied: ExowattCustomizationSettings | null = null;
  const apply = () => {
    const next = selectExowattCustomization(getClientSettings());
    if (sameCustomization(applied, next)) return;
    applied = next;
    applyExowattCustomization(root, next, { isDevBuild: IS_DEV_BUILD });
  };
  const unsubscribe = subscribeClientSettings(apply);
  apply();
  return () => {
    unsubscribe();
    style.remove();
  };
}
