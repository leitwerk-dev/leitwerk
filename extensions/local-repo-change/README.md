# Local Repo Change

Final approval generates and persists a commit message from the accepted plan before deterministic Git finalization. Repository-specific formatting is selected by the server's `commit_messages` locator mapping and pinned when the process launches. Git commits use the operator-configured repository/global identity; configure `user.name` and `user.email` before finalization.

Shared coding action contracts now live in `@leitwerk-dev/coding`. This extension retains its ids, persisted state contract, imported-plan flow, and legacy leaf renderer. New authenticated remote work should use **Remote Repo Change**; existing persisted instances with remote locators remain supported.

Process extension for planning, implementing, reviewing, and finalizing a single local or remote git repository change.

## Naming

| Item | Value |
|---|---|
| Extension directory | `extensions/local-repo-change/` |
| Package name | `@leitwerk-dev/local-repo-change` |
| Process id | `local_repo_change_process` |
| UI launcher id | `local_repo_change_process.ui_launcher` |
| Imported-plan launcher id | `local_repo_change_process.imported_plan` |
| Deprecated leaf renderer id | `@leitwerk-dev/local-repo-change:local_repo_change_process.leaf_outcome` |

## Legacy UI compatibility

The extension ships a minimal deprecated leaf-outcome renderer for historical snapshots using renderer id `@leitwerk-dev/local-repo-change:local_repo_change_process.leaf_outcome`. The source lane loads it from `src/ui/manifest.json`; the dist lane loads the built `dist/ui/manifest.json`. New process behavior should not rely on it, but removing this renderer is a breaking change because persisted snapshots may still reference it.

## Scope

| Item | Decision |
|---|---|
| Product shape | Single-repo local/remote git change flow |
| Repository model | One `ProcessProject` with one repo locator |
| Review model | Human-gated plan review, simplification review, and implementation review |
| Branch model | Planning and implementation are primary turns. Automated reviews are `root_branch` turns. Plan/implementation review branches use the compatibility `review` ref; simplification branches are anchored by the process-defined `simplification-plan` product ref. The normal plan → implementation transition uses fresh-seeded primary context: it starts from the session root with no plan-generation ancestry and reads the approved plan from the durable `plan` product. Accepted simplification and implementation-review follow-up turns are primary turns that start from the accepted side branch so the smaller side-branch context becomes the next primary leaf. Finalization is automatic; only semantic merge conflicts hand off to the focused `resolve_merge_conflict` LLM turn. |
| External systems | None required for MVP |
| Finalization | Deterministic automatic finalization: commit the completed workspace change on `workBranch`, preflight every local publish target before mutating the workspace branch, merge the latest base, publish it, land it on the local source repo's `baseBranch` when applicable, and push that source repo's `baseBranch` to its own `origin` when configured |

## Params

```ts
type LocalRepoChangeParams = {
  repoLocator: string;
  baseBranch: string;
  workBranch: string;
  prompt: string;
} & (
  | { launchKind: "requested_change" }
  | { launchKind: "imported_plan"; importedPlanMarkdown: string }
);
```

| Field | Type | Notes |
|---|---|---|
| `launchKind` | `"requested_change" \| "imported_plan"` | Explicit launch behavior. Requested changes start at the primary `generate_plan` entry. Imported plans start at the alternate `import_plan` entry and skip plan generation. |
| `repoLocator` | `string` | Local filesystem path or remote git URL. Used as the clone source; worker turns operate on the process workspace clone, not the original path. |
| `baseBranch` | `string` | Default `"main"` |
| `workBranch` | `string` | Optional in the UI launcher. When blank, the extension waits for a process title, resolves the base branch SHA, and persists `<title-prefix-slug>-<3-hex>-<short-base-sha>` before starting the launch-kind entry turn. If no title becomes available, it falls back to the prompt slug. |
| `prompt` | `string` | Operator-provided requested change |
| `importedPlanMarkdown` | `string` | Required only for `imported_plan`. Published by `import_plan` as the durable `plan` product. |

