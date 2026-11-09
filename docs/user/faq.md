# P3 Code FAQ

P3 Code is an independent, source-only fork of [T3 Code](https://github.com/pingdotgg/t3code), built at Exowatt. T3 Tools Inc. does not endorse or distribute this fork.

## Is P3 Code a coding-agent provider?

No. P3 Code is a workspace and interface for providers you install and authenticate separately, such as Codex, Claude Code, or Phi. Their subscriptions and terms are yours to manage.

## How do I install or update it?

[Build this fork from source](./install.md) and update from its own repository. Upstream `t3.codes` installers, npm packages, app-store listings and T3 Chat plans are for **T3 Code**, not P3 Code. No signed P3 installers or hosted app are currently published.

## Does it require an Exowatt account?

No. The local server and core coding-agent workflows work without Exowatt services. Phi and Feads are optional; provide your own binary or Feads URL and token if you choose to use them. See [Phi](./providers-phi.md) and [agent access](./agent-access.md).

## Can I connect multiple provider accounts?

P3 Code does not automate cycling accounts to evade provider limits. Only connect accounts in ways your provider permits; use separate profiles or machines when their terms require it.

## Can I use it remotely?

Yes. Run the P3 server on the machine that owns your projects and connect over your LAN or your own tailnet using pairing. See [remote access](./remote-access.md). Do not use upstream T3 Code's hosted site as a P3 client.

## Can I use it on a phone?

The mobile app is source code only. Build it with your own Android/iOS tooling, bundle identifiers and signing credentials; see [installation](./install.md) and the [mobile build guide](../../apps/mobile/README.md). Upstream App Store and Google Play builds do not contain this fork.

## Who receives my code and prompts?

Your selected provider receives what its agent sends; review that provider's privacy and subscription terms. Remote access or optional integrations add connections you configure. This fork makes no guarantee about third-party terms or provider data handling. Report security problems through [private vulnerability reporting](../../.github/SECURITY.md).
