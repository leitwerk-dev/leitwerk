import type {
	InspectionContextObservation,
	ProcessInstance,
	ProcessTurnRecord,
	WorkerLease,
} from "@leitwerk-dev/domain";
import type {
	InstanceTreeEdgeSummary,
	InstanceTreeNodeSummary,
	ProcessInstanceTreeResponseBody,
	ProcessRunTurnView,
} from "@leitwerk-dev/protocol/http-contracts";
import { createInspectionLineage } from "./process-inspection.js";

function titleCase(value: string): string {
	return value
		.replaceAll(/[-_]+/g, " ")
		.replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

/** Compact recorded context relationships. Current definitions supply labels only. @internal */
export function presentProcessInstanceTree(input: {
	process: ProcessInstance;
	turnRecords: readonly ProcessTurnRecord[];
	leases?: readonly WorkerLease[];
	observations?: readonly InspectionContextObservation[];
	turnDetails?: readonly ProcessRunTurnView[];
	currentPiEntryId?: string | null;
}): ProcessInstanceTreeResponseBody {
	const records = [...input.turnRecords].sort(
		(a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
	);
	const observations = input.observations ?? [];
	const lineage = createInspectionLineage({ records, observations, leases: input.leases ?? [] });
	const labels = new Map(input.turnDetails?.map((turn) => [turn.turnId, turn.description]));
	const nodes: InstanceTreeNodeSummary[] = records.map((record) => {
		const origin = lineage.origin(record);
		const source = origin.conversation.state === "recorded" ? origin.conversation.value : null;
		return {
			id: record.id,
			turnId: record.turnId,
			turnType: record.turnType,
			origin,
			parentId: source?.turnRecordId === record.id ? null : (source?.turnRecordId ?? null),
			label: labels.get(record.turnId) ?? titleCase(record.turnId),
			pathType: record.pathType,
			resultState:
				record.status === "succeeded"
					? "succeeded"
					: record.status === "failed"
						? "failed"
						: record.status === "superseded"
							? "aborted"
							: "pending",
			timestamp: record.startedAt,
		};
	});
	const edges: InstanceTreeEdgeSummary[] = nodes.flatMap((node) =>
		node.parentId
			? [
					{
						id: `conversation:${node.id}`,
						sourceNodeId: node.parentId,
						targetNodeId: node.id,
						hasContext: true,
						productLabels: [],
						actionLabel: null,
						endState: null,
					},
				]
			: [],
	);
	const byId = new Map(records.map((record) => [record.id, record]));
	for (const observation of observations) {
		if (observation.fact.kind !== "supplied_context" || !byId.has(observation.turnRecordId))
			continue;
		for (const product of observation.fact.products) {
			const producer = byId.get(product.producerTurnRecordId);
			if (!producer || producer.resultPiEntryId !== product.entryId) continue;
			edges.push({
				id: `product:${observation.id}:${product.name}`,
				sourceNodeId: producer.id,
				targetNodeId: observation.turnRecordId,
				hasContext: false,
				productLabels: [product.name],
				actionLabel: null,
				endState: null,
			});
		}
	}
	return {
		currentLeafId:
			input.process.lifecycleStatus === "completed" || input.process.lifecycleStatus === "aborted"
				? null
				: (records.find((record) => record.turnStartRecordId === input.process.currentExecution?.id)
						?.id ??
					records.find((record) => record.status === "running")?.id ??
					(input.currentPiEntryId ? lineage.owner(input.currentPiEntryId) : null)),
		nodes,
		edges,
	};
}
