import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  EXOWATT_DEV_SERVER_RESOURCE_DIR,
  EXOWATT_REMOTE_SERVER_HASH_SUFFIX,
  EXOWATT_REMOTE_SERVER_RESOURCE_DIR,
  parseExowattRemoteServerArchiveVersion,
  parseExowattRemoteServerHash,
  resolveExowattDevRemoteServerSource,
  resolveExowattRemoteServerArchiveName,
  resolveExowattRemoteServerSource,
  resolveExowattRemoteServerSourceForEnvironment,
} from "./ExowattRemoteServerSource.ts";

const SHA = "c".repeat(64);

describe("ExowattRemoteServerSource", () => {
  it("names the archive like npm pack does for the server package", () => {
    assert.equal(resolveExowattRemoteServerArchiveName("0.0.37"), "t3-0.0.37.tgz");
    assert.deepStrictEqual(
      parseExowattRemoteServerArchiveVersion("t3-0.0.0-dev.abc1234.tgz"),
      Option.some("0.0.0-dev.abc1234"),
    );
    assert.deepStrictEqual(parseExowattRemoteServerArchiveVersion("t3-.tgz"), Option.none());
    assert.deepStrictEqual(
      parseExowattRemoteServerArchiveVersion("other-1.0.0.tgz"),
      Option.none(),
    );
  });

  it("parses shasum-style sidecars and rejects junk", () => {
    assert.deepStrictEqual(
      parseExowattRemoteServerHash(`${SHA.toUpperCase()}  t3-0.0.37.tgz\n`),
      Option.some(SHA),
    );
    assert.deepStrictEqual(parseExowattRemoteServerHash("not-a-hash\n"), Option.none());
    assert.deepStrictEqual(parseExowattRemoteServerHash(""), Option.none());
  });

  it.effect("resolves none when the build ships no server tarball", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resourcesPath = yield* fs.makeTempDirectoryScoped({ prefix: "p3-resources-" });
      const source = yield* resolveExowattRemoteServerSource({
        resourcesPath,
        appVersion: "0.0.37",
      });
      assert.isTrue(Option.isNone(source));
      // A packaged build without the resource resolves to null: the prepare hook
      // then still refuses upstream's npx path instead of installing anything.
      const forEnvironment = yield* resolveExowattRemoteServerSourceForEnvironment({
        isDevelopment: false,
        resourcesPath,
        appVersion: "0.0.37",
        rootDir: resourcesPath,
      });
      assert.isNull(forEnvironment);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("dev builds pick the newest packed dev tarball and ignore release-shaped ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "p3-worktree-" });
      const dir = path.join(rootDir, EXOWATT_DEV_SERVER_RESOURCE_DIR);
      yield* fs.makeDirectory(dir, { recursive: true });
      assert.isTrue(Option.isNone(yield* resolveExowattDevRemoteServerSource({ rootDir })));

      const write = (name: string, withHash: boolean) =>
        Effect.gen(function* () {
          yield* fs.writeFile(path.join(dir, name), new Uint8Array([1]));
          if (withHash) {
            yield* fs.writeFileString(
              path.join(dir, `${name}${EXOWATT_REMOTE_SERVER_HASH_SUFFIX}`),
              `${SHA}  ${name}\n`,
            );
          }
        });
      yield* write("t3-0.0.0-dev.1111111.tgz", true);
      yield* write("t3-0.0.0-dev.9999999.tgz", false); // no sidecar: skipped
      yield* write("t3-0.0.37-exowatt.15.tgz", true); // release tarball: never a dev push

      const source = yield* resolveExowattDevRemoteServerSource({ rootDir });
      assert.isTrue(Option.isSome(source));
      if (Option.isNone(source)) return;
      assert.equal(source.value.version, "0.0.0-dev.1111111");
      assert.equal(source.value.archiveName, "t3-0.0.0-dev.1111111.tgz");

      const forEnvironment = yield* resolveExowattRemoteServerSourceForEnvironment({
        isDevelopment: true,
        resourcesPath: "/nonexistent",
        appVersion: "0.0.36",
        rootDir,
      });
      assert.equal(forEnvironment?.version, "0.0.0-dev.1111111");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the bundled tarball pinned to the desktop version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped({ prefix: "p3-resources-" });
      const dir = path.join(resourcesPath, EXOWATT_REMOTE_SERVER_RESOURCE_DIR);
      yield* fs.makeDirectory(dir, { recursive: true });
      const archive = path.join(dir, "t3-0.0.37.tgz");
      yield* fs.writeFile(archive, new Uint8Array([9, 8, 7]));
      yield* fs.writeFileString(
        `${archive}${EXOWATT_REMOTE_SERVER_HASH_SUFFIX}`,
        `${SHA}  t3-0.0.37.tgz\n`,
      );

      const source = yield* resolveExowattRemoteServerSource({
        resourcesPath,
        appVersion: "0.0.37",
      });
      assert.isTrue(Option.isSome(source));
      if (Option.isNone(source)) return;
      assert.equal(source.value.version, "0.0.37");
      assert.equal(source.value.sha256, SHA);
      assert.equal(source.value.archiveName, "t3-0.0.37.tgz");
      assert.deepStrictEqual(Array.from(yield* source.value.read), [9, 8, 7]);

      // A different desktop version must not pick up this tarball.
      const other = yield* resolveExowattRemoteServerSource({
        resourcesPath,
        appVersion: "0.0.38",
      });
      assert.isTrue(Option.isNone(other));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a tarball whose hash sidecar is missing or malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped({ prefix: "p3-resources-" });
      const dir = path.join(resourcesPath, EXOWATT_REMOTE_SERVER_RESOURCE_DIR);
      yield* fs.makeDirectory(dir, { recursive: true });
      const archive = path.join(dir, "t3-0.0.37.tgz");
      yield* fs.writeFile(archive, new Uint8Array([1]));
      assert.isTrue(
        Option.isNone(
          yield* resolveExowattRemoteServerSource({ resourcesPath, appVersion: "0.0.37" }),
        ),
      );
      yield* fs.writeFileString(`${archive}${EXOWATT_REMOTE_SERVER_HASH_SUFFIX}`, "garbage\n");
      assert.isTrue(
        Option.isNone(
          yield* resolveExowattRemoteServerSource({ resourcesPath, appVersion: "0.0.37" }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
