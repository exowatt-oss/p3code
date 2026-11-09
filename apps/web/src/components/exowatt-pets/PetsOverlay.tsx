import { useEffect, useSyncExternalStore } from "react";
import { PetHost } from "./vendor/react/PetHost";
import { getP3PetStore, loadP3Pets, subscribeP3Pets } from "./petRuntime";
import "./vendor/react/pets.css";

export default function PetsOverlay() {
  const store = useSyncExternalStore(subscribeP3Pets, getP3PetStore, getP3PetStore);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the pets IndexedDB store once while mounted.
  useEffect(() => {
    void loadP3Pets().catch(() => {
      /* Settings exposes failures and offers retry. */
    });
  }, []);
  return store ? <PetHost store={store} /> : null;
}
