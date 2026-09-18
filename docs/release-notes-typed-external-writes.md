# Typed external writes

Release title: `feat(external-writes)!: bind typed write coordination to tool context`

BREAKING CHANGE: Replace callback-based `ensureWrite` calls with
`ctx.externalWrites.ensure(identity, { execute, reconcile, toMetadata })`.
The method returns the remote value directly, including on replay. A logged write
whose remote object cannot be recovered fails without recreating it.

For operations without recoverable remote identity, use
`ctx.externalWrites.logOnly(identity, execute)`, which returns `void`.
Neither method returns `performed`, execution status, or a deduplication key.
Tools that previously returned write-helper outcomes now return the remote object.
Replace `createWriteIdentity` with an object literal. Storage APIs are available
only through the unsupported `/internal` entry point.

External consumers, including `../leitwerk-private`, must follow the
[SDK migration guide](process-sdk.md#typed-external-writes). Existing durable
records and remote markers remain valid; historical unmarked writes may not be
recoverable. No schema or configuration change is required.
