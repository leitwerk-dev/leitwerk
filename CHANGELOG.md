# Changelog

## [0.2.1](https://github.com/leitwerk-dev/leitwerk/compare/v0.2.0...v0.2.1) (2026-09-21)


### Features

* **api:** classify supported APIs and enforce checks in CI ([#90](https://github.com/leitwerk-dev/leitwerk/issues/90)) ([95c8c9e](https://github.com/leitwerk-dev/leitwerk/commit/95c8c9eb8fb749f7e3634a53d80c874ebe261c2d))
* **runtime:** support gVisor Docker and GitLab merge repair ([#93](https://github.com/leitwerk-dev/leitwerk/issues/93)) ([4281f93](https://github.com/leitwerk-dev/leitwerk/commit/4281f93bca0f57384b8f6658494f0a37455348de))


### Bug Fixes

* **release:** make npm and immutable release publication resumable ([#92](https://github.com/leitwerk-dev/leitwerk/issues/92)) ([25cd628](https://github.com/leitwerk-dev/leitwerk/commit/25cd62870d03353e6c83da60e178f43bc2264817))

## [0.2.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.9...v0.2.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **ui:** load reasoning history on demand ([#51](https://github.com/leitwerk-dev/leitwerk/issues/51))
* **runtime:** migrate process execution and harden worker launch ([#34](https://github.com/leitwerk-dev/leitwerk/issues/34))

### Features

* **auth:** add personal and shared anonymous API tokens ([#47](https://github.com/leitwerk-dev/leitwerk/issues/47)) ([1b2d7ea](https://github.com/leitwerk-dev/leitwerk/commit/1b2d7ea154b9f50ae736bbf33f23e49d410ee8a8))
* **chronicle:** preserve process history and optional reporting ([#64](https://github.com/leitwerk-dev/leitwerk/issues/64)) ([62cbf6c](https://github.com/leitwerk-dev/leitwerk/commit/62cbf6ca7127d9fcb691efc0ed250d298c1ab92a))
* **dev-tools:** share development and worker diagnostics ([#81](https://github.com/leitwerk-dev/leitwerk/issues/81)) ([aa95eef](https://github.com/leitwerk-dev/leitwerk/commit/aa95eef17407479d726a85bd864a0006e4ea381a))
* **dev:** support installed extensions in development compositions ([#39](https://github.com/leitwerk-dev/leitwerk/issues/39)) ([c3d6a79](https://github.com/leitwerk-dev/leitwerk/commit/c3d6a795f5a416a91284667e8da8e3c34b4b8c6d))
* **dev:** support local sandboxes and recorded scripted sessions ([#56](https://github.com/leitwerk-dev/leitwerk/issues/56)) ([6632468](https://github.com/leitwerk-dev/leitwerk/commit/6632468b7ed9f064a9edf32709bb930da6a5a2f9))
* **forgejo-repo-change:** add PR delivery and provider sandbox ([#78](https://github.com/leitwerk-dev/leitwerk/issues/78)) ([f3558a0](https://github.com/leitwerk-dev/leitwerk/commit/f3558a01b5500a2545f88931f4d9300ba64e1252))
* **github:** consolidate organization issue workflows and durable delivery ([#83](https://github.com/leitwerk-dev/leitwerk/issues/83)) ([0df0e45](https://github.com/leitwerk-dev/leitwerk/commit/0df0e456fff7e397cb56ed6005cfda1d274ea0ec))
* **gitlab:** add API integration and scoped HTTPS Git credentials ([#79](https://github.com/leitwerk-dev/leitwerk/issues/79)) ([03c0e47](https://github.com/leitwerk-dev/leitwerk/commit/03c0e47b02ece1c0126ca652ac5dbb2cc60cbc96))
* **integrations:** add Forgejo, GitHub and Woodpecker with local adapters ([#77](https://github.com/leitwerk-dev/leitwerk/issues/77)) ([5dc4834](https://github.com/leitwerk-dev/leitwerk/commit/5dc4834d16d6269f294482da672659593a10a5c1))
* Introduce a shared helper for consistent external links ([#53](https://github.com/leitwerk-dev/leitwerk/issues/53)) ([1e07fdb](https://github.com/leitwerk-dev/leitwerk/commit/1e07fdb68b1e938e580454d3b183c5cb3824bcc4))
* **kubernetes:** optionally pre-provision process volumes ([#62](https://github.com/leitwerk-dev/leitwerk/issues/62)) ([fb8fd77](https://github.com/leitwerk-dev/leitwerk/commit/fb8fd774881d8acd096238ce545f4964634e5000))
* **release:** guard stable publication and add opt-in npm release candidates ([#41](https://github.com/leitwerk-dev/leitwerk/issues/41)) ([214e792](https://github.com/leitwerk-dev/leitwerk/commit/214e792343158ddf7c911f8d98bd2cd46290006f))
* **runtime:** harden worker capacity and Docker infrastructure ([#88](https://github.com/leitwerk-dev/leitwerk/issues/88)) ([0bb6ca1](https://github.com/leitwerk-dev/leitwerk/commit/0bb6ca1a2a65ab6623bc959a3e18ac81e269e0a8))
* **sandbox:** add shared harness, ticket creation and rebase support ([#76](https://github.com/leitwerk-dev/leitwerk/issues/76)) ([698547c](https://github.com/leitwerk-dev/leitwerk/commit/698547c8d84433e0675eae67a4f39e4f906f1c78))
* **session-transfer:** transfer retained sessions to local Pi ([#35](https://github.com/leitwerk-dev/leitwerk/issues/35)) ([cea4811](https://github.com/leitwerk-dev/leitwerk/commit/cea481104785a58d2703fb1b11f6a3fbea5be295))
* **startup:** preserve startup transparency alongside Chronicle navigation ([#63](https://github.com/leitwerk-dev/leitwerk/issues/63)) ([32f463b](https://github.com/leitwerk-dev/leitwerk/commit/32f463bca15079c4afcddc1cfd411db075d1a4b3))
* **storage:** support process-specific volume sizes ([0b95a41](https://github.com/leitwerk-dev/leitwerk/commit/0b95a41cc65feba9b688773b105c564351ea4b07))
* support resilient GitLab repair workflows ([#85](https://github.com/leitwerk-dev/leitwerk/issues/85)) ([b0e0f7f](https://github.com/leitwerk-dev/leitwerk/commit/b0e0f7fc5eed54564fcac2cf05a02695c7243901))
* **ui:** add Chronicle turn navigation and compact process views ([#57](https://github.com/leitwerk-dev/leitwerk/issues/57)) ([d725c4f](https://github.com/leitwerk-dev/leitwerk/commit/d725c4f4f8f885d66da62014da7b865d83f17ef0))
* **ui:** clarify history results and process summaries ([#73](https://github.com/leitwerk-dev/leitwerk/issues/73)) ([6668842](https://github.com/leitwerk-dev/leitwerk/commit/66688422160fbcdb9b7f765e9c989eb6a99fa6f7))
* **ui:** load reasoning history on demand ([#51](https://github.com/leitwerk-dev/leitwerk/issues/51)) ([eab497c](https://github.com/leitwerk-dev/leitwerk/commit/eab497c8a4ccb36bdaf254eedc7dc8cc03f58828))
* **workers:** support private Docker runtimes ([#36](https://github.com/leitwerk-dev/leitwerk/issues/36)) ([55fb9e2](https://github.com/leitwerk-dev/leitwerk/commit/55fb9e2749b4a64fa877c9c34fae21becd0ec9f5))


### Bug Fixes

* **ci:** restore browser installation and package validation ([#42](https://github.com/leitwerk-dev/leitwerk/issues/42)) ([b35dba4](https://github.com/leitwerk-dev/leitwerk/commit/b35dba4d5be5f91600f23a48cf2cad7d834ab55d))
* **session-transfer:** admit and execute retained-session exporters ([#72](https://github.com/leitwerk-dev/leitwerk/issues/72)) ([c5aa578](https://github.com/leitwerk-dev/leitwerk/commit/c5aa578db81f86584ae98d6d5b7884077460e1d0))
* **ticket:** retain destination history across upgrades ([#49](https://github.com/leitwerk-dev/leitwerk/issues/49)) ([b6dc378](https://github.com/leitwerk-dev/leitwerk/commit/b6dc378d4b18365422a2a41520520b70a9a1f5b7))
* **ui:** align layouts across browser engines ([#84](https://github.com/leitwerk-dev/leitwerk/issues/84)) ([8ed8f96](https://github.com/leitwerk-dev/leitwerk/commit/8ed8f964a011714a557c56144ef556e8a67446c4))
* **ui:** keep repeated external waits after the latest turn ([#86](https://github.com/leitwerk-dev/leitwerk/issues/86)) ([01952f1](https://github.com/leitwerk-dev/leitwerk/commit/01952f15fea489aca72d1eddc561c777f1c1fc95))
* **ui:** keep ticket questions in reasoning flow ([#37](https://github.com/leitwerk-dev/leitwerk/issues/37)) ([ce9d9fc](https://github.com/leitwerk-dev/leitwerk/commit/ce9d9fca7cc585cbe7eeaca7dea6408876e189e6))
* **ui:** unify process controls and dialog presentation ([#55](https://github.com/leitwerk-dev/leitwerk/issues/55)) ([3d0dd9e](https://github.com/leitwerk-dev/leitwerk/commit/3d0dd9e0bccd15eb1e0e28e358016d89fbac4c1c))
* **worker:** isolate repository commands and enforce Docker runtime contracts ([#52](https://github.com/leitwerk-dev/leitwerk/issues/52)) ([97f0a87](https://github.com/leitwerk-dev/leitwerk/commit/97f0a87b33a8e7317e88ee43d514f2d5395edff7))
* **worker:** keep startup reconnects alive and retain diagnostics ([#66](https://github.com/leitwerk-dev/leitwerk/issues/66)) ([84cfa5a](https://github.com/leitwerk-dev/leitwerk/commit/84cfa5ae8dc36d1c45e0fc3479fa5426c5f091be))


### Refactoring

* **runtime:** migrate process execution and harden worker launch ([#34](https://github.com/leitwerk-dev/leitwerk/issues/34)) ([fd3337e](https://github.com/leitwerk-dev/leitwerk/commit/fd3337ea7ffa67f592cb219942ddea7a47362ebb))

## [0.1.9](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.8...v0.1.9) (2026-08-20)


### Features

* **process-sdk:** expand automatic process runtime ([#27](https://github.com/leitwerk-dev/leitwerk/issues/27)) ([c8cfc32](https://github.com/leitwerk-dev/leitwerk/commit/c8cfc3260bf4b3f31eb133ca54cb8a3525fdd899))
* show a user icon in the bottom of the sidebar ([#25](https://github.com/leitwerk-dev/leitwerk/issues/25)) ([5d6683d](https://github.com/leitwerk-dev/leitwerk/commit/5d6683ddc7042509808ed2540facf5e9a3d931db))
* **skills:** clarify imports and model availability ([#31](https://github.com/leitwerk-dev/leitwerk/issues/31)) ([58f8181](https://github.com/leitwerk-dev/leitwerk/commit/58f818125d3037fac5ed7d6425d3d75ccbc2bfa7))
* **ui:** improve mobile navigation and route scrolling ([#29](https://github.com/leitwerk-dev/leitwerk/issues/29)) ([6d3208c](https://github.com/leitwerk-dev/leitwerk/commit/6d3208cdd33029eed9961e1f05953824dfe94a9e))


### Bug Fixes

* **runtime:** harden worker lifecycle recovery ([#28](https://github.com/leitwerk-dev/leitwerk/issues/28)) ([0b06cc4](https://github.com/leitwerk-dev/leitwerk/commit/0b06cc4f131f6369ea5c764389b2be52d689f7b3))

## [0.1.8](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.7...v0.1.8) (2026-08-12)


### Features

* **deployment:** support portable private-runtime configuration ([#22](https://github.com/leitwerk-dev/leitwerk/issues/22)) ([8742b14](https://github.com/leitwerk-dev/leitwerk/commit/8742b148f92659ba0ac427c7568c4038602c1a9b))

## [0.1.7](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.6...v0.1.7) (2026-08-11)


### Features

* **auth:** add GitHub OAuth and gateway scheduling ([#21](https://github.com/leitwerk-dev/leitwerk/issues/21)) ([3f7df7d](https://github.com/leitwerk-dev/leitwerk/commit/3f7df7d6796fcfdb8dc381286a798a0678e1a65b))
* make process watchers extension owned ([#19](https://github.com/leitwerk-dev/leitwerk/issues/19)) ([92a7352](https://github.com/leitwerk-dev/leitwerk/commit/92a7352eb1b847475b9d385542051265188c717b))
* **process-sdk:** add remote integration tools ([#18](https://github.com/leitwerk-dev/leitwerk/issues/18)) ([ea6fbaa](https://github.com/leitwerk-dev/leitwerk/commit/ea6fbaa54d1e9cc25976dde4ff71fdb244dd4492))

## [0.1.6](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.5...v0.1.6) (2026-08-10)


### Bug Fixes

* **release:** add manual recovery trigger ([a1c1747](https://github.com/leitwerk-dev/leitwerk/commit/a1c1747a8cfff6aabb812f4c95c509a9a458719a))
* **release:** preserve release metadata in PR notes ([bc2c4c3](https://github.com/leitwerk-dev/leitwerk/commit/bc2c4c3bf6755cabe20ba37e6b9ae3ab3f2967e2))
* **ui:** avoid duplicate detail load on websocket connect ([#16](https://github.com/leitwerk-dev/leitwerk/issues/16)) ([075ed0b](https://github.com/leitwerk-dev/leitwerk/commit/075ed0b80136e9dbf096f5659196cd94a9283d2b))

## [0.1.5](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.4...v0.1.5) (2026-08-10)


### Features

* add safe singleton deployment preflight ([#14](https://github.com/leitwerk-dev/leitwerk/issues/14)) ([7adf287](https://github.com/leitwerk-dev/leitwerk/commit/7adf2877abc182a780b23de6df3ad5df83268ed1))


### Bug Fixes

* send runtime settings to automatic workers ([#12](https://github.com/leitwerk-dev/leitwerk/issues/12)) ([c88d883](https://github.com/leitwerk-dev/leitwerk/commit/c88d8832aceaa0091a5563c8c848eddc2df7c20a))

## [0.1.4](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.3...v0.1.4) (2026-08-10)


### Bug Fixes

* **release:** shorten publication critical path ([#10](https://github.com/leitwerk-dev/leitwerk/issues/10)) ([4d60fef](https://github.com/leitwerk-dev/leitwerk/commit/4d60fef3cfeb9fc199281f70d6eaca6a4db06b87))

## [0.1.3](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.2...v0.1.3) (2026-08-09)


### Bug Fixes

* **ci:** accept release commit sign-off ([f182b2b](https://github.com/leitwerk-dev/leitwerk/commit/f182b2b5274560012260fcbb25fd571714cfc3fd))
* **release:** recover tag preflight and disable telemetry ([3f33e63](https://github.com/leitwerk-dev/leitwerk/commit/3f33e6362b9f3a6ae22e583a86e86d9d81c4806e))
* **release:** speed up multi-architecture publication ([866e056](https://github.com/leitwerk-dev/leitwerk/commit/866e056e0558fadca61c4987c03a2d98a713ba0e))

## [0.1.2](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.1...v0.1.2) (2026-08-09)


### Bug Fixes

* **release:** derive Helm image version in test ([c0c9d07](https://github.com/leitwerk-dev/leitwerk/commit/c0c9d07ccb8d466656ee4e2358342036ffe87499))
* **release:** enforce lockstep release candidates ([6681a4a](https://github.com/leitwerk-dev/leitwerk/commit/6681a4aa6ee0dc8ebc105f4a0a72d15000255c50))

## [0.1.1](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.0...v0.1.1) (2026-08-09)


### Features

* add production Kubernetes and release automation ([ab3ac45](https://github.com/leitwerk-dev/leitwerk/commit/ab3ac45e80082f61fa9bb39968c91c845459b5f2))

## Changelog

Release Please maintains this file from Conventional Commits merged to `main`.
