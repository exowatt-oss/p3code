import { useEffect, useState } from "react";
import { PetsSettingsPanel } from "./vendor/react/PetsSettingsPanel";
import type { PetStore } from "./vendor/react/petStore";
import { loadP3Pets } from "./petRuntime";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { Button } from "../ui/button";

import "./vendor/react/pets.css";

export function P3PetsSettings() {
  const [attempt, setAttempt] = useState(0);
  // A retry remounts the loader, which starts it again from a clean state.
  return <P3PetsSettingsLoader key={attempt} onRetry={() => setAttempt((value) => value + 1)} />;
}

function P3PetsSettingsLoader({ onRetry }: { onRetry: () => void }) {
  const [store, setStore] = useState<PetStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the pets IndexedDB store with cancellation on unmount.
  useEffect(() => {
    let cancelled = false;
    void loadP3Pets().then(
      (loaded) => {
        if (!cancelled) setStore(loaded);
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load pets.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <SettingsPageContainer>
      <div id="pets">
        {store ? (
          <PetsSettingsPanel store={store} />
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          <p role="status">Loading pets…</p>
        )}
      </div>
    </SettingsPageContainer>
  );
}
