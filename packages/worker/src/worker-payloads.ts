import {
	detectRepoLocatorKind,
	type ProcessInstance,
	type ProcessProductRefs,
	type ProcessProject,
	type ProcessSemanticEntryRefs,
	parseProcessProductRefs,
	parseSemanticEntryRefsFromStateJsonStrict,
	parseSemanticEntryRefsLenient,
} from "@leitwerk-dev/domain";
import type {
	InputDelivery,
	ProcessInstanceSnapshot,
	ProcessProjectSnapshot,
} from "@leitwerk-dev/worker-protocol";
import type { InputItem } from "./input-consumer.js";

export function inputDeliveryToItem(delivery: InputDelivery): InputItem {
	return {
		inputId: delivery.inputId,
		sequence: delivery.sequence,
		source: delivery.source,
		kind: delivery.kind,
		target: delivery.target,
		bodyMarkdown: delivery.bodyMarkdown,
	};
}

export function projectSnapshotsFromPayload(raw: ProcessProjectSnapshot[]): ProcessProject[] {
	return raw.map((project) => ({
		id: project.id ?? "",
		instanceId: project.instanceId ?? "",
		key: project.key,
		repoLocator: project.repoLocator,
		repoLocatorKind:
			project.repoLocatorKind ?? detectRepoLocatorKind(project.repoLocator) ?? "remote_url",
		baseBranch: project.baseBranch,
		workBranch: project.workBranch ?? "",
		externalId: project.externalId ?? null,
		externalUrl: project.externalUrl ?? null,
		metadata: project.metadata ?? null,
		pipelineStatus: project.pipelineStatus ?? null,
		createdAt: project.createdAt ?? "",
		updatedAt: project.updatedAt ?? "",
	}));
}

export function buildProcessSnapshotSeed(
	processId: string,
	processSnapshot: ProcessInstanceSnapshot,
): ProcessInstance {
	const resolvedProcessId = processSnapshot.processId ?? processId;
	return {
		id: processSnapshot.id ?? "",
		processId: resolvedProcessId,
		selectedTurnId: processSnapshot.selectedTurnId ?? null,
		lifecycleStatus: processSnapshot.lifecycleStatus ?? "discovered",
		currentExecution: processSnapshot.currentExecution ?? null,
		planRevision: processSnapshot.planRevision ?? 0,
		title: processSnapshot.title ?? null,
		externalId: processSnapshot.externalId ?? null,
		externalUrl: processSnapshot.externalUrl ?? null,
		metadata: processSnapshot.metadata ?? null,
		defaultModelProfileId: processSnapshot.defaultModelProfileId ?? null,
		turnConfigsJson: processSnapshot.turnConfigsJson ?? null,
		selectedTurnModelProfileId: processSnapshot.selectedTurnModelProfileId ?? null,
		paramsJson: processSnapshot.paramsJson ?? null,
		stateJson: processSnapshot.stateJson ?? null,
		createdAt: processSnapshot.createdAt ?? "",
		updatedAt: processSnapshot.updatedAt ?? "",
	};
}

export function readProcessSemanticEntryRefs(state: unknown): ProcessSemanticEntryRefs | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return null;
	}
	return parseSemanticEntryRefsLenient(
		(state as { semanticEntryRefs?: unknown }).semanticEntryRefs,
	);
}

export function readProcessProductRefs(state: unknown): ProcessProductRefs | null {
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return null;
	}
	return parseProcessProductRefs((state as { productRefs?: unknown }).productRefs);
}

export function parseProcessSemanticEntryRefsFromStateJson(
	stateJson: string | null | undefined,
): ProcessSemanticEntryRefs {
	return parseSemanticEntryRefsFromStateJsonStrict(stateJson, "process stateJson");
}
