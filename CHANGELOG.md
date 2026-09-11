# Changelog

## [0.2.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.1.9...v0.2.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* **ui:** load reasoning history on demand ([#51](https://github.com/leitwerk-dev/leitwerk/issues/51))
* **runtime:** migrate process execution and harden worker launch ([#34](https://github.com/leitwerk-dev/leitwerk/issues/34))

### Features

* **auth:** add personal and shared anonymous API tokens ([#47](https://github.com/leitwerk-dev/leitwerk/issues/47)) ([1b2d7ea](https://github.com/leitwerk-dev/leitwerk/commit/1b2d7ea154b9f50ae736bbf33f23e49d410ee8a8))
* **dev:** support installed extensions in development compositions ([#39](https://github.com/leitwerk-dev/leitwerk/issues/39)) ([c3d6a79](https://github.com/leitwerk-dev/leitwerk/commit/c3d6a795f5a416a91284667e8da8e3c34b4b8c6d))
* **dev:** support local sandboxes and recorded scripted sessions ([#56](https://github.com/leitwerk-dev/leitwerk/issues/56)) ([6632468](https://github.com/leitwerk-dev/leitwerk/commit/6632468b7ed9f064a9edf32709bb930da6a5a2f9))
* **release:** guard stable publication and add opt-in npm release candidates ([#41](https://github.com/leitwerk-dev/leitwerk/issues/41)) ([214e792](https://github.com/leitwerk-dev/leitwerk/commit/214e792343158ddf7c911f8d98bd2cd46290006f))
* **session-transfer:** transfer retained sessions to local Pi ([#35](https://github.com/leitwerk-dev/leitwerk/issues/35)) ([cea4811](https://github.com/leitwerk-dev/leitwerk/commit/cea481104785a58d2703fb1b11f6a3fbea5be295))
* **ui:** add Chronicle turn navigation and compact process views ([#57](https://github.com/leitwerk-dev/leitwerk/issues/57)) ([d725c4f](https://github.com/leitwerk-dev/leitwerk/commit/d725c4f4f8f885d66da62014da7b865d83f17ef0))
* **ui:** load reasoning history on demand ([#51](https://github.com/leitwerk-dev/leitwerk/issues/51)) ([eab497c](https://github.com/leitwerk-dev/leitwerk/commit/eab497c8a4ccb36bdaf254eedc7dc8cc03f58828))
* **workers:** support private Docker runtimes ([#36](https://github.com/leitwerk-dev/leitwerk/issues/36)) ([55fb9e2](https://github.com/leitwerk-dev/leitwerk/commit/55fb9e2749b4a64fa877c9c34fae21becd0ec9f5))


### Bug Fixes

* **ci:** restore browser installation and package validation ([#42](https://github.com/leitwerk-dev/leitwerk/issues/42)) ([b35dba4](https://github.com/leitwerk-dev/leitwerk/commit/b35dba4d5be5f91600f23a48cf2cad7d834ab55d))
* **ticket:** retain destination history across upgrades ([#49](https://github.com/leitwerk-dev/leitwerk/issues/49)) ([b6dc378](https://github.com/leitwerk-dev/leitwerk/commit/b6dc378d4b18365422a2a41520520b70a9a1f5b7))
* **ui:** keep ticket questions in reasoning flow ([#37](https://github.com/leitwerk-dev/leitwerk/issues/37)) ([ce9d9fc](https://github.com/leitwerk-dev/leitwerk/commit/ce9d9fca7cc585cbe7eeaca7dea6408876e189e6))
* **ui:** unify process controls and dialog presentation ([#55](https://github.com/leitwerk-dev/leitwerk/issues/55)) ([3d0dd9e](https://github.com/leitwerk-dev/leitwerk/commit/3d0dd9e0bccd15eb1e0e28e358016d89fbac4c1c))
* **worker:** isolate repository commands and enforce Docker runtime contracts ([#52](https://github.com/leitwerk-dev/leitwerk/issues/52)) ([97f0a87](https://github.com/leitwerk-dev/leitwerk/commit/97f0a87b33a8e7317e88ee43d514f2d5395edff7))


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
