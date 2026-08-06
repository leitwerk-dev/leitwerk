import type {
	ProcessInstance,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import type {
	InstanceTreeEdgeSummary,
	InstanceTreeNodeSummary,
	ProcessInstanceTreeResponseBody,
	ProcessRunTurnView,
} from "@leitwerk-dev/protocol/http-contracts";

type Decision = InstanceTreeEdgeSummary & { timestamp: string };

function titleCase(value: string): string {
	return value
		.replaceAll(/[-_]+/g, " ")
		.replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

function payloadString(annotation: ProcessTurnAnnotation, key: string): string | null {
	const value = annotation.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index])) return items[index];
	}
	return undefined;
}

function nextLlmAfterAutomatic(
	automatic: ProcessTurnRecord,
	allRecords: readonly ProcessTurnRecord[],
): ProcessTurnRecord | undefined {
	const start = allRecords.findIndex((record) => record.id === automatic.id) + 1;
	for (let index = start; index > 0 && index < allRecords.length; index += 1) {
		const record = allRecords[index];
		if (record.turnType === "human" || record.turnType === "external") return undefined;
		if (record.turnType === "llm") return record;
	}
	return undefined;
}

function actionDecisions(
	process: ProcessInstance,
	annotations: readonly ProcessTurnAnnotation[],
	allRecords: readonly ProcessTurnRecord[],
	llmRecords: readonly ProcessTurnRecord[],
): Decision[] {
	const llmById = new Map(llmRecords.map((record) => [record.id, record]));
	const claimedTargets = new Set<string>();
	const decisions: Decision[] = [];
	const candidates = annotations
		.filter(
			(annotation) =>
				annotation.annotationType === "acceptance_state" ||
				annotation.annotationType === "external_trigger",
		)
		.sort(
			(left, right) =>
				left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
		);
	for (const annotation of candidates) {
		const actionLabel =
			payloadString(annotation, "actionLabel") ?? payloadString(annotation, "triggerLabel");
		if (!actionLabel) continue;

		const recordedSourceId = payloadString(annotation, "sourceTurnRecordId");
		const source =
			(recordedSourceId ? llmById.get(recordedSourceId) : undefined) ??
			findLast(llmRecords, (record) => record.startedAt.localeCompare(annotation.createdAt) <= 0);
		if (!source) continue;

		const causedTurnId = payloadString(annotation, "causedSelectedTurnId");
		const causedTurnType = annotation.payload.causedSelectedTurnType;
		const findCaused = (turnType: string) =>
			causedTurnId
				? allRecords.find(
						(record) =>
							record.turnType === turnType &&
							record.turnId === causedTurnId &&
							record.startedAt.localeCompare(annotation.createdAt) >= 0 &&
							!claimedTargets.has(record.id),
					)
				: undefined;
		const directTarget =
			causedTurnType === undefined || causedTurnType === "llm" ? findCaused("llm") : undefined;
		const causedAutomatic =
			causedTurnType === "automatic" || causedTurnType === "server_automatic"
				? findCaused(causedTurnType)
				: undefined;
		const target =
			directTarget ??
			(causedAutomatic ? nextLlmAfterAutomatic(causedAutomatic, allRecords) : undefined);
		if (target) claimedTargets.add(target.id);
		const isUnapplied = causedTurnType === "human" || causedTurnType === "external";
		decisions.push({
			id: annotation.id,
			sourceNodeId: source.id,
			targetNodeId: target?.id ?? null,
			hasContext: false,
			productLabels: [],
			actionLabel,
			endState: isUnapplied
				? "not_applied"
				: causedAutomatic && !target && process.lifecycleStatus === "completed"
					? "completed"
					: null,
			timestamp: annotation.createdAt,
		});
	}
	return decisions;
}

function automaticTransitions(
	process: ProcessInstance,
	annotations: readonly ProcessTurnAnnotation[],
	allRecords: readonly ProcessTurnRecord[],
	llmRecords: readonly ProcessTurnRecord[],
): Decision[] {
	const actionCausedAutomaticIds = new Set<string>();
	for (const annotation of annotations) {
		const causedTurnId = annotation.payload.causedSelectedTurnId;
		const causedTurnType = annotation.payload.causedSelectedTurnType;
		if (
			typeof causedTurnId !== "string" ||
			(causedTurnType !== "automatic" && causedTurnType !== "server_automatic")
		) {
			continue;
		}
		const caused = allRecords.find(
			(record) =>
				record.turnType === causedTurnType &&
				record.turnId === causedTurnId &&
				record.startedAt.localeCompare(annotation.createdAt) >= 0,
		);
		if (caused) actionCausedAutomaticIds.add(caused.id);
	}

	const transitions: Decision[] = [];
	for (const automatic of allRecords.filter(
		(record) => record.turnType === "automatic" || record.turnType === "server_automatic",
	)) {
		if (actionCausedAutomaticIds.has(automatic.id)) continue;
		const source = findLast(
			llmRecords,
			(record) => record.startedAt.localeCompare(automatic.startedAt) < 0,
		);
		if (!source) continue;
		const target = nextLlmAfterAutomatic(automatic, allRecords);
		const completesProcess =
			allRecords.at(-1)?.id === automatic.id && process.lifecycleStatus === "completed";
		if (!target && !completesProcess) continue;
		transitions.push({
			id: `automatic:${automatic.id}`,
			sourceNodeId: source.id,
			targetNodeId: target?.id ?? null,
			hasContext: false,
			productLabels: [],
			actionLabel: titleCase(automatic.turnId),
			endState: target ? null : "completed",
			timestamp: automatic.startedAt,
		});
	}
	return transitions;
}

