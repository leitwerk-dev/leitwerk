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
export interface WriteRecordingResult {
	/** @internal */
	recorded: boolean;
	/** @internal */
	dedupKey: string;
}

/** @internal */
export function recordWriteIfMissing(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	metadata: Record<string, unknown> = {},
): WriteRecordingResult {
	if (repo.hasDedupKey(identity.dedupKey)) {
		return { recorded: false, dedupKey: identity.dedupKey };
	}

	try {
		repo.record({
			instanceId,
			writeType: identity.writeType,
			dedupKey: identity.dedupKey,
			metadata,
		});
	} catch (error) {
		if (repo.hasDedupKey(identity.dedupKey)) {
			return { recorded: false, dedupKey: identity.dedupKey };
		}
		throw error;
	}

	return { recorded: true, dedupKey: identity.dedupKey };
}

const queues = new WeakMap<ExternalWriteLogRepoLike, Map<string, Promise<void>>>();

/** @internal */
export function ensureWrite<T extends NonNullable<unknown>>(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	operation: WriteOperation<T> & {
		/** @internal */
		mode: "reconcile";
	},
): Promise<T>;
/** @internal */
export function ensureWrite(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	operation: {
		/** @internal */
		mode: "log_only";
		/** @internal */
		execute(): Promise<Record<string, unknown>>;
	},
): Promise<void>;
/** @internal */
export async function ensureWrite<T extends NonNullable<unknown>>(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	operation:
		| (WriteOperation<T> & {
				/** @internal */
				mode: "reconcile";
		  })
		| {
				/** @internal */
				mode: "log_only";
				/** @internal */
				execute(): Promise<Record<string, unknown>>;
		  },
): Promise<T | undefined> {
	let queue = queues.get(repo);
	if (!queue) {
		queue = new Map();
		queues.set(repo, queue);
	}
	const previous = queue.get(identity.dedupKey);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	queue.set(identity.dedupKey, pending);
	await previous;
	try {
		const dedupKey = identity.dedupKey;
		const recorded = repo.hasDedupKey(dedupKey);
		if (operation.mode === "log_only") {
			if (recorded) return;
			const metadata = await operation.execute();
			recordWriteIfMissing(repo, instanceId, identity, metadata);
			return;
		}
		const existing = await operation.reconcile(recorded ? "already_recorded" : "before_execute");
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
			let recovered: T | null;
			try {
				recovered = await operation.reconcile("after_execute_error");
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
	} finally {
		release();
		if (queue.get(identity.dedupKey) === pending) queue.delete(identity.dedupKey);
	}
}

/** @internal */
export function bindExternalWrites(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
): ExternalWrites {
	return {
		ensure: (identity, operation) =>
			ensureWrite(repo, instanceId, identity, { ...operation, mode: "reconcile" }),
		logOnly: (identity, execute) =>
			ensureWrite(repo, instanceId, identity, { mode: "log_only", execute }),
	};
}
