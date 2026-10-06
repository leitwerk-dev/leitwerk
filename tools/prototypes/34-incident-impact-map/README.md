# Shared incident impact

Open `index.html` directly in a browser. This standalone, synthetic experiment keeps all state in memory; Reset restores the current walkthrough's starting fixture.

The operator question: can comparing failures reduce duplicate investigation without making temporal coincidence look like proven causation?

The page groups included processes by exact observed provider, repository, runner or failure minute. Inspect each retained failure source, add or remove investigation members, and record either an unknown cause or a bounded provider suspicion. Unrelated and missing evidence stay visible. Notes never retry or change a process; all five synthetic processes retain lifecycle `error` and their selected turn.

Unlike the earlier external-wait radar, this investigates cross-process failures and contradictory evidence. Unlike historical resolution search, it compares one current incident rather than previous remedies.

## Walkthroughs and free play

1. **Narrow a plausible shared cause:** inspect two provider timeouts, remove a repository failure and missing source, and record an explicitly unconfirmed hypothesis.
2. **Missing evidence keeps cause unknown:** inspect the repository error and absent audit source. The shared-provider hypothesis is refused; record the evidence gap instead.
3. **Evidence changes while drafting:** inspect gateway, draft a note, then receive a later observation. The old inspection cannot authorize the note; the draft survives until reinspection.

Free play supports membership changes, empty scope, grouping, typed investigation notes, source removal and later observations. Recording a provider suspicion conservatively requires at least two currently inspected retained failures at the same provider and no unrelated or unknown included member. This is an experiment rule, not an existing production diagnosis policy. Even a permitted suspicion remains unconfirmed.

Each saved note captures source IDs, observation versions, source availability and membership. Later changes label it historical without rewriting the note. Source removal clears the retained failure body; receipts retain operator-authored notes and identity metadata, not cached source bodies.

## Integration seams and proposals

- `packages/server/src/routes/process-diagnostics-assembler.ts` captures durable process, project, event, turn, launch and lease evidence before reading session data.
- `packages/server/src/db/process-event-repo.ts` provides process- and turn-correlated events with durable event sequences.
- `packages/server/src/supervisor/record-worker-lifecycle-event.ts` records lifecycle facts and broadcasts durable process event frames.
- `packages/server/src/routes/process-detail.ts` exposes current process details and associated project/lease observations.

Production needs a bounded cross-process incident projection with typed retained source identities and observation boundaries. Persisted investigation membership, drafts and assessments would need new migrated operator metadata and explicit redaction rules. This prototype introduces no shared runtime contract, recovery policy, bulk retry, automatic model switch, deployment or real external publication.

## Validation and learning

Browser checks exercised all three walkthroughs and real free play: wrong refusal gating, stale inspection, draft preservation, unknown and contradictory evidence, grouping, membership, source removal, empty scope and unchanged lifecycle. Captures at desktop 1440px and mobile 390px were opened and inspected. No horizontal overflow or browser errors were observed. Scoped Biome, extracted JavaScript syntax and whitespace checks passed. The design detector ran once in degraded regex mode with no findings; selector and computed-contrast analysis were unavailable.

Five deterministic fixtures model no real provider, event stream, authorization or persistence. Recorded times and identities are illustrative. Operator-authored notes can retain a human interpretation after source removal and must remain visibly distinct from retained evidence.

Provisional learning: keeping counter-evidence in view makes scope narrowing reviewable. A shared dependency earns an investigation hypothesis only; later reachability does not explain an earlier failure or mark the incident resolved.