/** Projects actual Pi turn lineage and redacted prompt/product provenance. */
export function presentProcessInstanceTree(input: {
	process: ProcessInstance;
	turnRecords: readonly ProcessTurnRecord[];
	turnAnnotations?: readonly ProcessTurnAnnotation[];
	turnDetails?: readonly ProcessRunTurnView[];
	currentPiEntryId?: string | null;
}): ProcessInstanceTreeResponseBody {
	const allRecords = [...input.turnRecords].sort(
		(left, right) =>
			left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
	);
	const records = allRecords.filter((record) => record.turnType === "llm");
	const detailsByTurnId = new Map(
		(input.turnDetails ?? []).map((detail) => [detail.turnId, detail] as const),
	);
	const byResultEntryId = new Map(
		records
			.filter((record) => record.resultPiEntryId)
			.map((record) => [record.resultPiEntryId as string, record] as const),
	);
	const annotations = input.turnAnnotations ?? [];
	const decisions = [
		...actionDecisions(input.process, annotations, allRecords, records),
		...automaticTransitions(input.process, annotations, allRecords, records),
	].sort(
		(left, right) =>
			left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
	);
	const current =
		input.process.lifecycleStatus === "completed" || input.process.lifecycleStatus === "aborted"
			? null
			: (byResultEntryId.get(input.currentPiEntryId ?? "")?.id ?? records.at(-1)?.id ?? null);
	const nodes: InstanceTreeNodeSummary[] = records.map((record) => {
		const detail = detailsByTurnId.get(record.turnId);
		const parent = record.forkPiEntryId ? byResultEntryId.get(record.forkPiEntryId) : undefined;
		return {
			id: record.id,
			parentId: parent?.id ?? null,
			label: detail?.description ?? titleCase(record.turnId),
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

	type MutableEdge = Omit<InstanceTreeEdgeSummary, "productLabels"> & {
		productLabels: string[];
	};
	const edgesByKey = new Map<string, MutableEdge>();
	const connect = (sourceNodeId: string, targetNodeId: string): MutableEdge => {
		const key = `${sourceNodeId}->${targetNodeId}`;
		const existing = edgesByKey.get(key);
		if (existing) return existing;
		const edge: MutableEdge = {
			id: key,
			sourceNodeId,
			targetNodeId,
			hasContext: false,
			productLabels: [],
			actionLabel: null,
			endState: null,
		};
		edgesByKey.set(key, edge);
		return edge;
	};

	for (const [index, node] of nodes.entries()) {
		const record = records[index];
		if (node.parentId) connect(node.parentId, node.id).hasContext = true;
		const detail = detailsByTurnId.get(record.turnId);
		for (const productName of detail?.consumedProducts ?? []) {
			const publisher = findLast(
				records,
				(candidate) =>
					candidate.startedAt.localeCompare(record.startedAt) < 0 &&
					candidate.status === "succeeded" &&
					(detailsByTurnId.get(candidate.turnId)?.publishedProducts ?? []).includes(productName),
			);
			if (publisher) connect(publisher.id, record.id).productLabels.push(titleCase(productName));
		}
	}

	const terminalEdges: InstanceTreeEdgeSummary[] = [];
	for (const { timestamp: _, ...decision } of decisions) {
		if (!decision.targetNodeId) {
			terminalEdges.push(decision);
			continue;
		}
		const target = nodes.find((node) => node.id === decision.targetNodeId);
		const input = target?.parentId
			? connect(target.parentId, target.id)
			: [...edgesByKey.values()].find((edge) => edge.targetNodeId === target?.id);
		(input ?? connect(decision.sourceNodeId, decision.targetNodeId)).actionLabel =
			decision.actionLabel;
	}

	return {
		currentLeafId: current,
		nodes,
		edges: [...edgesByKey.values(), ...terminalEdges],
	};
}