## State

```ts
interface LocalRepoChangeState extends StructuralProcessState {
  finalization: {
    expectedPostConflictHeadSha: string | null;
    usedConflictResolution: boolean;
    finalizationSummaryMarkdown: string | null;
    finalizedHeadSha: string | null;
  };
}
```

| Field | Purpose |
|---|---|
| `finalization` | Merge-conflict recovery metadata and final publish status. Ordinary commits are created by the automatic finalizer and require no LLM-reported checkpoint. Legacy pre/post-commit checkpoint fields are ignored when old process state is decoded. |

When the UI launcher leaves `workBranch` blank, the launch plan is created without an initial
selected turn. After an explicit or generated process title is available, the server-side
extension resolves the configured base branch SHA with read-only Git metadata and derives a
Git-safe work branch from the title words, a 3-character random hex string, and the short SHA.
If no title becomes available after 30 seconds, it uses the prompt. Concurrent creation, title,
timer, and startup triggers are coalesced per process. Abort and retry preserves the repository,
base branch, and prompt but clears `workBranch`, including an originally explicit branch. The new
process therefore derives a fresh branch and never reuses the previous process branch.

The extension submits the prepared assignment to ProcessEngine. ProcessEngine revalidates the
semantic snapshot and atomically commits params, `ProcessProject.workBranch`, project-scoped
automatic-assignment provenance, the audit event, and first-turn selection. The extension retries
stale preparation but does not overwrite explicit or incompatible branch state. Git preparation
runs outside the process lock and transaction.

The Local Repo Change launch planner owns normalization, project seeding, and entry-turn policy.
The UI launcher, imported-plan adapters, and deferred activation use the same planner. A blank work
branch returns no entry turn. After automatic assignment, the coordinator replans with authoritative
`ProcessProject.workBranch` and submits the planner-selected `generate_plan` or `import_plan` turn
to ProcessEngine.

Startup recovery recognizes only legacy automatic-assignment provenance and parameters. It
treats `ProcessProject.workBranch` as authoritative, rejects conflicting non-null branches, moves
provenance to project metadata, translates the old optional handoff field into explicit launch
intent outside the planner, and then uses the same planner and atomic activation. Preparation
failures atomically park the process in `error` with an operator-visible event. A post-commit
reaction failure leaves the activation committed.

User-authored follow-up text is not duplicated into durable extension state. Human actions queue durable `action_prompt` inputs with an explicit branch target: revision notes target semantic ref `currentPrimaryPathLeaf`, review-on-review notes target semantic ref `review`, accepted plan-review handoff notes target `currentPrimaryPathLeaf`, accepted implementation-review handoff notes target `review`, and accepted/requested simplification handoff notes target product ref `simplification-plan`. Accept-review actions can include an optional adjustment. The next-turn prompt starts with the direct action (`Revise the plan according to this review` or `Implement according to this review/simplification plan`), followed by the accepted content and optional adjustment. Implementation handoffs briefly override inherited review-only/read-only instructions and list the active `read`, `bash`, `edit`, and `write` tools. Before the next selected LLM turn starts, the worker verifies that the turn continues from that same semantic or product branch, appends the queued input there, and resumes that branch without replaying the original kickoff prompt. The queued follow-up plus worker-generated active-turn handoff/tool/result guidance are the only new instructions.

## Process instance fields used outside extension state

| Field | Source | Purpose |
|---|---|---|
| `process.planRevision` | core durable field | Revision counter for candidate plans |
| `selectedTurnId` | core durable field | Current business position |
| `lifecycleStatus` | core durable field | `active`, `waiting`, `completed`, etc. |

## Durable product refs and semantic entry refs used by the process

Flow-authored turns publish durable markdown products in `state.productRefs`. Product refs may also anchor process-defined side branches. The compatibility semantic refs are still maintained for legacy plan/review branch targeting and existing review UI behavior.

