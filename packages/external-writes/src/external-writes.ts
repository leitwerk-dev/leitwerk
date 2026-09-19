import type { ExternalWriteType } from "@leitwerk-dev/domain";
import type { ExternalWrites, WriteIdentity, WriteOperation } from "./contracts.js";

/** @internal */
export class ExternalWriteMissingRemoteError extends Error {
	/** @internal */
	readonly identity: WriteIdentity;
	/** @internal */
	constructor(identity: WriteIdentity) {
		super(
			`Recorded external write ${identity.writeType} (${identity.dedupKey}) has no recoverable remote object`,
		);
		this.name = "ExternalWriteMissingRemoteError";
		this.identity = { ...identity };
	}
}

/** @internal */
export interface ExternalWriteLogRecordInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	writeType: ExternalWriteType;
	/** @internal */
	dedupKey: string;
	/** @internal */
	metadata?: Record<string, unknown>;
}

/** @internal */
export interface ExternalWriteLogRepoLike {
	/** @internal */
	hasDedupKey(dedupKey: string): boolean;
	/** @internal */
	record(input: ExternalWriteLogRecordInput): unknown;
}

/** @internal */
export function recordWriteIfMissing(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	metadata: Record<string, unknown> = {},
): void {
	if (repo.hasDedupKey(identity.dedupKey)) return;

	try {
		repo.record({
			instanceId,
			writeType: identity.writeType,
			dedupKey: identity.dedupKey,
			metadata,
		});
	} catch (error) {
		if (!repo.hasDedupKey(identity.dedupKey)) throw error;
	}
}

const queues = new WeakMap<ExternalWriteLogRepoLike, Map<string, Promise<void>>>();

async function serialize<T>(repo: ExternalWriteLogRepoLike, key: string, run: () => Promise<T>) {
	let queue = queues.get(repo);
	if (!queue) {
		queue = new Map();
		queues.set(repo, queue);
	}
	const result = (queue.get(key) ?? Promise.resolve()).then(run);
	const settled = result.then(
		() => {},
		() => {},
	);
	queue.set(key, settled);
	try {
		return await result;
	} finally {
		if (queue.get(key) === settled) queue.delete(key);
	}
}

/** @internal */
export function bindExternalWrites(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
): ExternalWrites {
	return {
		ensure<T extends NonNullable<unknown>>(identity: WriteIdentity, operation: WriteOperation<T>) {
			return serialize(repo, identity.dedupKey, async () => {
				const recorded = repo.hasDedupKey(identity.dedupKey);
				const existing = await operation.reconcile(
					recorded ? "already_recorded" : "before_execute",
				);
				if (recorded) {
					if (existing === null) throw new ExternalWriteMissingRemoteError(identity);
					return existing;
				}
				const record = (value: T) => {
					recordWriteIfMissing(repo, instanceId, identity, operation.toMetadata(value));
					return value;
				};
				if (existing !== null) return record(existing);
				let value: T;
				try {
					value = await operation.execute();
				} catch (executionError) {
					try {
						const recovered = await operation.reconcile("after_execute_error");
						if (recovered !== null) return record(recovered);
					} catch (recoveryError) {
						throw new AggregateError(
							[executionError, recoveryError],
							"External write execution and recovery failed",
							{ cause: executionError },
						);
					}
					throw executionError;
				}
				return record(value);
			});
		},
		logOnly: (identity, execute) =>
			serialize(repo, identity.dedupKey, async () => {
				if (!repo.hasDedupKey(identity.dedupKey))
					recordWriteIfMissing(repo, instanceId, identity, await execute());
			}),
	};
}
