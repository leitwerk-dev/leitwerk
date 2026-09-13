import type { ExternalWriteType } from "@leitwerk-dev/domain";

export interface WriteIdentity {
	writeType: ExternalWriteType;
	dedupKey: string;
}

export interface ExternalWriteLogRecordInput {
	instanceId: string;
	writeType: ExternalWriteType;
	dedupKey: string;
	metadata?: Record<string, unknown>;
}

export interface ExternalWriteLogRepoLike {
	hasDedupKey(dedupKey: string): boolean;
	record(input: ExternalWriteLogRecordInput): unknown;
}

export interface EnsureWriteResult {
	performed: boolean;
	dedupKey: string;
}

export function createWriteIdentity(writeType: ExternalWriteType, dedupKey: string): WriteIdentity {
	return { writeType, dedupKey };
}

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
