# API cleanup classification

This ledger classifies every package-exposure finding in
`.leitwerk/api-explorer/reports/retention-reasons.md`. It records the reviewed
disposition from the cleanup handoff separately from the application source
changes.

Evidence snapshot:

- Analysis ID: `e5947706d763fb7f7d2bb421fdb997db426be22e62bbc6e0c2e9f7b8abf503b3`
- Catalog revision: `dc9cf6993e76650d4d0a35d1b51738acbc16e5d7`
- Findings: 137 package-exposure findings, all originally assessed as review-required.
- Consumer universe: `leitwerk`, `../leitwerk-rsnc`, `../leitwerk-public`, and `../leitwerk-private`.
- Coverage: incomplete for the core checkout. Unresolved imports include `ws`, UI CSS,
  the `elkjs` raw-loader import, and `@kubernetes/client-node` in Docker verification
  scripts. Positive usage is reliable; absence-based classifications remain subject
  to execution-time searches and validation.

`Reduce route` means remove the named export from the specified facade while keeping
the declaration or another required module route. `Retain` means the finding has a
consumer, runtime role, signature dependency, or useful testing purpose. `Delete`
means remove the declaration as well as its redundant exports. This ledger records
classification only and does not authorize commits; the current HEAD contains
the route reductions described by the cleanup handoff.

## Current remaining route candidates

The standalone explorer was queried at `http://127.0.0.1:4318` after the handoff
changes, using analysis ID `88582cda50dea207faa5cd59c18c337559316f650317d6cacd38e5a11f9ee7d0`.
It reports 20 `reduce-package-exposure` findings. These are route-level findings;
they do not imply that the declarations or implementations should be deleted.

| Current route/finding group | Disposition | Evidence or prerequisite |
|---|---|---|
| `@leitwerk-dev/forgejo/testing` / `LocalForgejoRepository` | Retain | Directly imported by `../leitwerk-private/sandbox/store.ts`; adapter/state signatures also require the declaration. |
| `@leitwerk-dev/process-sdk` / `FormDefinition`, `FormFieldDefinition` | Retain | These are the SDK's supported aliases used by form signatures and consumers. |
| `@leitwerk-dev/protocol/form-contract` / `ActionFormDefinition`, `ActionFormFieldDefinition` | Retain | Required forwarding route for the SDK aliases; the removable routes were the protocol ROOT exports, already removed. |
| SDK process-graph helpers (findings 13–18) | Retain | Server forwarding and ticket-creation/process-graph runtime consumers use them. |
| `ModelProfileSnapshot` at protocol ROOT | Retain | Server model-provider and app code import the ROOT route. |
| `ModelProfileSnapshot` at `/config-snapshot` | Retain for now | `packages/server/src/config/config-types.ts` still imports this route as `ModelProfile`; migrate that import before reducing the route. |
| launcher contract types (findings 90–92) | Retain | SDK launcher forwarding and `extension-api.ts` exported signatures require them. |
| `cloneUsageSnapshot` at protocol ROOT | Retain | UI forwards it as `cloneTurnUsageSnapshot`, and `primary-path-detail.ts` calls it. |
| `FakeLlmProvider` at `/fakes` | Reduce route | Remove the redundant `/fakes` route while retaining the ROOT route used by RSNC and tests. |
| worker-runner factories (findings 133–137) | Retain | `packages/server/src/app.ts` dynamically imports local, Docker, Docker-client, Kubernetes, and Kubernetes-client entries. |

Coverage is still incomplete and the private installation is still incompatible
with the catalog's core revision (`0.1.9` versus `0.2.0`). Absence-based
endorsements therefore remain provisional until the execution-time searches,
builds, and installation checks in `API_CLEANUP_STRATEGY.md` pass. The current
`npm run test:full` attempt did not reach build/typecheck/tests: lint stopped on
unrelated existing issues in `extensions/showcase-processes` and
`tools/api-explorer-prototype`.