| Product | Published by | Consumed by | Purpose |
|---|---|---|---|
| `plan` | `generate_plan` | `review_plan`, `implement` | Current plan markdown; also updates the `plan` semantic ref and increments `process.planRevision`. The implementation review receives the original requested change instead of the plan; simplification consumes neither. |
| `review` | `review_plan`, `review_implementation` | implementation-review human actions through the compatibility semantic ref | Current plan/implementation review markdown; also updates the `review` semantic ref. |
| `simplification-plan` | `simplify_implementation` | simplification human actions through the product branch target | Current simplification plan markdown and branch anchor; does not update the compatibility `review` semantic ref. |
| `implementation-summary` | `implement` | chronicle views | Summary of implementation work. |
| `merge-resolution-summary` | `resolve_merge_conflict` | chronicle views | Summary of conflict resolution work. |

| Ref | Set by | Purpose |
|---|---|---|
| `rootEntry` | worker runtime | Compatibility fact for the current branch's first entry; fresh starts do not consume it |
| `currentPrimaryPathLeaf` | worker runtime / primary turns | Current primary-path leaf |
| `plan` | `generate_plan` product publication | Current plan compatibility ref; becomes the locked implementation plan once the process enters implementation |
| `review` | review product publication | Current review leaf compatibility ref |

## Pi tool policy

Each LLM turn declares its own built-in Pi `availableTools` array. The process session registers the union of those arrays (`read`, `bash`, `edit`, `write`), and each turn passes only its declared array as active tools while it runs.

All LLM sessions start in the cloned project's root through the process-level `sessionCwdTemplate = "{{{projectKey}}}"`; therefore `.` is the repository root for `read`, `bash`, `edit`, and `write`. They never start in the parent process workspace. Inspection turns (plan generation, reviews, simplification) use `read` for file contents and `bash` for read-only shell discovery (`git diff`, `git status`, `rg`, `tree`, file listing). Review prompts instruct the agent to keep shell usage read-only.

LLM prompts use direct repository actions (`Create`, `Review`, `Revise`, `Implement`) and avoid process narration such as acceptance by an “operator.” They speak in repository terms (`Repository root: .`, requested change, plan, rules) and do not expose instance-tree terms such as “primary path” to the coding agent.

Plan and review outcome tools explicitly allow useful Mermaid diagrams and uploaded images in their published Markdown. Worker-generated result guidance explains how to fence Mermaid source and upload images when that capability is available.

## Turn graph

