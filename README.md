# P3 Code

A desktop, web and mobile workspace for coding agents, with projects, durable threads, and optional integrations.

![Status: maintained](https://img.shields.io/badge/status-maintained-brightgreen) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Created at [Exowatt](https://exowatt.com).

## About this fork

P3 Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code), originally created by T3 Tools Inc. It adds multi-environment workspaces, Phi support and other agent-workflow features. It is not affiliated with or endorsed by T3 Tools Inc. Upstream's own application-store listings and installers distribute T3 Code, **not** this fork.

## Status

Maintained by Exowatt. This source export is intended for self-hosting and development; do not assume upstream T3 releases or mobile-store apps contain these changes.

## Install

Install [Node.js 26](https://nodejs.org/), [pnpm 12](https://pnpm.io/) and [Vite+](https://viteplus.dev/guide/) (`vp`). Then clone this repository and run:

```sh
vp i
```

Install and authenticate at least one coding-agent provider separately (for example [Codex CLI](https://developers.openai.com/codex/cli) and `codex login`, or [Claude Code](https://claude.com/product/claude-code) and `claude auth login`). No Exowatt account or network service is required.

## Quickstart

```sh
vp run dev
```

Open the local address printed by the dev runner, create a project for a directory and start a thread. The web app connects to the local server. Consult [user guides](docs/user/install.md) for remote access and provider setup. For a production build, use `vp run build`. This fork's public source has desktop self-update disabled and does not distribute signed installers or mobile-store builds; do not use upstream distribution assets as P3 builds.

## Configuration

Provider binaries and models are set from the app's Settings or local environment. Phi is optional: its provider slot is discoverable by default, but no Phi process starts until you install its CLI and select it for a thread; its version feed and installer URL default to unset. Feads is optional: configure your own Feads URL and token in Settings or set `P3_FEADS_URL` and `P3_FEADS_TOKEN` on the server. Without a token no Feads calls run. The connector catalog includes only the local P3 MCP endpoint by default; other MCP endpoints are user-supplied.

## Privacy

This fork is self-hosted and sends no usage data to Exowatt by default. Your selected coding-agent provider receives what its agent sends, and optional integrations connect only when you configure them. No Exowatt privacy policy or terms apply to this source-only build; web/mobile policy links are absent unless a distributor explicitly configures its own policy URL. Hosted or app-store distribution needs its own policy and terms first.

## Prerequisites and notices

`@anthropic-ai/claude-agent-sdk` and `@cursor/sdk` are fetched npm dependencies, not vendored source or binaries. Their separate terms govern their use; do not redistribute those SDKs as part of a binary release without reviewing the vendor terms. The optional Android/web terminal includes upstream-inherited Ghostty MIT binaries and font assets; see [NOTICE](NOTICE) and the [mobile terminal notices](apps/mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md). The upstream iOS static Ghostty archives exceed this export's 10 MB source-file gate and are **not included**; iOS builders must rebuild the MIT library from its documented pinned source before compiling the native app. Building redistributable binaries requires a separate dependency/license review.

## License

MIT, including Exowatt modifications. Keep the original [LICENSE](LICENSE) and see [NOTICE](NOTICE) for upstream and third-party attributions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [org contributing guide](https://github.com/exowatt-oss/.github/blob/main/CONTRIBUTING.md). Sign off commits with `git commit -s` (DCO); no CLA.

## Security

Use [GitHub private vulnerability reporting](https://github.com/exowatt-oss/p3code/security/advisories/new), or contact software@exowatt.com. Do not report security vulnerabilities in public issues.
