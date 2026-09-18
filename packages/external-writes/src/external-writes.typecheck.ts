import type { ExternalWrites, WriteIdentity } from "./index.js";

// Compiled but never called: preserve value inference and reject legacy usage.
async function check(writes: ExternalWrites, identity: WriteIdentity) {
	const result = await writes.ensure(identity, {
		execute: async () => ({ id: 1 }),
		reconcile: async () => null,
		toMetadata: (value) => ({ id: value.id }),
	});
	const value: number = result.id;
	// @ts-expect-error Execution status is not exposed.
	result.status;
	// @ts-expect-error Deduplication keys are not returned.
	result.dedupKey;
	const log = await writes.logOnly(identity, async () => ({ value }));
	// @ts-expect-error Log-only operations do not return a remote value.
	log.value;
	// @ts-expect-error The old callback form is no longer supported.
	await writes.ensure(identity, async () => ({}));
	await writes.ensure(identity, {
		// @ts-expect-error Reconciliation cannot execute to a nullish value.
		execute: async () => null,
		reconcile: async () => null,
		toMetadata: () => ({}),
	});
	// @ts-expect-error Reconciliation requires metadata extraction.
	await writes.ensure(identity, {
		execute: async () => 1,
		reconcile: async () => null,
	});
	// @ts-expect-error Results are remote values, not execution outcomes.
	const missing: typeof result = { status: "already_recorded", dedupKey: "key" };
	return missing;
}
void check;
