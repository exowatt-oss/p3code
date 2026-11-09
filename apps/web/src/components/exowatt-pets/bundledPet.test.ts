// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";
import { validatePetArchive } from "./vendor/core/archive";
import { createIndexedDbPetStore, ensureBundledPet } from "./vendor/react/indexedDbPetStore";

const bundledPet = () => NodeFSP.readFile(new URL("./romeo.t3pet", import.meta.url));

describe("P3 bundled pet lifecycle", () => {
  it("ships a valid Romeo archive with both directional atlases", async () => {
    const result = await validatePetArchive(await bundledPet());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.manifest.id).toBe("romeo-golden-british-shorthair");
    expect(result.value.files.size).toBe(4);
  });
  it("preserves disabled state, position, and size across app restarts and repeated bundle initialization", async () => {
    const database = new IDBFactory();
    const first = createIndexedDbPetStore(database);
    const bytes = await bundledPet();
    await ensureBundledPet(first, bytes);
    const preferences = {
      ...(await first.readPreferences()),
      enabled: false,
      petSize: 0.75,
      position: { x: 90, y: 100 },
    };
    await first.writePreferences(preferences);
    const reopened = createIndexedDbPetStore(database);
    await ensureBundledPet(reopened, bytes);
    expect(await reopened.readPreferences()).toEqual(preferences);
    expect(await reopened.list()).toHaveLength(1);
  });
});
