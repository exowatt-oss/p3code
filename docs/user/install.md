# Install P3 Code from source

P3 Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code), not an upstream release. Upstream's `t3.codes` installers, package-manager distributions, and App Store / Google Play builds install **T3 Code**, not this fork. P3 Code does not currently publish prebuilt public installers or mobile store apps.

## Requirements

Install [Vite+ (`vp`)](https://vite.plus/), Git and an authenticated coding-agent provider CLI on your machine. The workspace pins Node 26.12.1 (via `vp`) and pnpm 12.14.0. No Exowatt service, account or credential is needed.

## Build and run

```bash
git clone https://github.com/exowatt-oss/p3code.git
cd p3code
vp i
vp run build
node apps/server/dist/bin.mjs --no-browser
```

Open the address printed by the server. A fresh server requires pairing before a remote client may connect. To run without affecting an existing installation, pass `--home-dir /path/to/empty/p3-home` and choose a free port with `--port 39731`.

The desktop shell can also be built locally with `vp run build:desktop`; native signed installers and mobile apps require platform tooling and your own distribution credentials. No public P3 mobile binary is available yet. For remote access options, see [remote access](./remote-access.md). For first-use configuration, see [Codex](./providers-codex.md), [Claude](./providers-claude.md) and [Phi](./providers-phi.md).

## Update

Fetch this fork's latest changes and repeat `vp i && vp run build`. Do not run an upstream T3 Code installer or package-manager update to upgrade P3 Code.
