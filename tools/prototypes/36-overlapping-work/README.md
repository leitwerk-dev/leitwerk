# Overlapping work

A standalone operator experiment for concurrent processes that reference the same external resource. Open `index.html` directly in a browser. It needs no server, dependencies, network access, or credentials. All data is synthetic and stays in memory; reset, starting a guided case, or reloading clears it.

## Question

Which overlap signals are strong enough to interrupt an operator, and which should remain a quiet relationship link?

Two independent processes can touch the same repository branch or PR. A shared ticket may instead represent legitimate work on separate components. The interface exposes the precise match, opens the two current Chronicles together, and keeps coordination separate from business state.

This differs from the prior prototype batch by using exact recorded identities to reveal concurrent collisions. It does not forecast capacity, preflight launches, compare hypothetical outcomes, or infer similarity from prose.

## What to try

The overlap table computes matches across four fixture processes. A repository plus work branch, or a repository plus external PR identifier, produces “Review write destination.” An exact ticket URL alone produces “Related by ticket.” Identical titles, branch names, ticket numbers, and PR numbers on different source hosts produce no match. The pair picker also opens pairs absent from the overlap table, so changed or unrelated work remains inspectable.

Review the identities and record a reason for intentional overlap. Notes are bound to the process pair and reviewed identity boundary. An identity or availability revision makes an earlier acknowledgement historical; reviewing again does not silently renew that acknowledgement. A new acknowledgement requires an explicit action. Both processes retain their lifecycle.

The right Chronicle has a simulated ordinary instruction control. Queueing retains a visible receipt and does not claim delivery or external success. Unsent instructions and acknowledgement reasons survive unrelated updates, pair navigation, and refusals. They persist for the lifetime of this page, not across reloads.

Outside-change controls change the right process's write destination, mark it completed, or make its identity source unavailable. These are fixture events, separate from operator actions. Missing identity evidence is unknown; completed pairs leave the concurrent overlap projection but remain accessible through the pair picker.

## Three walkthroughs

1. **Shared destination:** review the gateway/header pair, open the right Chronicle controls, prepare an instruction, and queue it. The recorded branch and PR match exactly; the instruction affects only the chosen process.
2. **Intentional components:** review the gateway/documentation pair, prepare a reason, and acknowledge intentional overlap. Both remain active, with separate branches and one shared ticket.
3. **Changed after review:** review and prepare a reason, simulate a shared write destination, and try the earlier acknowledgement. It refuses stale consent and retains the reason. Review the changed identities, then explicitly acknowledge the current boundary.

Each next-step button requires the guide’s ordered pair: P-204 + P-211 for Shared destination, or P-204 + P-208 for the other cases. Selecting another pair refuses before any guided action or progression and preserves every pair’s drafts. Return to the named pair to continue. The stale-refusal step also requires the guide’s earlier reviewed signature and its changed identities; another review cannot substitute for that boundary.

## Integration seams

These paths were inspected in the repository. The experiment does not import or modify them.

- `packages/domain/src/domain-model.ts`: `ProcessInstance.externalId` / `externalUrl`, lifecycle, and `ProcessProject.repoLocator` / `workBranch` / `externalId` / `externalUrl` supply observable identities. The generic short external ID alone is not globally unique.
- `packages/server/src/routes/process-detail.ts`: `/api/processes` includes projects; inspection and primary-path routes provide exact process evidence.
- `packages/server/src/process-overview-presenter.ts`: `buildProcessOverviewItem` and existing bounded browsing are candidates for a read-only overlap projection. A bounded page must not be presented as exhaustive collision coverage.
- `packages/server/src/routes/process-actions.ts`: the existing `/api/processes/:instanceId/steer` route queues operator instructions through the process engine. Production actions retain their authoritative server validation and exclusive process coordination.
- `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte` and `process-detail-mutations.svelte.ts`: canonical Chronicle controls and mutation-error handling should remain the destination for real interventions.
- `docs/operator-guide.md`: instruction queueing, stopping, aborting, and the inability to reverse committed external writes define the operational contract.

## Proposed additions

A production overlap projection needs owner-resolved, source-scoped identity keys, resource kinds, observation revisions, freshness/availability, and explicit query coverage. The prototype uses exact synthetic URLs and repository-scoped IDs; it does not attempt URL alias normalization or claim generic `externalId` is always a ticket.

Persistent acknowledgement reasons would be new server-owned operator metadata, requiring a migration and a conflict check against the reviewed pair/identity revision. They must not become process inputs, action permissions, lifecycle states, branch locks, deduplication rules, or cross-process coordination. Existing integration writes still need their normal idempotency contract.

## Validation and provisional learning

Browser validation exercised all three guides with actual clicks, including the exact stale-review refusal. Free play used typed reasons and instructions to check acknowledgement, queueing, preserved drafts across pair navigation and rejected actions, stale historical notes after reinspection, no-match source scoping, unavailable identity evidence, terminal-action refusal, and the empty overlap projection.

After the guide-subject fix, browser clicks completed all three guides again and attempted every step on the unrelated P-204 + P-219 pair. Every mismatch refused without mutation or progression, retaining both intended and unrelated drafts; only P-211 received the shared-destination instruction. The changed-review case also refused when a newer free-play review replaced its earlier guided boundary.

Desktop (1440px) and mobile (390px) screenshots were refreshed and opened after the fix and are in `screenshots/`. The page is inspected at both sizes, including horizontal overflow and browser error checks. Biome, inline JavaScript syntax, and whitespace checks apply to this standalone helper; application validation is outside this isolated scope. The Impeccable detector returned no regex findings but ran in degraded mode because HTML parser modules were unavailable. Computed contrast and CSS selector analysis were not provided by that detector.

The provisional rule is to surface shared write destinations for review and retain ticket-only matches as quiet relationships. An acknowledgement should name the exact boundary and remain visible when stale. This is a design hypothesis from synthetic interaction checks, not an operator study or evidence that the threshold is sufficient in production.

Limits: one project identity per fixture process, no network or actual Chronicle routing, no durable storage, no live permission model, and no real process or external-system mutations. Production multi-project matching, source alias normalization, retained-source redaction, and bounded query coverage need further design.
