import type { PiTreeEntry } from "@leitwerk-dev/process-sdk";

export type PiBranchOperation = "prompt" | "continue";

export class PiBranchDriftError extends Error {
	readonly errorClass = "infrastructure" as const;
	readonly failureCode = "branch_drift" as const;
	readonly recoveryContext = null;
	readonly restorePrimaryLeaf = false;
	readonly operation: PiBranchOperation;
	readonly anchorEntryId: string | null;
	readonly rejectedResultEntryId: string;
	readonly failureDetails: Record<string, unknown>;

	constructor(input: {
		operation: PiBranchOperation;
		anchorEntryId?: string | null;
		rejectedResultEntryId: string;
		reason?: string;
	}) {
		const anchorEntryId = input.anchorEntryId ?? null;
		super(
			input.reason ??
				(anchorEntryId
					? `Pi ${input.operation} result branch drifted: result entry '${input.rejectedResultEntryId}' is not on the branch anchored at '${anchorEntryId}'`
					: `Pi ${input.operation} result branch drifted: result entry '${input.rejectedResultEntryId}' is not on the branch selected before the turn`),
		);
		this.name = "PiBranchDriftError";
		this.operation = input.operation;
		this.anchorEntryId = anchorEntryId;
		this.rejectedResultEntryId = input.rejectedResultEntryId;
		this.failureDetails = {
			operation: input.operation,
			anchorEntryId,
			rejectedResultEntryId: input.rejectedResultEntryId,
		};
	}

	toTurnFailureOptions() {
		return {
			recoveryContext: this.recoveryContext,
			restorePrimaryLeaf: this.restorePrimaryLeaf,
			failureCode: this.failureCode,
			failureDetails: this.failureDetails,
		};
	}
}

export function isPiBranchDriftError(error: unknown): error is PiBranchDriftError {
	return (
		error instanceof PiBranchDriftError ||
		(error instanceof Error &&
			error.name === "PiBranchDriftError" &&
			(error as { failureCode?: unknown }).failureCode === "branch_drift" &&
			typeof (error as { toTurnFailureOptions?: unknown }).toTurnFailureOptions === "function")
	);
}

export function resolveExecutionAnchorEntryId(input: {
	operation: PiBranchOperation;
	startLeafId: string | null;
	createdEntries: readonly PiTreeEntry[];
}): string | null {
	return input.operation === "continue"
		? (input.startLeafId ?? input.createdEntries[0]?.id ?? null)
		: (input.createdEntries.find((entry) => entry.message?.role === "user")?.id ??
				input.createdEntries[0]?.id ??
				input.startLeafId ??
				null);
}

export function assertResultStayedOnExecutionBranch(input: {
	operation: PiBranchOperation;
	startLeafId: string | null;
	beforeEntryIds: ReadonlySet<string>;
	anchorEntryId: string | null;
	resultEntryId: string | null;
	getBranch(entryId: string): PiTreeEntry[];
}): void {
	const { anchorEntryId, beforeEntryIds, getBranch, operation, resultEntryId, startLeafId } = input;
	if (!resultEntryId) return;
	const resultBranch = getBranch(resultEntryId);
	const resultBranchIds = new Set(resultBranch.map((entry) => entry.id));
	const reject = (reason?: string): never => {
		throw new PiBranchDriftError({
			operation,
			anchorEntryId,
			rejectedResultEntryId: resultEntryId,
			reason,
		});
	};
	if (
		!resultBranchIds.has(resultEntryId) ||
		(anchorEntryId && !resultBranchIds.has(anchorEntryId))
	) {
		reject();
	}
	if (startLeafId && !resultBranchIds.has(startLeafId)) {
		reject(`Pi ${operation} branch drifted away from the selected leaf '${startLeafId}'`);
	}
	if (!startLeafId && resultBranch.some((entry) => beforeEntryIds.has(entry.id))) {
		reject(`Pi ${operation} branch drifted under an existing root branch`);
	}
}