| Turn ID | Turn type | Branch type | Context mode | Start selection | Active built-in tools | Active process tools | Transition(s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `import_plan` | server automatic | — | — | alternate process entry | — | publishes supplied `importedPlanMarkdown` as `plan` | `imported` → `implement` |
| `generate_plan` | LLM | `primary` | `fresh` | primary process entry; session root for ordinary prompts; targeted current-primary branch for `action_prompt` revisions | `read`, `bash` | publishes `plan` (`markdown_result`, compatibility `plan_saved`) | `plan_saved` → `plan_decision` (`waiting`); accepted plan-review guidance arrives as a targeted `action_prompt` on the primary branch when applicable |
| `plan_decision` | human | — | — | — | — | Visible actions: `approve_plan`, `request_revision`, `run_review` | action-driven |
| `review_plan` | LLM | `root_branch` | `full` | `semantic_ref(review)` with `session_root` fallback | `read`, `bash` | `markdown_result`, `no_issues`, `request_changes` | `no_issues` → `plan_decision` (`waiting`); `request_changes` → `plan_review_feedback` (`waiting`) |
| `plan_review_feedback` | human | — | — | — | — | Visible actions: `accept_review`, `request_review_changes`, `dismiss_review` | action-driven |
| `implement` | LLM | `primary` | `fresh_seeded` | `product_ref(simplification-plan)` → `semantic_ref(review)` → session root; prompt consumes `plan` product markdown | `read`, `bash`, `edit`, `write` | publishes `implementation-summary` (`markdown_result`, deterministic `turnEnd`) | `implementation-summary` → `implementation_decision` (`waiting`); normal plan approval starts with fresh context plus durable plan markdown, accepted implementation-review guidance arrives on the review branch, and accepted simplification guidance arrives on the `simplification-plan` product branch |
| `implementation_decision` | human | — | — | — | — | Visible actions: `finalize_change`, `request_revision`, `simplify`, `run_review` | action-driven |
| `simplify_implementation` | LLM | `root_branch` | `full` | `product_ref(simplification-plan)` with `session_root` fallback; prompt asks the worker to inspect the current workspace diff read-only | `read`, `bash` | publishes `simplification-plan` (`markdown_result`, deterministic `turnEnd`) | `simplification-plan` → `simplification_decision` (`waiting`) |
| `simplification_decision` | human | — | — | — | — | Visible actions: `accept_review`, `request_review_changes`, `dismiss_review` with simplification-specific labels | action-driven |
| `review_implementation` | LLM | `root_branch` | `full` | `semantic_ref(review)` with `session_root` fallback; prompt supplies the original requested change and asks the worker to inspect the current workspace diff read-only without consuming the plan | `read`, `bash` | `markdown_result`, `no_issues`, `request_changes` | `no_issues` → `implementation_decision` (`waiting`); `request_changes` → `implementation_review_feedback` (`waiting`) |
| `implementation_review_feedback` | human | — | — | — | — | Visible actions: `accept_review`, `request_review_changes`, `dismiss_review` | action-driven |
| `commit_and_merge` | automatic | `primary` | — | — | — | `merge_conflict`, `finalized` | Dirty changes are committed directly; `merge_conflict` → `resolve_merge_conflict`; `finalized` → `completed` |
| `resolve_merge_conflict` | LLM | `primary` | `full` | session root | `read`, `bash`, `edit`, `write` | publishes `merge-resolution-summary` plus `clean` | `clean` → `commit_and_merge` |

## Human-turn visible actions

| Human turn | Visible actions |
|---|---|
| `plan_decision` | `approve_plan`, `request_revision`, `run_review` |
| `plan_review_feedback` | `accept_review`, `request_review_changes`, `dismiss_review` |
| `implementation_decision` | `finalize_change`, `request_revision`, `simplify`, `run_review` |
| `simplification_decision` | `accept_review` (`Accept simplification plan`), `request_review_changes` (`Request simplification changes`), `dismiss_review` (`Reject simplification plan`) |
| `implementation_review_feedback` | `accept_review`, `request_review_changes`, `dismiss_review` |

## Server actions

| Action ID | Used on selected turn(s) | Acceptance state | Form | Behavior |
|---|---|---|---|---|
| `approve_plan` | `plan_decision` | `accepted` | none | Require `plan`; clear review/simplification branch refs; transition → `implement` |
| `request_revision` | `plan_decision`, `implementation_decision` | `requires_changes` | textarea `message` | Queue an `action_prompt` input carrying the operator note and targeting `currentPrimaryPathLeaf`; clear review/simplification branch refs; transition based on selected turn: `plan_decision` → `generate_plan`, `implementation_decision` → `implement`. The rerun resumes that branch without replaying the original kickoff prompt. |
| `run_review` | `plan_decision`, `implementation_decision` | `neutral` | none | Clear `review` and stale `simplification-plan`; implementation reviews inspect the workspace diff inside the worker turn; transition based on selected turn: `plan_decision` → `review_plan`, `implementation_decision` → `review_implementation` |
| `simplify` | `implementation_decision` | `neutral` | none | Clear `review` and stale `simplification-plan`, then transition → `simplify_implementation` for a read-only simplification review that inspects the workspace diff inside the worker turn |
| `accept_review` | `plan_review_feedback`, `implementation_review_feedback`, `simplification_decision` | `accepted` | optional textarea `message` | Require current review/simplification turn-result markdown; optionally include an operator adjustment; queue an `action_prompt` follow-up targeting `currentPrimaryPathLeaf` for plan reviews, `review` for implementation reviews, or product `simplification-plan` for simplification plans; transition based on selected turn: plan review → `generate_plan`, implementation review/simplification → `implement`. The rerun resumes that branch without replaying the original kickoff prompt. |
| `request_review_changes` | `plan_review_feedback`, `implementation_review_feedback`, `simplification_decision` | `requires_changes` | textarea `message` | Queue an `action_prompt` input carrying the operator’s review-on-review or simplification-plan note and targeting `review` for reviews or product `simplification-plan` for simplification; transition based on selected turn: plan review → `review_plan`, implementation review → `review_implementation`, simplification → `simplify_implementation`. The rerun resumes that branch without replaying the original kickoff prompt. |
| `dismiss_review` | `plan_review_feedback`, `implementation_review_feedback`, `simplification_decision` | `neutral` | none | Transition back to the matching decision turn; for simplification, reject the simplification plan and clear review plus `simplification-plan` branch refs |
| `finalize_change` | `implementation_decision` | `accepted` | none; visible label `Merge change` | Transition → `commit_and_merge`, which preflights publish targets, commits the completed workspace change, merges the latest base, publishes it, lands it on the local source repo's base branch when applicable, and pushes that source repo's base branch to its own `origin` when configured |

## Turn outcome handling

| Turn ID | Outcome | Server behavior |
|---|---|---|
| `generate_plan` | `plan_saved` | Publish product `plan`, emit `plan_saved` server event using `turnResultMarkdown`, update `state.productRefs.plan` / `semanticEntryRefs.plan`, and increment `process.planRevision`; clear review/simplification branch refs; transition → `plan_decision` with `lifecycleStatus = waiting` |
| `review_plan` | `no_issues` | Transition → `plan_decision` (`waiting`) |
| `review_plan` | `request_changes` | Keep the review turn result on semantic ref `review`; transition → `plan_review_feedback` (`waiting`) |
| `implement` | `implementation-summary` | Publish product `implementation-summary`; clear review/simplification branch refs; transition → `implementation_decision` with `lifecycleStatus = waiting` |
| `review_implementation` | `no_issues` | Transition → `implementation_decision` (`waiting`) |
| `review_implementation` | `request_changes` | Keep the review turn result on semantic ref `review`; transition → `implementation_review_feedback` (`waiting`) |
| `simplify_implementation` | `simplification-plan` | Publish the simplification plan as product ref `simplification-plan`; transition → `simplification_decision` (`waiting`) |
| `resolve_merge_conflict` | `clean` | Persist the helper-reported post-conflict HEAD sha for operator-facing metadata and mark `usedConflictResolution = true` |
| `commit_and_merge` | `merge_conflict` | Transition to `resolve_merge_conflict` and reset merge helper metadata |
| `commit_and_merge` | `finalized` | Transition → `completed`; persist finalization summary/head metadata in `state.finalization` |

This extension intentionally has no `LeitwerkFile` hooks or deploy/open-preview actions. Deployment/preview exposure is tracked centrally in [future.md](../../docs/future.md#deployment-and-preview-environments).

## Complete process tool catalog

### Built-in Pi tools

| Tool | Used by turns |
|---|---|
| `read` | `generate_plan`, `review_plan`, `implement`, `simplify_implementation`, `review_implementation`, `resolve_merge_conflict` |
| `bash` | `generate_plan`, `review_plan`, `implement`, `simplify_implementation`, `review_implementation`, `resolve_merge_conflict` |
| `edit` | `implement`, `resolve_merge_conflict` |
| `write` | `implement`, `resolve_merge_conflict` |

### Process tools

| Tool | Kind | Used by turns |
|---|---|---|
| `markdown_result` | publication | all LLM turns that publish operator-facing markdown |
| `plan_saved` | compatibility outcome | `generate_plan` |
| `implementation-summary` | deterministic `turnEnd` outcome / product publication | `implement` |
| `simplification-plan` | deterministic `turnEnd` outcome / product publication | `simplify_implementation` |
| `no_issues` | outcome | `review_plan`, `review_implementation` |
| `request_changes` | outcome | `review_plan`, `review_implementation` |
| `merge_conflict` | outcome | `commit_and_merge` |
| `finalized` | outcome | `commit_and_merge` |
| `clean` | outcome | `resolve_merge_conflict` |

### Tool activation matrix

| Tool | `generate_plan` | `review_plan` | `implement` | `simplify_implementation` | `review_implementation` | `commit_and_merge` | `resolve_merge_conflict` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `bash` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `edit` |  |  | ✓ |  |  |  | ✓ |
| `write` |  |  | ✓ |  |  |  | ✓ |
| `markdown_result` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `plan_saved` | ✓ |  |  |  |  |  |  |
| `implementation-summary` |  |  | turnEnd |  |  |  |  |
| `simplification-plan` |  |  |  | turnEnd |  |  |  |
| `no_issues` |  | ✓ |  |  | ✓ |  |  |
| `request_changes` |  | ✓ |  |  | ✓ |  |  |
| `merge_conflict` |  |  |  |  |  | ✓ |  |
| `finalized` |  |  |  |  |  | ✓ |  |
| `clean` |  |  |  |  |  |  | ✓ |

## Review outcome tool shape

| Option | Recommendation | Reason |
|---|---|---|
| Separate outcome tools: `no_issues` / `request_changes` | **Recommended** | Process contracts model transitions by `outcome`, so separate tool names preserve contract clarity, future-turn rendering, and validation. |
| Single outcome tool, e.g. `review_completed` with params `{ type, message }` | Possible but not preferred | The server can branch on `params.type`, but the process contract cannot express different transitions by param value. That weakens the turn graph and outcome validation. |

## Launcher

| Field | Kind | Required | Notes |
|---|---|---:|---|
| `repoLocator` | text | ✓ | Local path or remote git URL. The shared launcher UI remembers up to 5 recent values in browser-local storage when they do not look like credential-bearing absolute URLs. |
| `baseBranch` | text |  | Default `main` |
| `workBranch` | text |  | Optional working branch. Leave blank to derive one automatically. |
| `prompt` | textarea | ✓ | Requested change |

```ts
{
  processId: "local_repo_change_process",
  params: { launchKind: "requested_change", repoLocator, baseBranch, workBranch, prompt },
  // Explicit workBranch starts immediately with "generate_plan"; blank workBranch defers start.
  startTurnId: workBranch ? "generate_plan" : null,
  projects: [
    {
      key: "repo",
      repoLocator,
      baseBranch,
      workBranch: workBranch || null,
    },
  ],
}
```

## Process-analysis handoff import path

Local Repo Change needs an extension-specific cross-process handoff so process-analysis can pass a
reviewed analysis into implementation without regenerating its plan. This does not promote generic
process-to-process creation into the shared product model.

The extension provides its pure launch planner as an optional catalog capability. Process-analysis
uses `launchKind: "imported_plan"`, supplies `importedPlanMarkdown`, keeps source provenance in
opaque process metadata, and owns its stable deduplication key. Leitwerk converts the returned
canonical launch config through the Local Repo Change codecs and initial state before persistence.
Imported launches use launcher attribution `local_repo_change_process.imported_plan`.

If a work branch is supplied, the planner selects `import_plan`. If it is blank, launch defers.
Automatic work-branch assignment then replans through the same interface and atomically activates
`import_plan`. The hidden turn publishes the supplied markdown as the `plan` product, increments
the plan revision, clears stale review refs, and transitions directly to `implement`.
