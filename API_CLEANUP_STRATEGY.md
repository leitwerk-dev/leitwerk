# API cleanup strategy

## Scope

Treat leitwerk and the leitwerk-rsnc, leitwerk-public, and leitwerk-private
installations as the complete consumer universe. Remove APIs and implementations
unused within that universe. Public/preview annotations do not require preserving
unused APIs or supporting hypothetical consumers.

Preserve production behavior, dynamic entry points, useful test infrastructure,
and durable data. Static absence alone does not establish runtime absence.

## Baseline

The inspected report contains 2,137 findings: 1,324 proposed package-exposure
reductions and 813 retained findings. Separately, declaration assessments retain
2,104 declarations and require review of 33. These counts will change after refresh.

Analysis ID: `eba503a885796f5155035ad10ad0291bcf2b17a02d7556982e624f1fff09cbb8`.

Coverage is incomplete. The catalog reports core 0.2.0; public/private consumers
report 0.1.9. Positive usage remains evidence; missing usage requires investigation.

## Execution

1. **Refresh evidence.** Use the workspace collection in
   `.leitwerk/api-explorer/local.json`. Verify each installation's selected core,
   build sequentially, and regenerate catalog and consumer reports. Resolve
   version mismatches and unresolved imports sufficiently to map actual consumers
   to the target code. Distinguish report limitations from missing dependencies.
   Do not omit installations or switch their dependency modes to hide gaps.
2. **Establish retained roots.** Include production entry points, configured
   integrations, dynamically loaded extensions/processes, and useful tests. Trace
   imports and signature dependencies from those roots. Check runtime registration
   and initializer effects before deleting code.
3. **Classify every finding and route.** Apply the decision table below. Record
   analysis ID, finding/route IDs, evidence, disposition, prerequisites, owner,
   commit/PR, and validation. Unresolved evidence remains explicitly blocked.
4. **Remove in dependency order.** Investigate the 33 declaration-review findings
   first. Then process exposure reductions by package and entry point, starting
   with small internal changes. Migrate consumers before removing routes they use.
   Reassess the 813 retained findings: references from an unused dependency chain
   do not justify retaining that chain.
5. **Validate and repeat.** Refresh reports after each completed batch. Reconcile
   findings with the previous analysis and inspect newly unused declarations,
   types, routes, and dependencies. Continue until every finding is resolved.

## Decisions

| Established usage | Action |
| --- | --- |
| None, including runtime and useful tests | Delete declaration and exports |
| Only within the declaring file | Make file-local |
| Only within the package | Remove package exposure; preserve required module exports |
| Across packages or installations | Retain required routes or migrate consumers first |
| Only through otherwise unused declarations | Delete the unused dependency group |
| Only in tests | Preserve useful support; remove obsolete tests with obsolete behavior |
| Unresolved | Investigate before removal |

Decide separately for each export route and its declaration. A retained signature
can require a type without requiring every barrel alias. Introduce a narrow entry
facade where needed to separate package exposure from internal module access.
Use compatibility shims only when actual installation rollout requires them.

## Commit checkpoints

Commit throughout execution. Each commit should contain one coherent change,
usually within one package and covering roughly 5–15 related candidates. Use
smaller commits for runtime-sensitive changes; keep coupled edits together when
splitting would break an intermediate state.

- Keep evidence/tooling repairs separate from application cleanup.
- Add replacement routes or facades before migrating consumers.
- Commit consumer migrations by package or installation while old routes remain.
- Separate export removal from implementation deletion where practical.
- Delete unused dependency groups with their obsolete tests and affected docs.
- Exclude unrelated formatting and refactoring.

For cross-repository changes, record the commit order:
**add replacement → migrate installations → remove old API**. Revert in reverse
order. Record prerequisite commits so selective fixes and reversions are explicit.

Use Conventional Commit messages and `git commit -s`. Include addressed finding
IDs, validation results, and prerequisites in commit bodies.

## Validation

Before proceeding past each application commit, pass `npm run test:full` and
affected installation build/test checks. Rebuild before separate Vitest runs;
never edit generated `dist/` files. Smoke-test affected dynamic entry loading.

Documentation-only changes require diff review. Changes confined to the explorer
use `npm run check --prefix tools/api-explorer-prototype`, plus focused browser
checks for UI changes, as required by `AGENTS.md`.

Preserve core/extension import boundaries and package-specifier imports in
top-level tests. Update documentation for changed contracts and extension behavior;
update `leitwerk.yaml.example` if config keys change. Before merge, confirm
`Full validation` and `Conventional PR title and DCO` pass.

## Completion

Every baseline and newly discovered finding has an evidence-backed disposition.
Every remaining API under review has a concrete consumer, runtime role, or useful
testing purpose within the installations. Unused candidates are removed and all
installations validate. Track removed routes and deleted declarations separately.
Any deferred item retains an owner and an explicit unblock condition; it is not
counted as complete.
