# Find a previous resolution

A throwaway operator experiment. Open `index.html` directly in a browser; no build, server or network is needed. All records are synthetic and live only in memory. Reset restores the fixtures.

The question: can previous incidents help an operator investigate without presenting a once-successful action as today's safe answer?

Search failure, intervention and subsequent-observation text, filter by exact repository and process type, and open the retained execution. Compare its context with the current incident. Notes belong to the current investigation; saved references retain source identity. Removing source evidence clears its text from search and details while preserving the investigation draft. The current process remains in `error`; no recovery action is executed.

This differs from the earlier recovery assistant and topic knowledge: the central object is an actual historical incident sequence, including unresolved and causally ambiguous cases. It makes no diagnosis or recommendation.

## Walkthroughs

1. **A useful but older incident:** narrow HTTP 401 matches, read retained expiry evidence, record the current applicability gap and save its source.
2. **Recovery is not proof of cause:** inspect a retry overlapping provider recovery. The records cannot establish which caused success.
3. **A retained reference loses its source:** remove evidence after saving its identity. It disappears from search and cannot be added again from the unavailable view.

Free play also supports empty search results, different repositories with similar names, process-type intersections, startup recovery distinct from accepted-turn retry, duplicate references and arbitrary investigation notes. Guided refusals require the intended unavailable source and saved reference, rather than any failed action.

## Integration seams and proposed contracts

- `packages/server/src/db/process-instance-repo.ts` currently searches title, external ID, process ID and parameters, not failure/intervention content.
- `packages/server/src/db/process-event-repo.ts` retains typed, correlated process events; `packages/domain/src/domain-model.ts` provides turn-record error summaries and lineage.
- `packages/server/src/process-inspection-reader.ts` and `packages/ui/src/pages/process-detail/inspector/ExecutionDetails.svelte` provide exact retained execution evidence.
- `docs/topic-wiki.md` describes reusable topic evidence. Historical case references should link relevant existing knowledge rather than create a second wiki.

Production would need a bounded read-only historical index, typed failure/intervention/observation projections, and deletion/redaction-consistent search and detail reads. Persisted investigation notes and references would need separately migrated operator metadata. None of those additions are implemented here. Lifecycle, selected-turn ownership, turn acceptance and recovery remain existing server responsibilities.

## Validation and limits

Observed checks: all three browser walkthroughs; real typed notes and filter changes; empty and exact-identity matches; draft/reference preservation; deletion-consistent source views; unavailable refusal and unchanged current lifecycle. Desktop 1440px and mobile 390px captures were opened and inspected, with no horizontal overflow or browser errors. Biome, extracted JavaScript syntax and diff whitespace checks passed. The design detector ran in degraded regex mode and reported no findings; it is not a complete design audit.

Four deterministic fixtures stand in for a real index. Keyword matching has no ranking, semantic retrieval or confidence scoring. Reference labels are identity metadata, not cached source evidence. No real retention, external systems, persistence or recovery actions are connected.

Provisional learning: an incident sequence is useful only when subsequent success and causal confidence are separate. Keeping current-investigation notes independent of the selected historical case preserves uncertainty while the operator compares alternatives.
