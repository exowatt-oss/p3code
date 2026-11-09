import { createIndexedDbPetStore, ensureBundledPet } from "./vendor/react/indexedDbPetStore";
import type { PetStore } from "./vendor/react/petStore";

let store: PetStore | undefined;
let readyStore: PetStore | null = null;
const listeners = new Set<() => void>();
export const getP3PetStore = () => readyStore;
export const subscribeP3Pets = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
let initialization: Promise<PetStore> | undefined;

/** One store per renderer; its database name and schema survive P3 releases. */
export function loadP3Pets(): Promise<PetStore> {
  initialization ??= (async () => {
    store ??= createIndexedDbPetStore();
    const response = await fetch(new URL("./romeo.t3pet", import.meta.url));
    if (!response.ok) throw new Error(`Could not load Romeo (${response.status}).`);
    await ensureBundledPet(store, new Uint8Array(await response.arrayBuffer()));
    readyStore = store;
    for (const listener of listeners) listener();
    return store;
  })().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
