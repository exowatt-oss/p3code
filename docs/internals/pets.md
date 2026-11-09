# P3 pets integration

P3 includes the MIT-licensed T3 Code Pets runtime from
https://github.com/RaymondWKWong/t3code-pets at commit
`7f9eae75256880362f7a53cd1f312a72a245f76b` (framework 1.0.0, Romeo 1.0.0).
The license is preserved under `apps/web/src/components/exowatt-pets/vendor/LICENSE`.

## Update boundary

The runtime is checked in under `apps/web/src/components/exowatt-pets/vendor`,
with upstream core/react tests. Package imports are relative and formatting follows
P3. P3 changes to the vendored implementation: `usePetAnimation` schedules at
100 ms rather than display-refresh requestAnimationFrame frequency. Hidden-window
and reduced-motion handling remain upstream behavior. Keep this delta when updating.

`romeo.t3pet` contains upstream's four unmodified files from `pets/romeo`, zipped
with a fixed 2000-01-01 timestamp. Vite emits the archive with a content hash and
resolves its URL relative to the app, so desktop and remote web clients load it
without localhost addresses or CDN dependencies. Archive validation runs before
installation, with size, manifest, path, file-type, and image-dimension checks.

P3 owns `petRuntime`, `P3PetsHost`, `PetsOverlay`, `P3PetsSettings`, `activity`, and
`useP3PetActivity`. The host is lazy loaded behind an error boundary. The only
thread integration is a hook call using ChatView's existing provider-independent
signals. The remaining integration points are the root host and Customize route and navigation, plus a redirect for the old Settings URL. No server protocol or provider adapter changes are needed.

These are ordinary files in P3's Exowatt patch stack, included in every build.
Do not run the upstream exact-commit installer or `t3-update` against P3. An upstream
T3 update rebases this patch through the existing distro pipeline. Compile the web
app and run the pets tests after rebasing; a changed thread contract is a type error,
not a silently skipped installation. Pet imports are data, never executable plugins.

## Updating the runtime or bundled pet

1. Fetch a reviewed upstream release/commit and record its SHA here.
2. Replace `vendor/core` and `vendor/react` from upstream `packages/*/src`, retain
   their focused tests and license, and convert core imports to `../core/index.js`.
3. Reapply the animation scheduling delta and P3 formatting. Keep host integration
   outside `vendor` so upstream runtime updates do not overwrite it.
4. Rebuild the bundled archive if Romeo changed; update exact dependency versions
   in the web package and regenerate the lockfile if required.
5. From `apps/web`, run `../../node_modules/.bin/vp test run --project unit
   src/components/exowatt-pets src/components/settings/settingsSearch.test.ts`,
   `../../node_modules/.bin/tsgo --noEmit`, and the production web build.

The existing web CI automatically includes these tests and sources. The bundle
lifecycle test validates the actual shipped archive and reopens the same database
without losing disabled state, size, or position. Upstream store tests verify
version upgrades and refusal to replace newer pets with older bundles.

Keep the IndexedDB name `t3code-pets` and its versioned migration contract stable.
Bundled initialization preserves user preferences and newer installed pet versions;
never reset the database as an update strategy. No pet state goes into the P3 server
or shared live SQLite database. Native mobile rendering is out of scope.
