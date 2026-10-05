# Launch preflight prototype

A standalone experiment for reviewing launch readiness before creating process state.

**Design question:** Can one review explain what blocks a launch, how to repair it, and when a previously reviewed plan becomes stale?

Open `index.html` directly in a browser. No server, installation, credentials or network access is needed. Everything is synthetic and held in memory. Reload or **Reset** restores the initial fixture. This branch is a future proposal, not application integration.

## Interactions

Choose a code-defined process, inherited or explicit model profile, runner and optional Kubernetes capacity. Toggle process loading, provider credentials, repository authorization, Docker capability and storage availability. Requirements update immediately. Each blocker has an inline simulated repair.

**Freeze launch plan** captures resolved values only when blockers are absent. Warnings remain advisory. Environment changes retain the captured snapshot and mark it stale. **Check frozen plan** rejects a stale snapshot. No action creates a process, worker, clone, volume or turn attempt.

The pure `Preflight.evaluate` and `Preflight.reduce` functions are separate from DOM rendering. Each guided tab restores a known fixture. Free play remains available; choosing a tab restarts a walkthrough after free-play changes.

## Walkthroughs

1. **Ready to plan:** freeze the plan, then verify it. `team-coder` keeps its inherited selection source.
2. **Unavailable provider:** attempt to freeze an explicit unavailable profile, restore its credential fixture, then freeze. An available backup is never silently selected.
3. **Incompatible runner:** attempt to freeze a Docker-requiring process without the runner's private-daemon capability, repair it, then freeze. Kubernetes size does not affect Docker.
4. **Stale snapshot:** freeze a ready plan, revoke repository access, then check the old snapshot. Revision 1 remains captured while revision 2 rejects its use.

Additional free-play cases: enter `0Gi` to expose invalid capacity; select Local development to see its deployment warning; unload the process extension; select Repository review to remove the Docker requirement; explicitly choose `backup-coder` while the team credential is unavailable.

## Potential integration seams

These are existing sources to consult for a production implementation; the prototype does not import or modify them.

| Concern | Existing source |
| --- | --- |
| Launcher UI | `packages/ui/src/components/GenericLauncher.svelte` |
| Launcher routes and model preview | `packages/server/src/routes/launchers.ts`, `packages/server/src/launcher-model-config-service.ts` (`buildLauncherModelConfigPreviewForLauncher`) |
| Code-defined launch plan | `packages/server/src/process-launch-plan.ts` (`buildProcessLaunchPlan`) |
| Runtime capability rejection | `packages/server/src/process-runtime-availability.ts` (`assertProcessRuntimeAvailable`) |
| Runtime image selection and precedence | `packages/server/src/worker-runtime-profile-selection.ts` (`selectWorkerRuntimeProfile`) |
| Repository credential validation | `packages/server/src/repository-credentials/service.ts` (`RepositoryCredentialService.validateLaunch`) |
| New Kubernetes capacity | `packages/server/src/process-storage-size.ts` (`resolveProcessStorageSize`) |

Relevant contracts are documented in `docs/models.md`, `docs/configuration.md`, `docs/process-workspace.md` and `docs/server-worker-lifecycle.md`. Configuration supplies runtime defaults; loaded code owns process behavior. Preparation is distinct from acknowledged worker turn acceptance.

## Validation observed

- Extracted the inline script and ran `node --check`; passed.
- Ran `git diff --check`; passed.
- Used an isolated `agent-browser --session idea-03` real Chromium session with the file URL.
- Completed all four guided cases. Ready plans froze at revision 1; provider and runner repairs froze at revision 2; the stale case rejected revision 1 against current revision 2.
- Entered `0Gi`: one blocker appeared. **Use code resolver** repaired it. Selecting Local development produced two advisory warnings.
- Used ArrowRight on the case tabs: the provider case became selected and its blocker appeared.
- At 390px, completed provider repair and froze the plan; inspected the resulting screenshot. Document width equaled viewport width (390px), with no horizontal overflow.
- Captured and visually inspected desktop and mobile screenshots. No browser page errors were reported.

Scoped syntax and browser checks follow the standalone-helper rule in `AGENTS.md`. Application code and build/runtime configuration are untouched; `npm run test:full` was not run. Required CI checks still apply before any merge.

## Limits and provisional learning

This experiment suggests that actionable blockers plus explicit snapshot freshness make the review understandable without pretending to guarantee startup. Keeping inherited selection distinct from explicit choice also prevents a preview from pinning the current default.

A single synthetic revision conservatively invalidates a plan for every input change, even a capability unrelated to the selected process. A real implementation needs authoritative revision/fingerprint inputs and revalidation immediately before committing launch state. It must not reserve resources or leak credentials through the preview.

The fixtures collapse each capability into a boolean and cover two illustrative process definitions. They do not validate network reachability, image availability, permissions, asynchronous provisioning or every model-selection layer. Capacity input intentionally accepts only positive `Ki`, `Mi`, `Gi` and `Ti` quantities; the production resolver supports the wider Kubernetes quantity grammar. Existing PVC reuse and resizing are outside this new-launch experiment.

Screenshots: [desktop blocker review](screenshots/desktop.png) · [mobile repaired plan](screenshots/mobile.png).

The standalone HTML also passes the repository Biome check.
