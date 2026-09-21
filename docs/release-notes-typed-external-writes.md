# Typed external writes

Release title: `feat(external-writes)!: bind typed write coordination to tool context`

BREAKING CHANGE: Replace `ensureWrite` with the process-bound
`ctx.externalWrites.ensure` or `ctx.externalWrites.logOnly` API.

External consumers, including `../leitwerk-private`, must follow the
[SDK migration guide](process-sdk.md#typed-external-writes) for return values,
reconciliation semantics, and storage API changes. No schema or configuration
change is required.