| # | Finding | Package | Disposition | Execution note |
|---:|---|---|---|---|
| 1 | `LocalForgejoOptions` | `@leitwerk-dev/forgejo` | Reduce route | Reduce `/testing`; preserve the adapter signature and module access. |
| 2 | `LocalForgejoRepository` | `@leitwerk-dev/forgejo` | Retain | Keep `/testing`; directly imported by `../leitwerk-private/sandbox/store.ts`. |
| 3 | `LocalGitHubOptions` | `@leitwerk-dev/github` | Reduce route | Reduce `/testing`; preserve adapter signatures and module access. |
| 4 | `LocalGitHubRepository` | `@leitwerk-dev/github` | Reduce route | Reduce `/testing`; preserve adapter signatures and module access. |
| 5 | `GitLabClientLike` | `@leitwerk-dev/gitlab` | Reduce route | Remove `/testing` re-export; retain declaration and root export used by RSNC/tests. |
| 6 | `GitLabMergeRequest` | `@leitwerk-dev/gitlab` | Reduce route | Remove `/testing` re-export; retain declaration and root route used by RSNC. |
| 7 | `GitLabPipeline` | `@leitwerk-dev/gitlab` | Reduce route | Remove `/testing` re-export; preserve declaration and required module access. |
| 8 | `GitLabProject` | `@leitwerk-dev/gitlab` | Reduce route | Remove `/testing` re-export; retain declaration and root route used by RSNC. |
| 9 | `FormDefinition` | `@leitwerk-dev/process-sdk` | Reduce route | Remove root `ActionFormDefinition` export; preserve `/form-contract` forwarding under the SDK Form name. |
| 10 | `FormFieldDefinition` | `@leitwerk-dev/process-sdk` | Reduce route | Remove root `ActionFormFieldDefinition` export; preserve generic `FormFieldDefinition` at `/form-contract` for UI imports. |
| 11 | `PiSessionDiagnosticLevel` | `@leitwerk-dev/process-sdk` | Reduce route | Remove the worker forward and SDK barrel exposure; preserve the type required by `PiSessionDiagnostic.level`. |
| 12 | `RepositoryProjectBinding` | `@leitwerk-dev/process-sdk` | Reduce route | Remove Woodpecker’s re-export; preserve the SDK export used by Forgejo. |
| 13 | `getProcessTurnGraph` | `@leitwerk-dev/process-sdk` | Retain | Server forwarding and downstream graph consumers require it. |
| 14 | `getTurnTransitionsForProcessGraph` | `@leitwerk-dev/process-sdk` | Retain | Server forwarding and downstream graph consumers require it. |
| 15 | `hasProcessGraph` | `@leitwerk-dev/process-sdk` | Retain | Used by server process and ticket-creation routes. |
| 16 | `isTurnAvailableForProcessGraph` | `@leitwerk-dev/process-sdk` | Retain | Server forwarding and downstream graph consumers require it. |
| 17 | `listLlmTurnIdsForProcessGraph` | `@leitwerk-dev/process-sdk` | Retain | Server forwarding and downstream graph consumers require it. |
| 18 | `serializeProcessGraph` | `@leitwerk-dev/process-sdk` | Retain | Server forwarding and downstream graph consumers require it. |
| 19 | `ModelProfileSnapshot` | `@leitwerk-dev/protocol` | Retain | Preserve the server `ModelProfile` forwarding chain or migrate it to the existing root export first. |
| 20 | `NotificationChannelConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 21 | `PiConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 22 | `PiProcessTitleGenerationConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 23 | `PiProcessTitleGenerationRetryConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 24 | `PiProviderRetryConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 25 | `PiRetryConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 26 | `ProcessTurnConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 27 | `ServerWebsocketConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 28 | `SquadNotificationConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 29 | `SquadNotificationRouteSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 30 | `WorkersCleanupConfigSnapshot` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead server forward, then remove the `/config-snapshot` facade export. |
| 31 | `ActionFormFieldKind` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead SDK forward, then remove the protocol facade export. |
| 32 | `FormFieldKind` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead SDK forward, then remove the protocol facade export. |
| 33 | `FormFieldPublishDefinition` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead SDK forward, then remove the protocol facade export. |
| 34 | `FormFieldStateDefinition` | `@leitwerk-dev/protocol` | Reduce route | Remove the dead SDK forward, then remove the protocol facade export. |
| 35 | `AuthMeResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 36 | `CronPreviewResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 37 | `CurrentErrorSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 38 | `ErrorResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 39 | `FutureActionSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 40 | `FutureExecutionDetailResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 41 | `FutureExecutionSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 42 | `FutureLaunchMutationResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 43 | `FutureLaunchSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 44 | `InstalledSkillCatalogDetailResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 45 | `InstanceTreeEdgeSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 46 | `InstanceTreeNodeSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 47 | `LauncherDefaultModelPreview` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 48 | `LauncherDefaultsResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 49 | `LauncherModelConfigPreviewResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 50 | `LauncherMutationResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 51 | `LauncherOptionsResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 52 | `LauncherRecentValuesResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 53 | `LauncherTurnModelConfigPreview` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 54 | `PrimaryPathSnapshotResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 55 | `ProcessActionFieldDefinition` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 56 | `ProcessActionModelPreviewResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 57 | `ProcessActionModelResolutionPreview` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 58 | `ProcessActionPreviewSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 59 | `ProcessActionSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 60 | `ProcessActionWarmPromptCacheContext` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 61 | `ProcessBrowseFacets` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 62 | `ProcessBrowsePagination` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 63 | `ProcessBrowseResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 64 | `ProcessDiagnosticsResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 65 | `ProcessExternalSourceSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 66 | `ProcessInstanceTreeResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 67 | `ProcessLaunchConfigurationView` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 68 | `ProcessLaunchRunsResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 69 | `ProcessListItem` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 70 | `ProcessModelConfigurationView` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 71 | `ProcessRetryConfig` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 72 | `ProcessRetryConfigResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 73 | `ProcessRunDetailsView` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 74 | `ProcessRunTurnView` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 75 | `ProcessesListResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 76 | `ProcessesOverviewResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 77 | `QuestionRequestMutationResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 78 | `ScheduleConfigInput` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 79 | `ScheduledActionDetail` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 80 | `ScheduledActionMutationResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 81 | `SessionTransferOperationView` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 82 | `SkillCatalogDetailResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 83 | `SubmitQuestionAnswersRequestBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 84 | `UiLauncherSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 85 | `WatcherLaunchModelSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 86 | `WatcherSummary` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 87 | `WatchersResponseBody` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 88 | `parseScheduleRequestInput` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 89 | `resolvePromptCacheSwitch` | `@leitwerk-dev/protocol` | Reduce route | Remove from the protocol root; retain `/http-contracts`. |
| 90 | `LauncherCardMetadata` | `@leitwerk-dev/protocol` | Retain | Launcher forwarding types are used by SDK `extension-api.ts` signatures. |
| 91 | `LauncherSchemaDefinition` | `@leitwerk-dev/protocol` | Retain | Launcher forwarding types are used by SDK `extension-api.ts` signatures. |
| 92 | `UiLauncherSummaryBase` | `@leitwerk-dev/protocol` | Retain | Launcher forwarding types are used by SDK `extension-api.ts` signatures. |
| 93 | `cloneUsageSnapshot` | `@leitwerk-dev/protocol` | Retain | UI forwards it as `cloneTurnUsageSnapshot`, and `primary-path-detail.ts` calls it. |
| 94 | `RebaseInput` | `@leitwerk-dev/repository-rebase` | Reduce route | Remove from `git-public.ts`; preserve `git.ts` exports and required signatures. |
| 95 | `verifyRebase` | `@leitwerk-dev/repository-rebase` | Reduce route | Remove from `git-public.ts`; preserve `git.ts` export used by `publishRebase`. |
| 96 | `TestDeps` | `@leitwerk-dev/server` | Reduce route | Remove only the root export; retain `createTestDeps`, the internal type, and tests. |
| 97 | `FakeLlmProvider` | `@leitwerk-dev/test-support` | Reduce route | Remove from `/fakes`; keep the root export used by RSNC. |
| 98 | `LlmResponse` | `@leitwerk-dev/test-support` | Reduce route | Remove from the root facade; retain the declaration/module access needed by support code. |
| 99 | `InMemoryExternalWriteLog` | `@leitwerk-dev/test-support` | Reduce route | Remove from the root facade; retain the declaration/module access needed by support code. |
| 100 | `IntegrationHarness` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/integration`. |
| 101 | `IntegrationHarnessOptions` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain the underlying type needed by the integration module. |
| 102 | `createInMemoryExternalWriteLog` | `@leitwerk-dev/test-support` | Reduce route | Remove `/integration` re-export; keep the root export used by extensions. |
| 103 | `createIntegrationHarness` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/integration`. |
| 104 | `waitForValue` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/integration`. |
| 105 | `InProcessWorkerSpawnOptions` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain the underlying type required by the factory. |
| 106 | `ManualWorkerRuntimeScheduler` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve inferred scheduler behavior and implementation. |
| 107 | `StubPiTreeHandle` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 108 | `StubPiTreeHandleFactory` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 109 | `StubPiTreeHandleFactoryOptions` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the worker-testing implementation signature. |
| 110 | `StubToolCallScriptCall` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 111 | `StubToolCallScriptItem` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the worker-testing implementation signature. |
| 112 | `StubToolCallScriptResolver` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 113 | `StubToolCallScriptResolverContext` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the worker-testing implementation signature. |
| 114 | `StubToolScriptController` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing` implementation. |
| 115 | `TestLlmWorkerStartPayloadOptions` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the worker test helper implementation. |
| 116 | `WorkerRuntimeHarness` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the harness implementation and methods. |
| 117 | `WorkerRuntimeHarnessOptions` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the harness implementation signature. |
| 118 | `WorkerRuntimeObservation` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; preserve the harness implementation and inferred observation shape. |
| 119 | `createInProcessWorkerSpawn` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 120 | `createStubToolScriptController` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 121 | `flushAsyncWork` | `@leitwerk-dev/test-support` | Reduce route | Remove root export; retain `/worker-testing`. |
| 122 | `LocalTicket` | `@leitwerk-dev/ticket-creation` | Reduce route | Reduce the local adapter testing exposure while preserving implementation signatures. |
| 123 | `LocalTicketAdapterOptions` | `@leitwerk-dev/ticket-creation` | Reduce route | Reduce the local adapter testing exposure while preserving implementation signatures. |
| 124 | `TicketCreationParams` | `@leitwerk-dev/ticket-creation` | Reduce route | Remove the root re-export; retain `params.ts` exports for `index.ts` and tests. |
| 125 | `TicketParentContextSnapshot` | `@leitwerk-dev/ticket-creation` | Delete | Delete the unused core alias and its root re-export; leave the private installation’s separate type intact. |
| 126 | `ticketCreationParamsCodec` | `@leitwerk-dev/ticket-creation` | Reduce route | Remove the root re-export; retain `params.ts` exports for `index.ts` and tests. |
| 127 | `ticketCreationProcess` | `@leitwerk-dev/ticket-creation` | Reduce declaration exposure | Make it file-local; preserve the implementation, catalog registration, and default extension export. |
| 128 | `LocalWoodpeckerOptions` | `@leitwerk-dev/woodpecker` | Reduce route | Reduce the local adapter testing exposure while preserving implementation signatures. |
| 129 | `LocalWoodpeckerRepository` | `@leitwerk-dev/woodpecker` | Reduce route | Reduce the local adapter testing exposure while preserving implementation signatures. |
| 130 | `WoodpeckerClient` | `@leitwerk-dev/woodpecker` | Reduce route | Replace root wildcard forwarding with an explicit list that omits this name; preserve implementation/module exports. |
| 131 | `WoodpeckerClientLike` | `@leitwerk-dev/woodpecker` | Reduce route | Replace root wildcard forwarding with an explicit list that omits this name; preserve implementation/module exports. |
| 132 | `WoodpeckerRepository` | `@leitwerk-dev/woodpecker` | Reduce route | Replace root wildcard forwarding with an explicit list that omits this name; preserve implementation/module exports. |
| 133 | `createDockerEngineHttpClient` | `@leitwerk-dev/worker-runners` | Retain | Server dynamically imports the Docker client entry. |
| 134 | `createDockerWorkerRunner` | `@leitwerk-dev/worker-runners` | Retain | Server dynamically imports the Docker runner entry. |
| 135 | `createInClusterKubernetesApiClient` | `@leitwerk-dev/worker-runners` | Retain | Server dynamically imports the Kubernetes client entry. |
| 136 | `createKubernetesWorkerRunner` | `@leitwerk-dev/worker-runners` | Retain | Server dynamically imports the Kubernetes runner entry. |
| 137 | `createLocalWorkerRunner` | `@leitwerk-dev/worker-runners` | Retain | Server dynamically imports the local runner entry. |

## Execution prerequisites

The ledger is a review result, not completion of the cleanup. Before implementing
any reduction, search all four repositories for the exact names, package routes,
re-exports, aliases, namespace imports, Svelte imports, tests, and literal dynamic
imports. Apply the changes in dependency order: protocol and test-support facade
reductions first, then the small extension reductions, then dead forwarding chains,
and finally local-adapter exposure reductions. Preserve the `LocalForgejoRepository`
route and all retained SDK graph, launcher, usage, and worker-runner APIs.

After each coherent application batch, run `npm run test:full` and the affected
installation checks. Refresh the explorer reports after implementation; the current
coverage limitations prevent this ledger from proving absence or global completion.
Owner, commit/PR, and validation remain pending until implementation is explicitly
started.
+
## Exact API identifiers

The numbered rows above correspond to the following stable finding IDs and route IDs from the live explorer. Route decisions are made against these IDs, including retained aliases alongside reduced aliases.

1. `api|%40leitwerk-dev%2Fforgejo|.%2Ftesting|LocalForgejoOptions` → `api|%40leitwerk-dev%2Fforgejo|.%2Ftesting|LocalForgejoOptions`
2. `api|%40leitwerk-dev%2Fforgejo|.%2Ftesting|LocalForgejoRepository` → `api|%40leitwerk-dev%2Fforgejo|.%2Ftesting|LocalForgejoRepository`
3. `api|%40leitwerk-dev%2Fgithub|.%2Ftesting|LocalGitHubOptions` → `api|%40leitwerk-dev%2Fgithub|.%2Ftesting|LocalGitHubOptions`
4. `api|%40leitwerk-dev%2Fgithub|.%2Ftesting|LocalGitHubRepository` → `api|%40leitwerk-dev%2Fgithub|.%2Ftesting|LocalGitHubRepository`
5. `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabClientLike` → `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabClientLike`
6. `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabMergeRequest` → `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabMergeRequest`, `api|%40leitwerk-dev%2Fgitlab|.|GitLabMergeRequest`
7. `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabPipeline` → `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabPipeline`
8. `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabProject` → `api|%40leitwerk-dev%2Fgitlab|.%2Ftesting|GitLabProject`, `api|%40leitwerk-dev%2Fgitlab|.|GitLabProject`
9. `api|%40leitwerk-dev%2Fprocess-sdk|.|FormDefinition` → `api|%40leitwerk-dev%2Fprocess-sdk|.|FormDefinition`, `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|ActionFormDefinition`, `api|%40leitwerk-dev%2Fprotocol|.|ActionFormDefinition`
10. `api|%40leitwerk-dev%2Fprocess-sdk|.|FormFieldDefinition` → `api|%40leitwerk-dev%2Fprocess-sdk|.|FormFieldDefinition`, `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|ActionFormFieldDefinition`, `api|%40leitwerk-dev%2Fprotocol|.|ActionFormFieldDefinition`
11. `api|%40leitwerk-dev%2Fprocess-sdk|.|PiSessionDiagnosticLevel` → `api|%40leitwerk-dev%2Fprocess-sdk|.|PiSessionDiagnosticLevel`
12. `api|%40leitwerk-dev%2Fprocess-sdk|.|RepositoryProjectBinding` → `api|%40leitwerk-dev%2Fprocess-sdk|.|RepositoryProjectBinding`, `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerProjectBinding`
13. `api|%40leitwerk-dev%2Fprocess-sdk|.|getProcessTurnGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|getProcessTurnGraph`
14. `api|%40leitwerk-dev%2Fprocess-sdk|.|getTurnTransitionsForProcessGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|getTurnTransitionsForProcessGraph`
15. `api|%40leitwerk-dev%2Fprocess-sdk|.|hasProcessGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|hasProcessGraph`
16. `api|%40leitwerk-dev%2Fprocess-sdk|.|isTurnAvailableForProcessGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|isTurnAvailableForProcessGraph`
17. `api|%40leitwerk-dev%2Fprocess-sdk|.|listLlmTurnIdsForProcessGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|listLlmTurnIdsForProcessGraph`
18. `api|%40leitwerk-dev%2Fprocess-sdk|.|serializeProcessGraph` → `api|%40leitwerk-dev%2Fprocess-sdk|.|serializeProcessGraph`
19. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ModelProfileSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ModelProfileSnapshot`, `api|%40leitwerk-dev%2Fprotocol|.|ModelProfileSnapshot`
20. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|NotificationChannelConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|NotificationChannelConfigSnapshot`
21. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiConfigSnapshot`
22. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProcessTitleGenerationConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProcessTitleGenerationConfigSnapshot`
23. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProcessTitleGenerationRetryConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProcessTitleGenerationRetryConfigSnapshot`
24. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProviderRetryConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiProviderRetryConfigSnapshot`
25. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiRetryConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|PiRetryConfigSnapshot`
26. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ProcessTurnConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ProcessTurnConfigSnapshot`
27. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ServerWebsocketConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|ServerWebsocketConfigSnapshot`
28. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|SquadNotificationConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|SquadNotificationConfigSnapshot`
29. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|SquadNotificationRouteSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|SquadNotificationRouteSnapshot`
30. `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|WorkersCleanupConfigSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.%2Fconfig-snapshot|WorkersCleanupConfigSnapshot`
31. `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|ActionFormFieldKind` → `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|ActionFormFieldKind`
32. `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldKind` → `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldKind`
33. `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldPublishDefinition` → `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldPublishDefinition`
34. `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldStateDefinition` → `api|%40leitwerk-dev%2Fprotocol|.%2Fform-contract|FormFieldStateDefinition`
35. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|AuthMeResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|AuthMeResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|AuthMeResponseBody`
36. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|CronPreviewResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|CronPreviewResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|CronPreviewResponseBody`
37. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|CurrentErrorSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|CurrentErrorSummary`, `api|%40leitwerk-dev%2Fprotocol|.|CurrentErrorSummary`
38. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ErrorResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ErrorResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ErrorResponseBody`
39. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureActionSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureActionSummary`, `api|%40leitwerk-dev%2Fprotocol|.|FutureActionSummary`
40. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureExecutionDetailResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureExecutionDetailResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|FutureExecutionDetailResponseBody`
41. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureExecutionSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureExecutionSummary`, `api|%40leitwerk-dev%2Fprotocol|.|FutureExecutionSummary`
42. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureLaunchMutationResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureLaunchMutationResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|FutureLaunchMutationResponseBody`
43. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureLaunchSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|FutureLaunchSummary`, `api|%40leitwerk-dev%2Fprotocol|.|FutureLaunchSummary`
44. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstalledSkillCatalogDetailResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstalledSkillCatalogDetailResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|InstalledSkillCatalogDetailResponseBody`
45. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstanceTreeEdgeSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstanceTreeEdgeSummary`, `api|%40leitwerk-dev%2Fprotocol|.|InstanceTreeEdgeSummary`
46. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstanceTreeNodeSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|InstanceTreeNodeSummary`, `api|%40leitwerk-dev%2Fprotocol|.|InstanceTreeNodeSummary`
47. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherDefaultModelPreview` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherDefaultModelPreview`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherDefaultModelPreview`
48. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherDefaultsResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherDefaultsResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherDefaultsResponseBody`
49. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherModelConfigPreviewResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherModelConfigPreviewResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherModelConfigPreviewResponseBody`
50. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherMutationResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherMutationResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherMutationResponseBody`
51. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherOptionsResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherOptionsResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherOptionsResponseBody`
52. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherRecentValuesResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherRecentValuesResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherRecentValuesResponseBody`
53. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherTurnModelConfigPreview` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|LauncherTurnModelConfigPreview`, `api|%40leitwerk-dev%2Fprotocol|.|LauncherTurnModelConfigPreview`
54. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|PrimaryPathSnapshotResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|PrimaryPathSnapshotResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|PrimaryPathSnapshotResponseBody`
55. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionFieldDefinition` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionFieldDefinition`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionFieldDefinition`
56. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionModelPreviewResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionModelPreviewResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionModelPreviewResponseBody`
57. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionModelResolutionPreview` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionModelResolutionPreview`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionModelResolutionPreview`
58. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionPreviewSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionPreviewSummary`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionPreviewSummary`
59. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionSummary`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionSummary`
60. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionWarmPromptCacheContext` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessActionWarmPromptCacheContext`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessActionWarmPromptCacheContext`
61. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowseFacets` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowseFacets`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessBrowseFacets`
62. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowsePagination` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowsePagination`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessBrowsePagination`
63. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowseResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessBrowseResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessBrowseResponseBody`
64. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessDiagnosticsResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessDiagnosticsResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessDiagnosticsResponseBody`
65. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessExternalSourceSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessExternalSourceSummary`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessExternalSourceSummary`
66. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessInstanceTreeResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessInstanceTreeResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessInstanceTreeResponseBody`
67. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessLaunchConfigurationView` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessLaunchConfigurationView`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessLaunchConfigurationView`
68. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessLaunchRunsResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessLaunchRunsResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessLaunchRunsResponseBody`
69. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessListItem` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessListItem`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessListItem`
70. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessModelConfigurationView` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessModelConfigurationView`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessModelConfigurationView`
71. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRetryConfig` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRetryConfig`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessRetryConfig`
72. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRetryConfigResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRetryConfigResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessRetryConfigResponseBody`
73. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRunDetailsView` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRunDetailsView`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessRunDetailsView`
74. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRunTurnView` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessRunTurnView`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessRunTurnView`
75. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessesListResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessesListResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessesListResponseBody`
76. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessesOverviewResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ProcessesOverviewResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ProcessesOverviewResponseBody`
77. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|QuestionRequestMutationResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|QuestionRequestMutationResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|QuestionRequestMutationResponseBody`
78. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduleConfigInput` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduleConfigInput`, `api|%40leitwerk-dev%2Fprotocol|.|ScheduleConfigInput`
79. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduledActionDetail` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduledActionDetail`, `api|%40leitwerk-dev%2Fprotocol|.|ScheduledActionDetail`
80. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduledActionMutationResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|ScheduledActionMutationResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|ScheduledActionMutationResponseBody`
81. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SessionTransferOperationView` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SessionTransferOperationView`, `api|%40leitwerk-dev%2Fprotocol|.|SessionTransferOperationView`
82. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SkillCatalogDetailResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SkillCatalogDetailResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|SkillCatalogDetailResponseBody`
83. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SubmitQuestionAnswersRequestBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|SubmitQuestionAnswersRequestBody`, `api|%40leitwerk-dev%2Fprotocol|.|SubmitQuestionAnswersRequestBody`
84. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|UiLauncherSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|UiLauncherSummary`, `api|%40leitwerk-dev%2Fprotocol|.|UiLauncherSummary`
85. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatcherLaunchModelSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatcherLaunchModelSummary`, `api|%40leitwerk-dev%2Fprotocol|.|WatcherLaunchModelSummary`
86. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatcherSummary` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatcherSummary`, `api|%40leitwerk-dev%2Fprotocol|.|WatcherSummary`
87. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatchersResponseBody` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|WatchersResponseBody`, `api|%40leitwerk-dev%2Fprotocol|.|WatchersResponseBody`
88. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|parseScheduleRequestInput` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|parseScheduleRequestInput`, `api|%40leitwerk-dev%2Fprotocol|.|parseScheduleRequestInput`
89. `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|resolvePromptCacheSwitch` → `api|%40leitwerk-dev%2Fprotocol|.%2Fhttp-contracts|resolvePromptCacheSwitch`, `api|%40leitwerk-dev%2Fprotocol|.|resolvePromptCacheSwitch`
90. `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|LauncherCardMetadata` → `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|LauncherCardMetadata`
91. `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|LauncherSchemaDefinition` → `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|LauncherSchemaDefinition`
92. `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|UiLauncherSummaryBase` → `api|%40leitwerk-dev%2Fprotocol|.%2Flauncher-contract|UiLauncherSummaryBase`
93. `api|%40leitwerk-dev%2Fprotocol|.|cloneUsageSnapshot` → `api|%40leitwerk-dev%2Fprotocol|.|cloneUsageSnapshot`
94. `api|%40leitwerk-dev%2Frepository-rebase|.%2Fgit|RebaseInput` → `api|%40leitwerk-dev%2Frepository-rebase|.%2Fgit|RebaseInput`
95. `api|%40leitwerk-dev%2Frepository-rebase|.%2Fgit|verifyRebase` → `api|%40leitwerk-dev%2Frepository-rebase|.%2Fgit|verifyRebase`
96. `api|%40leitwerk-dev%2Fserver|.%2Ftesting|TestDeps` → `api|%40leitwerk-dev%2Fserver|.%2Ftesting|TestDeps`
97. `api|%40leitwerk-dev%2Ftest-support|.%2Ffakes|FakeLlmProvider` → `api|%40leitwerk-dev%2Ftest-support|.%2Ffakes|FakeLlmProvider`, `api|%40leitwerk-dev%2Ftest-support|.|FakeLlmProvider`
98. `api|%40leitwerk-dev%2Ftest-support|.%2Ffakes|LlmResponse` → `api|%40leitwerk-dev%2Ftest-support|.%2Ffakes|LlmResponse`
99. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|InMemoryExternalWriteLog` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|InMemoryExternalWriteLog`, `api|%40leitwerk-dev%2Ftest-support|.|InMemoryExternalWriteLog`
100. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|IntegrationHarness` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|IntegrationHarness`, `api|%40leitwerk-dev%2Ftest-support|.|IntegrationHarness`
101. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|IntegrationHarnessOptions` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|IntegrationHarnessOptions`, `api|%40leitwerk-dev%2Ftest-support|.|IntegrationHarnessOptions`
102. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|createInMemoryExternalWriteLog` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|createInMemoryExternalWriteLog`, `api|%40leitwerk-dev%2Ftest-support|.|createInMemoryExternalWriteLog`
103. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|createIntegrationHarness` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|createIntegrationHarness`, `api|%40leitwerk-dev%2Ftest-support|.|createIntegrationHarness`
104. `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|waitForValue` → `api|%40leitwerk-dev%2Ftest-support|.%2Fintegration|waitForValue`, `api|%40leitwerk-dev%2Ftest-support|.|waitForValue`
105. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|InProcessWorkerSpawnOptions` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|InProcessWorkerSpawnOptions`, `api|%40leitwerk-dev%2Ftest-support|.|InProcessWorkerSpawnOptions`
106. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|ManualWorkerRuntimeScheduler` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|ManualWorkerRuntimeScheduler`
107. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandle` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandle`, `api|%40leitwerk-dev%2Ftest-support|.|StubPiTreeHandle`
108. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandleFactory` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandleFactory`, `api|%40leitwerk-dev%2Ftest-support|.|StubPiTreeHandleFactory`
109. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandleFactoryOptions` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubPiTreeHandleFactoryOptions`, `api|%40leitwerk-dev%2Ftest-support|.|StubPiTreeHandleFactoryOptions`
110. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptCall` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptCall`, `api|%40leitwerk-dev%2Ftest-support|.|StubToolCallScriptCall`
111. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptItem` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptItem`, `api|%40leitwerk-dev%2Ftest-support|.|StubToolCallScriptItem`
112. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptResolver` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptResolver`, `api|%40leitwerk-dev%2Ftest-support|.|StubToolCallScriptResolver`
113. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptResolverContext` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolCallScriptResolverContext`, `api|%40leitwerk-dev%2Ftest-support|.|StubToolCallScriptResolverContext`
114. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolScriptController` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|StubToolScriptController`, `api|%40leitwerk-dev%2Ftest-support|.|StubToolScriptController`
115. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|TestLlmWorkerStartPayloadOptions` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|TestLlmWorkerStartPayloadOptions`
116. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeHarness` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeHarness`
117. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeHarnessOptions` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeHarnessOptions`
118. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeObservation` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|WorkerRuntimeObservation`
119. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|createInProcessWorkerSpawn` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|createInProcessWorkerSpawn`, `api|%40leitwerk-dev%2Ftest-support|.|createInProcessWorkerSpawn`
120. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|createStubToolScriptController` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|createStubToolScriptController`, `api|%40leitwerk-dev%2Ftest-support|.|createStubToolScriptController`
121. `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|flushAsyncWork` → `api|%40leitwerk-dev%2Ftest-support|.%2Fworker-testing|flushAsyncWork`, `api|%40leitwerk-dev%2Ftest-support|.|flushAsyncWork`, `api|%40leitwerk-dev%2Fworker-protocol|.|flushAsyncWork`
122. `api|%40leitwerk-dev%2Fticket-creation|.%2Ftesting|LocalTicket` → `api|%40leitwerk-dev%2Fticket-creation|.%2Ftesting|LocalTicket`
123. `api|%40leitwerk-dev%2Fticket-creation|.%2Ftesting|LocalTicketAdapterOptions` → `api|%40leitwerk-dev%2Fticket-creation|.%2Ftesting|LocalTicketAdapterOptions`
124. `api|%40leitwerk-dev%2Fticket-creation|.|TicketCreationParams` → `api|%40leitwerk-dev%2Fticket-creation|.|TicketCreationParams`
125. `api|%40leitwerk-dev%2Fticket-creation|.|TicketParentContextSnapshot` → `api|%40leitwerk-dev%2Fticket-creation|.|TicketParentContextSnapshot`
126. `api|%40leitwerk-dev%2Fticket-creation|.|ticketCreationParamsCodec` → `api|%40leitwerk-dev%2Fticket-creation|.|ticketCreationParamsCodec`
127. `api|%40leitwerk-dev%2Fticket-creation|.|ticketCreationProcess` → `api|%40leitwerk-dev%2Fticket-creation|.|ticketCreationProcess`
128. `api|%40leitwerk-dev%2Fwoodpecker|.%2Ftesting|LocalWoodpeckerOptions` → `api|%40leitwerk-dev%2Fwoodpecker|.%2Ftesting|LocalWoodpeckerOptions`
129. `api|%40leitwerk-dev%2Fwoodpecker|.%2Ftesting|LocalWoodpeckerRepository` → `api|%40leitwerk-dev%2Fwoodpecker|.%2Ftesting|LocalWoodpeckerRepository`
130. `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerClient` → `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerClient`
131. `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerClientLike` → `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerClientLike`
132. `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerRepository` → `api|%40leitwerk-dev%2Fwoodpecker|.|WoodpeckerRepository`
133. `api|%40leitwerk-dev%2Fworker-runners|.%2Fdocker-client|createDockerEngineHttpClient` → `api|%40leitwerk-dev%2Fworker-runners|.%2Fdocker-client|createDockerEngineHttpClient`
134. `api|%40leitwerk-dev%2Fworker-runners|.%2Fdocker|createDockerWorkerRunner` → `api|%40leitwerk-dev%2Fworker-runners|.%2Fdocker|createDockerWorkerRunner`
135. `api|%40leitwerk-dev%2Fworker-runners|.%2Fkubernetes-client|createInClusterKubernetesApiClient` → `api|%40leitwerk-dev%2Fworker-runners|.%2Fkubernetes-client|createInClusterKubernetesApiClient`
136. `api|%40leitwerk-dev%2Fworker-runners|.%2Fkubernetes|createKubernetesWorkerRunner` → `api|%40leitwerk-dev%2Fworker-runners|.%2Fkubernetes|createKubernetesWorkerRunner`
137. `api|%40leitwerk-dev%2Fworker-runners|.%2Flocal|createLocalWorkerRunner` → `api|%40leitwerk-dev%2Fworker-runners|.%2Flocal|createLocalWorkerRunner`
