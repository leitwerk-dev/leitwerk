:robot: I have created a release *beep* *boop*
---


<details><summary>@leitwerk-dev/coding: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/coding0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/dev-sandbox: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/dev-sandbox0.4.0) (2026-10-07)


### Features

* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/server bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/dev-tools: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/dev-tools0.4.0) (2026-10-07)


### Features

* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/server bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/ui bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/domain: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/domain0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
</details>

<details><summary>@leitwerk-dev/example-processes: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/example-processes0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **extensions:** Load @leitwerk-dev/example-processes for the single-prompt and Kubernetes smoke processes. Move file_triggers.complete_prompt_path from extensions.showcase-processes to extensions.example-processes. Existing process, launcher, renderer, and external-source IDs remain unchanged.

### Features

* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Refactoring

* **extensions:** separate poem creator from example processes ([#141](https://github.com/leitwerk-dev/leitwerk/issues/141)) ([4504270](https://github.com/leitwerk-dev/leitwerk/commit/45042700483f5136c154cccda1a704a670a059ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/extension-runtime: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/extension-runtime0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **process-sdk:** Invalid process declarations now fail during defineProcess or fluent definition instead of catalog loading or server setup.

### Features

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** replace dependency read-pkg-up with read-package-up ^11.0.0 ([#124](https://github.com/leitwerk-dev/leitwerk/issues/124)) ([98078ae](https://github.com/leitwerk-dev/leitwerk/commit/98078aec02ee5bb0068a8413981dc81e2ab96318))
* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **process-sdk:** unify process definition validity ([#142](https://github.com/leitwerk-dev/leitwerk/issues/142)) ([f34487d](https://github.com/leitwerk-dev/leitwerk/commit/f34487dc4c96a27c4ad610782c411fcd79ebb33e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/external-writes: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/external-writes0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/forgejo: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/forgejo0.4.0) (2026-10-07)


### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/forgejo-repo-change: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/forgejo-repo-change0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/git-ssh bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/forgejo bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/woodpecker bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/git-ssh: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/git-ssh0.4.0) (2026-10-07)


### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/github: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/github0.4.0) (2026-10-07)


### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/github-repo-change: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/github-repo-change0.4.0) (2026-10-07)


### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/git-ssh bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/github bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/gitlab: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/gitlab0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **gitlab:** MR comment tools and discussion resolve ([#120](https://github.com/leitwerk-dev/leitwerk/issues/120)) ([902ca63](https://github.com/leitwerk-dev/leitwerk/commit/902ca6300b3c704c9f54d011a63a39b6ec133233))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/gitlab-repo-change: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/gitlab-repo-change0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/gitlab bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/git-ssh bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/jira: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/jira0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/wiki bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/jira-gitlab-change: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/jira-gitlab-change0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/coding bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/gitlab bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/git-ssh bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/jira bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/wiki bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/jira-issue-split: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/jira-issue-split0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/jira bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/gitlab bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/git-ssh bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/jira-gitlab-change bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/wiki bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/server bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/mattpocock-skills: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/mattpocock-skills0.4.0) (2026-10-07)


### Features

* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/dev-tools bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/models: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/models0.4.0) (2026-10-07)


### Features

* **models:** support request-wide token pricing tiers ([#187](https://github.com/leitwerk-dev/leitwerk/issues/187)) ([0dcbe3e](https://github.com/leitwerk-dev/leitwerk/commit/0dcbe3e8f7a5f17c7114c12598fb6223c4e436b9))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))
* **deps:** update runtime npm dependencies ([#139](https://github.com/leitwerk-dev/leitwerk/issues/139)) ([e6cb2e1](https://github.com/leitwerk-dev/leitwerk/commit/e6cb2e1e67fdd90c77d4cbca419c8474a90f3455))
* **deps:** update runtime npm dependencies ([#192](https://github.com/leitwerk-dev/leitwerk/issues/192)) ([6e29c90](https://github.com/leitwerk-dev/leitwerk/commit/6e29c90c1678e37e1190a1d03111cd8961159ff9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/pi-session-transfer: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/pi-session-transfer0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/session-transfer bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/process-analysis: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/process-analysis0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/process-sdk: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/process-sdk0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **process-sdk:** Replace flow.llm(...).forEach(...) with flow.mappedLlm<Params, State, Item, Result>(turnId, items).
* **process-sdk:** Invalid process declarations now fail during defineProcess or fluent definition instead of catalog loading or server setup.

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **process-sdk:** unify process definition validity ([#142](https://github.com/leitwerk-dev/leitwerk/issues/142)) ([f34487d](https://github.com/leitwerk-dev/leitwerk/commit/f34487dc4c96a27c4ad610782c411fcd79ebb33e))


### Refactoring

* **process-sdk:** separate mapped LLM authoring ([#144](https://github.com/leitwerk-dev/leitwerk/issues/144)) ([be2399a](https://github.com/leitwerk-dev/leitwerk/commit/be2399a3fd10499538cc0357f3d2c753dc5552cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/protocol: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/protocol0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/server: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/server0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **process-sdk:** Replace flow.llm(...).forEach(...) with flow.mappedLlm<Params, State, Item, Result>(turnId, items).
* **process-sdk:** Invalid process declarations now fail during defineProcess or fluent definition instead of catalog loading or server setup.

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))
* **deps:** update runtime npm dependencies ([#139](https://github.com/leitwerk-dev/leitwerk/issues/139)) ([e6cb2e1](https://github.com/leitwerk-dev/leitwerk/commit/e6cb2e1e67fdd90c77d4cbca419c8474a90f3455))
* **deps:** update runtime npm dependencies ([#192](https://github.com/leitwerk-dev/leitwerk/issues/192)) ([6e29c90](https://github.com/leitwerk-dev/leitwerk/commit/6e29c90c1678e37e1190a1d03111cd8961159ff9))
* **process-sdk:** unify process definition validity ([#142](https://github.com/leitwerk-dev/leitwerk/issues/142)) ([f34487d](https://github.com/leitwerk-dev/leitwerk/commit/f34487dc4c96a27c4ad610782c411fcd79ebb33e))


### Refactoring

* **process-sdk:** separate mapped LLM authoring ([#144](https://github.com/leitwerk-dev/leitwerk/issues/144)) ([be2399a](https://github.com/leitwerk-dev/leitwerk/commit/be2399a3fd10499538cc0357f3d2c753dc5552cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/session-transfer bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-runners bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/wiki bumped from 0.3.1 to 0.4.0
  * optionalDependencies
    * @leitwerk-dev/worker bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/session-transfer: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/session-transfer0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
</details>

<details><summary>@leitwerk-dev/showcase-processes: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/showcase-processes0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **extensions:** Load @leitwerk-dev/example-processes for the single-prompt and Kubernetes smoke processes. Move file_triggers.complete_prompt_path from extensions.showcase-processes to extensions.example-processes. Existing process, launcher, renderer, and external-source IDs remain unchanged.

### Features

* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Refactoring

* **extensions:** separate poem creator from example processes ([#141](https://github.com/leitwerk-dev/leitwerk/issues/141)) ([4504270](https://github.com/leitwerk-dev/leitwerk/commit/45042700483f5136c154cccda1a704a670a059ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/telegram: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/telegram0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/test-support: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/test-support0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))
* **deps:** update runtime npm dependencies ([#139](https://github.com/leitwerk-dev/leitwerk/issues/139)) ([e6cb2e1](https://github.com/leitwerk-dev/leitwerk/commit/e6cb2e1e67fdd90c77d4cbca419c8474a90f3455))
* **deps:** update runtime npm dependencies ([#192](https://github.com/leitwerk-dev/leitwerk/issues/192)) ([6e29c90](https://github.com/leitwerk-dev/leitwerk/commit/6e29c90c1678e37e1190a1d03111cd8961159ff9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/server bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/ticket-creation: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/ticket-creation0.4.0) (2026-10-07)


### Features

* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/ui: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/ui0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.

### Features

* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/wiki bumped from 0.3.1 to 0.4.0
  * devDependencies
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/watcher-utils: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/watcher-utils0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/external-writes bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/wiki: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/wiki0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/woodpecker: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/woodpecker0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/test-support bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/worker: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/worker0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))

### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))
* **deps:** update runtime npm dependencies ([#139](https://github.com/leitwerk-dev/leitwerk/issues/139)) ([e6cb2e1](https://github.com/leitwerk-dev/leitwerk/commit/e6cb2e1e67fdd90c77d4cbca419c8474a90f3455))
* **deps:** update runtime npm dependencies ([#192](https://github.com/leitwerk-dev/leitwerk/issues/192)) ([6e29c90](https://github.com/leitwerk-dev/leitwerk/commit/6e29c90c1678e37e1190a1d03111cd8961159ff9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/extension-runtime bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/process-sdk bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/worker-protocol: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/worker-protocol0.4.0) (2026-10-07)


### Features

* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/protocol bumped from 0.3.1 to 0.4.0
</details>

<details><summary>@leitwerk-dev/worker-runners: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...@leitwerk-dev/worker-runners0.4.0) (2026-10-07)


### Bug Fixes

* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @leitwerk-dev/domain bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/session-transfer bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/watcher-utils bumped from 0.3.1 to 0.4.0
    * @leitwerk-dev/worker-protocol bumped from 0.3.1 to 0.4.0
</details>

<details><summary>v: 0.4.0</summary>

## [0.4.0](https://github.com/leitwerk-dev/leitwerk/compare/v0.3.1...v0.4.0) (2026-10-07)


###   BREAKING CHANGES

* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189))
* **process-sdk:** External transitions to worker turns must target a turn declaring .waitFor(predicate). Move read-only readiness checks into that callback; keep external writes in executing turns or durable server delivery. See docs/process-sdk.md for migration guidance.
* **process-sdk:** Replace flow.llm(...).forEach(...) with flow.mappedLlm<Params, State, Item, Result>(turnId, items).
* **process-sdk:** Invalid process declarations now fail during defineProcess or fluent definition instead of catalog loading or server setup.
* **extensions:** Load @leitwerk-dev/example-processes for the single-prompt and Kubernetes smoke processes. Move file_triggers.complete_prompt_path from extensions.showcase-processes to extensions.example-processes. Existing process, launcher, renderer, and external-source IDs remain unchanged.

### Features

* **gitlab:** MR comment tools and discussion resolve ([#120](https://github.com/leitwerk-dev/leitwerk/issues/120)) ([902ca63](https://github.com/leitwerk-dev/leitwerk/commit/902ca6300b3c704c9f54d011a63a39b6ec133233))
* **inspector:** retain execution evidence and expose inspection APIs ([#116](https://github.com/leitwerk-dev/leitwerk/issues/116)) ([9f41a49](https://github.com/leitwerk-dev/leitwerk/commit/9f41a49ac409d1ea9abc90da067814826b997c45))
* **inspector:** unify process inspection and edit model defaults ([#117](https://github.com/leitwerk-dev/leitwerk/issues/117)) ([e19aff9](https://github.com/leitwerk-dev/leitwerk/commit/e19aff94880acdc85f673e152d30814a8bdb7452))
* **jira:** coordinate GitLab changes with workflow bypasses ([#129](https://github.com/leitwerk-dev/leitwerk/issues/129)) ([08ad702](https://github.com/leitwerk-dev/leitwerk/commit/08ad702c355774baae5cf0e42314ed56dc450b25))
* **jira:** coordinate issue splits and resilient GitLab delivery ([#189](https://github.com/leitwerk-dev/leitwerk/issues/189)) ([506b48b](https://github.com/leitwerk-dev/leitwerk/commit/506b48bb7b6e832f96b6d51c3b47c0e147dd5ff2))
* **jira:** split epics with a shared solution wiki ([#134](https://github.com/leitwerk-dev/leitwerk/issues/134)) ([2a35f67](https://github.com/leitwerk-dev/leitwerk/commit/2a35f672085a95f1ad38de806e16d3a5abe4db2b))
* **models:** support request-wide token pricing tiers ([#187](https://github.com/leitwerk-dev/leitwerk/issues/187)) ([0dcbe3e](https://github.com/leitwerk-dev/leitwerk/commit/0dcbe3e8f7a5f17c7114c12598fb6223c4e436b9))
* **process-sdk:** gate worker turns on server readiness ([c50bd5d](https://github.com/leitwerk-dev/leitwerk/commit/c50bd5d098d43255da0e7e118a041d0c966578ae))
* **settings:** persist scoped defaults and capture turn settings ([#118](https://github.com/leitwerk-dev/leitwerk/issues/118)) ([ae26b51](https://github.com/leitwerk-dev/leitwerk/commit/ae26b51c7685c904e657aa15ea5024c471630736))
* **skills:** package adapted skill repositories as extensions ([#155](https://github.com/leitwerk-dev/leitwerk/issues/155)) ([050a860](https://github.com/leitwerk-dev/leitwerk/commit/050a860b016a00db2eab6ceec31bf21885a6165f))
* **ticket-creation:** add GitHub, GitLab and Jira adapters ([#136](https://github.com/leitwerk-dev/leitwerk/issues/136)) ([f94fc0f](https://github.com/leitwerk-dev/leitwerk/commit/f94fc0f7a0263136b00a618fa83fc85440e99095))


### Bug Fixes

* **deps:** replace dependency read-pkg-up with read-package-up ^11.0.0 ([#124](https://github.com/leitwerk-dev/leitwerk/issues/124)) ([98078ae](https://github.com/leitwerk-dev/leitwerk/commit/98078aec02ee5bb0068a8413981dc81e2ab96318))
* **deps:** update caddy docker tag to v2.11.3 ([#137](https://github.com/leitwerk-dev/leitwerk/issues/137)) ([b9ee359](https://github.com/leitwerk-dev/leitwerk/commit/b9ee3596b0bfed865691809ea78c5639026f04ec))
* **deps:** update caddy docker tag to v2.11.4 ([#191](https://github.com/leitwerk-dev/leitwerk/issues/191)) ([6586573](https://github.com/leitwerk-dev/leitwerk/commit/6586573d34ca3a3df4844f2f99c1570b8637559a))
* **deps:** update dependency esbuild to v0.28.2 ([#135](https://github.com/leitwerk-dev/leitwerk/issues/135)) ([6536a17](https://github.com/leitwerk-dev/leitwerk/commit/6536a1764fb1bf73cae6a0010b1f6fee34be9e83))
* **deps:** update dependency esbuild to v0.28.2 ([#140](https://github.com/leitwerk-dev/leitwerk/issues/140)) ([26f24d1](https://github.com/leitwerk-dev/leitwerk/commit/26f24d18844390f7ff6e82b9d4ef1429c3c65d3b))
* **deps:** update runtime npm dependencies ([#133](https://github.com/leitwerk-dev/leitwerk/issues/133)) ([cb62b11](https://github.com/leitwerk-dev/leitwerk/commit/cb62b111102cbd13e90d482faa5509e6afc69629))
* **deps:** update runtime npm dependencies ([#138](https://github.com/leitwerk-dev/leitwerk/issues/138)) ([20e090a](https://github.com/leitwerk-dev/leitwerk/commit/20e090af0c80770b714be34dbb76bd415880acaa))
* **deps:** update runtime npm dependencies ([#139](https://github.com/leitwerk-dev/leitwerk/issues/139)) ([e6cb2e1](https://github.com/leitwerk-dev/leitwerk/commit/e6cb2e1e67fdd90c77d4cbca419c8474a90f3455))
* **deps:** update runtime npm dependencies ([#192](https://github.com/leitwerk-dev/leitwerk/issues/192)) ([6e29c90](https://github.com/leitwerk-dev/leitwerk/commit/6e29c90c1678e37e1190a1d03111cd8961159ff9))
* **process-sdk:** unify process definition validity ([#142](https://github.com/leitwerk-dev/leitwerk/issues/142)) ([f34487d](https://github.com/leitwerk-dev/leitwerk/commit/f34487dc4c96a27c4ad610782c411fcd79ebb33e))


### Refactoring

* **extensions:** separate poem creator from example processes ([#141](https://github.com/leitwerk-dev/leitwerk/issues/141)) ([4504270](https://github.com/leitwerk-dev/leitwerk/commit/45042700483f5136c154cccda1a704a670a059ef))
* **process-sdk:** separate mapped LLM authoring ([#144](https://github.com/leitwerk-dev/leitwerk/issues/144)) ([be2399a](https://github.com/leitwerk-dev/leitwerk/commit/be2399a3fd10499538cc0357f3d2c753dc5552cd))
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).