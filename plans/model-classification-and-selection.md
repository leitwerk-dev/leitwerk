# Model classification and deterministic selection

Status: implemented. The supported contract lives in [Models](../docs/models.md),
with SDK declarations in [Process SDK](../docs/process-sdk.md), controls in
[UI](../docs/ui.md), and admission rules in [Watchers](../docs/watchers.md).

## Decision rationale

- **D1/D1a — Cost values are ordinary labels.** A separate cost field would create
  overlapping matching and specificity rules. Operators own cost assertions;
  missing or zero provider prices do not prove free usage. First matching cost
  label determines ordering, so missing/multiple cost labels need no special
  validation or warning.
- **D2 — All labels affect specificity.** One label collection avoids a second
  suitability ranking system and arbitrary weights. Organization and cost labels
  therefore are not decorative: adding an unrelated label can change the winner.
- **D3 — Preserve existing default precedence.** Eligible inherited defaults win
  before marked-default ranking, preserving existing installations' selections.
  Policy incompatibility permits skipping a preference; unknown configuration or
  unavailable selected models do not permit substitution.
- **D4/D4a/D4b — Admission depends on launch source; execution policy does not.**
  UI and programmatic launches, and UI-created schedules, check every declared
  LLM turn so optional branches cannot hide readiness failures. Watchers and due
  schedules retain intent and defer blocks to the affected turn, preserving event
  acknowledgement and deduplication rather than encouraging duplicate launches.
- **D5 — Recovery preserves capture; operator retry creates a preparation.** An
  availability transition is not operator intent to switch models after a settings
  edit. Automatic recovery rechecks captured identity; a new operator preparation
  may refresh inherited choices. Launch/action choices remain pinned unless cleared.
- **D6 — Optional title failure does not block business work.** Title jobs enforce
  process policy at queue and dispatch without substituting models. Required
  fixed-purpose turns still block normally.

## Boundaries and compatibility

Classification is static startup policy, not learned routing, provider failover,
price inference, a budget mechanism, or tenant/network isolation. Dynamic
repository/instance-derived requirements remain in [Future](../docs/future.md).

New provenance sources extend serialized JSON without a SQLite schema change.
Upgrade server and workers together; old decoders cannot read new sources after
writes. Captured execution identity remains distinct from current policy metadata.
See [Models](../docs/models.md#classification-and-requirements) for rollout rules
and [Security](../docs/security.md) for the trusted-extension boundary.
