import type { ExternalWriteType } from "@leitwerk-dev/domain";

/** @public */
export interface WriteIdentity {
	/** @internal */
	writeType: ExternalWriteType;
	/** @internal */
	dedupKey: string;
}

/** @public */
export interface ExternalWriteLogRecordInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	writeType: ExternalWriteType;
	/** @public */
	dedupKey: string;
	/** @internal */
	metadata?: Record<string, unknown>;
}

/** @public */
export interface ExternalWriteLogRepoLike {
	/** @public */
	hasDedupKey(dedupKey: string): boolean;
	/** @public */
	record(input: ExternalWriteLogRecordInput): unknown;
}

/** @public */
export interface EnsureWriteResult {
	/** @internal */
	performed: boolean;
	/** @internal */
	dedupKey: string;
}

/** @public */
export function createWriteIdentity(writeType: ExternalWriteType, dedupKey: string): WriteIdentity {
	return { writeType, dedupKey };
}

/** @internal */
export function recordWriteIfMissing(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	metadata: Record<string, unknown> = {},
): EnsureWriteResult {
	if (repo.hasDedupKey(identity.dedupKey)) {
		return { performed: false, dedupKey: identity.dedupKey };
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
			return { performed: false, dedupKey: identity.dedupKey };
		}
		throw error;
	}

	return { performed: true, dedupKey: identity.dedupKey };
}

/** @public */
export async function ensureWrite(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	execute: () => Promise<Record<string, unknown>>,
): Promise<EnsureWriteResult> {
	if (repo.hasDedupKey(identity.dedupKey)) {
		return { performed: false, dedupKey: identity.dedupKey };
	}

	return recordWriteIfMissing(repo, instanceId, identity, await execute());
}
