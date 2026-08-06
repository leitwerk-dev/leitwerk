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

function alreadyWrittenResult(identity: WriteIdentity): EnsureWriteResult {
	return { performed: false, dedupKey: identity.dedupKey };
}

function performedWriteResult(identity: WriteIdentity): EnsureWriteResult {
	return { performed: true, dedupKey: identity.dedupKey };
}

function recordWrite(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	metadata: Record<string, unknown>,
): EnsureWriteResult {
	if (repo.hasDedupKey(identity.dedupKey)) {
		return alreadyWrittenResult(identity);
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
			return alreadyWrittenResult(identity);
		}
		throw error;
	}

	return performedWriteResult(identity);
}

export function recordWriteIfMissing(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	metadata: Record<string, unknown> = {},
): EnsureWriteResult {
	return recordWrite(repo, instanceId, identity, metadata);
}

export async function ensureWrite(
	repo: ExternalWriteLogRepoLike,
	instanceId: string,
	identity: WriteIdentity,
	execute: () => Promise<Record<string, unknown>>,
): Promise<EnsureWriteResult> {
	if (repo.hasDedupKey(identity.dedupKey)) {
		return alreadyWrittenResult(identity);
	}

	return recordWrite(repo, instanceId, identity, await execute());
}
