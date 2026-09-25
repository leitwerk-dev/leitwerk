import type {
	InspectionContextObservation,
	InspectionEvidence,
	PreparedTurnStart,
	ProcessTurnRecord,
	WorkerLease,
} from "@leitwerk-dev/domain";
import type { ExecutionContextOrigin, InspectionBoundary } from "@leitwerk-dev/protocol";
import type { ReadonlyPiSessionTree } from "./pi-session-tree.js";

interface LineageInput {
	records: readonly ProcessTurnRecord[];
	leases: readonly WorkerLease[];
	observations: readonly InspectionContextObservation[];
	tree?: ReadonlyPiSessionTree;
}

/** Recorded start receipts remain usable for executions predating inspection capture. */
function preparedStart(input: LineageInput, record: ProcessTurnRecord): PreparedTurnStart | null {
	const supplied = input.observations.find(
		(item) => item.turnRecordId === record.id && item.fact.kind === "supplied_context",
	);
	if (supplied?.fact.kind === "supplied_context" && supplied.fact.origin)
		return supplied.fact.origin;
	const receipt = input.leases.find(
		(lease) => lease.id === record.acceptedWorkerLeaseId,
	)?.bootstrapReceipt;
	return receipt?.kind === "llm" && receipt.startRecordId === record.turnStartRecordId
		? receipt.preparedStart
		: null;
}

/** Pure ownership and ancestry projection; current workflow definitions are not an input. @internal */
export function createInspectionLineage(input: LineageInput) {
	const records = new Map(input.records.map((record) => [record.id, record]));
	const starts = new Map(
		input.records
			.filter((record) => record.turnStartRecordId)
			.map((record) => [record.turnStartRecordId, record.id]),
	);
	const candidates = new Map<string, Set<string>>();
	const claim = (entryId: string, recordId: string) => {
		if (!records.has(recordId)) return;
		const owners = candidates.get(entryId) ?? new Set<string>();
		owners.add(recordId);
		candidates.set(entryId, owners);
	};
	for (const record of input.records)
		if (record.resultPiEntryId) claim(record.resultPiEntryId, record.id);
	for (const item of input.observations)
		if (item.fact.kind === "entry_link") claim(item.fact.entryId, item.turnRecordId);
	for (const entry of input.tree?.entries ?? []) {
		if (entry.type !== "custom_message" && entry.type !== "compaction") continue;
		const details = entry.details as Record<string, unknown> | undefined;
		if (
			details &&
			(details.kind === "turn_prompt" || details.kind === "turn_compaction") &&
			typeof details.startRecordId === "string"
		) {
			const owner = starts.get(details.startRecordId);
			if (owner) claim(entry.id, owner);
		}
	}
	const explicit = new Set(candidates.keys());
	// Bound legacy ownership by recorded start/result entries. Extending the owner
	// of an earlier result to arbitrary later descendants would invent lineage.
	for (const record of input.records) {
		if (!record.resultPiEntryId || !input.tree?.getEntry(record.resultPiEntryId)) continue;
		const branch = input.tree.getBranch(record.resultPiEntryId);
		const prepared = preparedStart(input, record);
		const boundary = prepared?.forkPiEntryId ?? record.forkPiEntryId;
		const boundaryIndex = boundary ? branch.findIndex((entry) => entry.id === boundary) : -1;
		const promptIndex = branch.findIndex((entry) => {
			if (entry.type !== "custom_message") return false;
			const details = entry.details as Record<string, unknown> | undefined;
			return details?.kind === "turn_prompt" && details.startRecordId === record.turnStartRecordId;
		});
		const first =
			promptIndex >= 0
				? promptIndex
				: boundaryIndex >= 0
					? boundaryIndex + 1
					: prepared?.startTarget.kind === "root"
						? 0
						: -1;
		if (first < 0) continue;
		for (const entry of branch.slice(first))
			if (!explicit.has(entry.id)) claim(entry.id, record.id);
	}
	const inheritedOwner = (entryId: string): string | null => {
		const owners = candidates.get(entryId);
		return owners?.size === 1 ? [...owners][0] : null;
	};
	const boundaryFor = (record: ProcessTurnRecord): string | null => {
		const prepared = preparedStart(input, record);
		return prepared?.forkPiEntryId ?? record.forkPiEntryId;
	};
	const origin = (record: ProcessTurnRecord): ExecutionContextOrigin => {
		const unknown = {
			state: "not_recorded",
			reason: "Historical context origin was not recorded",
		} as const;
		if (record.turnType !== "llm") {
			const none = {
				state: "not_applicable",
				reason: `This ${record.turnType} execution does not invoke a model`,
			} as const;
			return {
				authoredMode: none,
				startTarget: none,
				conversation: none,
				structuralPath: record.pathType,
				summary: none.reason,
			};
		}
		const prepared = preparedStart(input, record);
		const boundaryId = boundaryFor(record);
		let conversation: InspectionEvidence<InspectionBoundary | null> = unknown;
		if (boundaryId)
			conversation = {
				state: "recorded",
				value: { entryId: boundaryId, turnRecordId: inheritedOwner(boundaryId) },
			};
		else if (
			prepared &&
			(prepared.startTarget.kind === "root" || prepared.startTarget.kind === "current_leaf")
		)
			conversation = { state: "recorded", value: null };
		const source = conversation.state === "recorded" ? conversation.value : undefined;
		const summary =
			source === null
				? "No inherited conversation · supplied inputs may still apply"
				: source
					? `${prepared?.contextMode === "compacted" ? "Compacted conversation" : "Conversation inherited"} through ${source.entryId}${source.turnRecordId ? "" : " · source execution unknown"}`
					: "Conversation origin not recorded";
		return {
			authoredMode: prepared ? { state: "recorded", value: prepared.contextMode } : unknown,
			startTarget: prepared ? { state: "recorded", value: prepared.startTarget } : unknown,
			conversation,
			structuralPath: record.pathType,
			summary,
		};
	};
	const ancestry = (record: ProcessTurnRecord) => {
		const result: Array<{ turnRecordId: string; turnId: string; boundaryEntryId: string }> = [];
		const visited = new Set([record.id]);
		let current = record;
		while (true) {
			const context = origin(current).conversation;
			const source = context.state === "recorded" ? context.value : null;
			if (!source?.turnRecordId || visited.has(source.turnRecordId)) break;
			const parent = records.get(source.turnRecordId);
			if (!parent) break;
			visited.add(parent.id);
			result.push({
				turnRecordId: parent.id,
				turnId: parent.turnId,
				boundaryEntryId: source.entryId,
			});
			current = parent;
		}
		return result;
	};
	return { owner: inheritedOwner, origin, ancestry, boundaryFor };
}
