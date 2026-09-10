import {
	CONTINUE_PROMPT_METADATA_KEY,
	DEFAULT_CONTINUE_PROMPT,
	inferTerminalRecordingFailedTurnRecoveryContext,
	isProcessTurnType,
	normalizeContinuePrompt,
	type ProcessEvent,
	type ProcessInput,
	type ProcessInstance,
	type ProcessTurnAnnotation,
	type ProcessTurnRecord,
	parseProcessStateJsonLenient,
	readFailedTurnRecoveryContext,
	type TurnStartRecord,
	type WorkerLease,
} from "@leitwerk-dev/domain";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";
import {
	buildActiveTimelineTurnSummary,
	buildLiveTurnProjectionFromEvents,
	buildUsageSnapshotsByTurnRecordId,
	type CompactActiveTurnSnapshot,
	type CompactTurnSummary,
	type CurrentProcessErrorSummary,
	type CurrentTurnRecoverySummary,
	emptyCompactTurnSummary,
	extractFirstUserPromptOnBranch,
	extractInitialPromptFromParamsJson,
	hasTurnContinuationProgress,
	mergeUsageSnapshots,
	type PiSessionEntry,
	type PrimaryPathSnapshot,
	type PrimaryPathUiSnapshot,
	type ProcessDetailUiSnapshotResponseBody,
	type ProcessExternalTriggerSignal,
	type ProcessExternalTriggerSummary,
	type ProcessSelectedTurnSummary,
	type ProcessTimelineInputSummary,
	type ProcessTimelineSnapshot,
	type ProcessTimelineTurnSummary,
	type ProcessUiSnapshotProcess,
	type ProcessUsageEstimateSnapshot,
	REASONING_PREVIEW_MAX_CHARS,
	type ReadonlyEntryTree,
	reasoningPreviewTail,
	resolveTurnContinuationUserPrompt,
	snapshotTurnTrace,
	type TurnReasoningDetailResponseBody,
	type TurnTracePreview,
	type TurnTraceSnapshot,
	timelinePresentationForTurnType,
} from "@leitwerk-dev/protocol";
import type { SessionSummary } from "./db/turn-summary-repo.js";
import type { ReadonlyPiSessionTree } from "./pi-session-tree.js";
import { resolveCurrentExecutionTurnRecordId } from "./process-execution.js";
import { buildProcessFlowViewForProcess, getProcessGraph } from "./process-graph.js";
import { presentProcessInstanceTree } from "./process-instance-tree-presenter.js";
import { presentProcessModelConfiguration } from "./process-model-policy-presenter.js";
import { getProcessDisplayName } from "./process-operator-attention.js";
import { presentProcessTurnNavigation } from "./process-turn-navigation.js";
import {
	buildCommittedTurnTrace,
	buildTurnTracePreviewsFromSession,
} from "./process-turn-trace.js";

import {
	buildProcessLaunchConfigurationView,
	buildProcessRunDetailsView,
	getScheduledActionDetailForProcess,
	getSelectedTurnSummaryForProcess,
	listVisibleActionsForProcess,
	processDefinesLeafOutcome,
	type RouteDeps,
} from "./routes/process-route-helpers.js";
import { presentSessionTransferOperation } from "./session-transfer-service.js";
import { buildStartupEvidence, presentProcessStartupSummary } from "./startup-evidence.js";
import { normalizeTurnProgressReport } from "./turn-progress.js";

const COMPACT_DETAIL_EVENT_TYPES = [
	"turn_outcome_recorded",
	"lifecycle_parked",
	"worker_failed",
	"external_trigger_listener_armed",
	"external_source_armed",
	"external_trigger_failed",
	"external_source_failed",
	"external_trigger_consumed",
	"external_source_consumed",
] as const;

function sortEventsAscending(events: readonly ProcessEvent[]): ProcessEvent[] {
	return [...events].sort((left, right) => {
		const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
		return createdAtComparison !== 0 ? createdAtComparison : left.id.localeCompare(right.id);
	});
}

function compactDetailEvents(
	deps: RouteDeps,
	instanceId: string,
	turnRecords: readonly ProcessTurnRecord[],
): ProcessEvent[] {
	return sortEventsAscending([
		...deps.events.listByInstanceEventTypes(instanceId, COMPACT_DETAIL_EVENT_TYPES, 1_000),
		...turnRecords.flatMap((turn) => {
			const event = deps.events.latestByTurnRecordEventType(instanceId, turn.id, "turn.progress");
			return event ? [event] : [];
		}),
	]);
}

function compactPrimaryPathSnapshot(
	snapshot: PrimaryPathSnapshot | PrimaryPathUiSnapshot,
): PrimaryPathUiSnapshot {
	if ("entriesOmitted" in snapshot) return snapshot;
	const active = snapshot.turnState.activeTurn;
	const lastTool = active?.toolCalls.at(-1);
	const activeTurn: CompactActiveTurnSnapshot | null = active
		? {
				...emptyCompactTurnSummary(),
				turnRecordId: active.turnRecordId,
				turnId: active.turnId,
				turnType: active.turnType,
				pathType: active.pathType,
				startedAt: active.startedAt,
				assistant: {
					...active.assistant,
					text: reasoningPreviewTail(active.assistant.text),
					thinking: reasoningPreviewTail(active.assistant.thinking),
				},
				currentTool: lastTool
					? {
							toolCallId: lastTool.toolCallId,
							toolName: lastTool.toolName,
							status: lastTool.status,
							isError: lastTool.isError,
						}
					: null,
				toolCallCount: active.toolCalls.length,
				traceItemCount: active.traceItems.length,
				usage: active.usage,
				summaryPending: false,
			}
		: null;
	return {
		...snapshot,
		primaryPathEntries: [],
		labels: {},
		throughEventSequence: 0,
		turnState: { ...snapshot.turnState, activeTurn },
		entryCount: snapshot.primaryPathEntries.length,
		entriesOmitted: true,
	};
}

export function projectProcessForUiSnapshot(process: ProcessInstance): ProcessUiSnapshotProcess {
	return {
		id: process.id,
		processId: process.processId,
		selectedTurnId: process.selectedTurnId,
		lifecycleStatus: process.lifecycleStatus,
		currentExecution: process.currentExecution,
		planRevision: process.planRevision,
		title: process.title,
		externalId: process.externalId,
		externalUrl: process.externalUrl,
		initialDefaultModelProfileId: process.initialDefaultModelProfileId ?? null,
		createdAt: process.createdAt,
		updatedAt: process.updatedAt,
		closedAt: process.closedAt ?? null,
	};
}

export { buildStartupRecovery } from "./startup-evidence.js";

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readPersistedModelSelectionWarning(
	process: Pick<ProcessInstance, "lifecycleStatus" | "metadata">,
): string | null {
	if (process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted") return null;
	const leitwerkMetadata = asRecord(process.metadata?._leitwerk);
	const issue = asRecord(leitwerkMetadata?.persistedModelSelectionIssue);
	return typeof issue?.summary === "string" ? issue.summary : null;
}

const IDENTIFIER_WORD_LABELS: Record<string, string> = {
	api: "API",
	id: "ID",
	llm: "LLM",
	mr: "MR",
	pi: "Pi",
	ui: "UI",
};

function formatDefinition(value: string): string {
	return value
		.split(/[_-]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			const normalizedPart = part.toLowerCase();
			return IDENTIFIER_WORD_LABELS[normalizedPart] ?? part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function paramsRecord(value: unknown): Record<string, unknown> {
	return asRecord(value) ?? {};
}

function normalizeOutput(value: string): string {
	return value.trim();
}

function turnRecordIdFromEvent(event: ProcessEvent): string {
	return stringValue(paramsRecord(event.data).turnRecordId);
}

function createTurnOutcomeEventMap(events: readonly ProcessEvent[]): Map<string, ProcessEvent> {
	const map = new Map<string, ProcessEvent>();
	for (const event of events) {
		if (event.eventType !== "turn_outcome_recorded") {
			continue;
		}
		const turnRecordId = turnRecordIdFromEvent(event);
		if (turnRecordId) {
			map.set(turnRecordId, event);
		}
	}
	return map;
}

function turnRecordIdFromAnnotation(annotation: ProcessTurnAnnotation): string | null {
	for (const reference of annotation.references) {
		if (reference.kind === "turn_record") {
			return reference.turnRecordId;
		}
	}
	return null;
}

function createTurnAnnotationMap(
	turnAnnotations: readonly ProcessTurnAnnotation[],
	annotationType: string,
): Map<string, ProcessTurnAnnotation> {
	const map = new Map<string, ProcessTurnAnnotation>();
	for (const annotation of turnAnnotations) {
		if (annotation.annotationType !== annotationType) {
			continue;
		}
		const turnRecordId = turnRecordIdFromAnnotation(annotation);
		if (turnRecordId) {
			map.set(turnRecordId, annotation);
		}
	}
	return map;
}

function outputFromTurnParams(
	params: Record<string, unknown>,
	options: { includeMarkdownFields: boolean },
): string {
	return (
		(options.includeMarkdownFields
			? stringValue(params.planMarkdown) ||
				stringValue(params.reviewMarkdown) ||
				stringValue(params.feedback)
			: stringValue(params.feedback)) || stringValue(params.summary)
	);
}

function summarizeTurnOutcome(
	turnId: string,
	outcome: string,
	params: Record<string, unknown>,
): string {
	const summary = stringValue(params.summary);
	if (summary) return summary;
	return `${formatDefinition(turnId)}: ${formatDefinition(outcome)}`;
}

function fallbackOutcomeFromTurnRecord(turnRecord: ProcessTurnRecord): string {
	switch (turnRecord.status) {
		case "failed":
			return "failed";
		case "superseded":
			return "superseded";
		case "succeeded":
			return "succeeded";
		default:
			return "completed";
	}
}

function fallbackSummaryFromTurnRecord(turnRecord: ProcessTurnRecord): string {
	switch (turnRecord.status) {
		case "failed":
			return (
				stringValue(turnRecord.errorSummary) || `${formatDefinition(turnRecord.turnId)} failed`
			);
		case "superseded":
			return `${formatDefinition(turnRecord.turnId)} superseded`;
		case "succeeded":
			return `${formatDefinition(turnRecord.turnId)} completed`;
		default:
			return `Current step: ${formatDefinition(turnRecord.turnId ?? "unknown")}`;
	}
}

function annotationLabel(annotation: ProcessTurnAnnotation): string {
	return (
		stringValue(annotation.payload.actionLabel) ||
		stringValue(annotation.payload.triggerLabel) ||
		stringValue(annotation.payload.actionId) ||
		stringValue(annotation.payload.acceptanceState)
	);
}

function annotationOutput(annotation: ProcessTurnAnnotation): string {
	const fields = Array.isArray(annotation.payload.submittedFields)
		? annotation.payload.submittedFields
		: [];
	return fields
		.map((field: unknown) => {
			const record = paramsRecord(field);
			const label = stringValue(record.label) || stringValue(record.fieldId);
			const value = stringValue(record.value);
			return label && value ? `${label}:\n${value}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
}

type TimelineActionSource = ProcessTimelineTurnSummary["actionSource"];

function buildTurnProgressIndex(events: readonly ProcessEvent[]) {
	const index = new Map<string, NonNullable<ProcessTimelineTurnSummary["progress"]>>();
	const revisions = new Map<string, number>();
	for (const event of events) {
		if (event.eventType !== "turn.progress") continue;
		const turnRecordId = stringValue(event.data.turnRecordId);
		const report = normalizeTurnProgressReport(event.data.report);
		const revision = Number(event.data.revision ?? 0);
		if (
			turnRecordId &&
			report &&
			Number.isSafeInteger(revision) &&
			revision >= (revisions.get(turnRecordId) ?? -1)
		) {
			revisions.set(turnRecordId, revision);
			index.set(turnRecordId, report);
		}
	}
	return index;
}

function actionSourceFromAnnotation(annotation: ProcessTurnAnnotation): TimelineActionSource {
	const source = annotation.payload.actionSource;
	return source === "ui" || source === "external" || source === "scheduled" ? source : null;
}

function buildActionSourceIndex(
	annotations: readonly ProcessTurnAnnotation[],
	turnRecords: readonly ProcessTurnRecord[],
): Map<string, Exclude<TimelineActionSource, null>> {
	const sortedTurnRecords = [...turnRecords].sort(
		(left, right) =>
			left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
	);
	const turnRecordById = new Map(sortedTurnRecords.map((record) => [record.id, record]));
	const direct = new Map<string, Exclude<TimelineActionSource, null>>();
	for (const annotation of annotations) {
		const turnRecordId = turnRecordIdFromAnnotation(annotation);
		const source = actionSourceFromAnnotation(annotation);
		if (turnRecordId && source) direct.set(turnRecordId, source);
	}
	const index = new Map(direct);
	for (const annotation of [...annotations].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
	)) {
		const sourceTurnRecordId = turnRecordIdFromAnnotation(annotation);
		const source = actionSourceFromAnnotation(annotation);
		const sourceTurn = sourceTurnRecordId ? turnRecordById.get(sourceTurnRecordId) : null;
		if (!sourceTurnRecordId || !source || !sourceTurn || sourceTurn.turnType === "llm") continue;
		const causedTurnType = annotation.payload.causedSelectedTurnType;
		if (
			causedTurnType != null &&
			(!isProcessTurnType(causedTurnType) || causedTurnType !== "llm")
		) {
			continue;
		}
		const causedTurnId = stringValue(annotation.payload.causedSelectedTurnId);
		if (!causedTurnId) continue;
		const matchingTurn = sortedTurnRecords.find(
			(record) =>
				record.turnType === "llm" &&
				record.turnId === causedTurnId &&
				record.startedAt.localeCompare(annotation.createdAt) >= 0,
		);
		if (matchingTurn && !direct.has(matchingTurn.id)) index.set(matchingTurn.id, source);
	}
	return index;
}

function effectiveTurnRecordForDisplay(
	turnRecord: ProcessTurnRecord,
	process: ProcessInstance,
): ProcessTurnRecord {
	if (
		turnRecord.status !== "running" ||
		(process.lifecycleStatus !== "completed" && process.lifecycleStatus !== "aborted")
	) {
		return turnRecord;
	}
	return {
		...turnRecord,
		status: process.lifecycleStatus === "completed" ? "succeeded" : "superseded",
		endedAt: turnRecord.endedAt ?? process.updatedAt,
	};
}

function durableTurnLineage(turnRecord: ProcessTurnRecord) {
	return {
		attemptNumber: turnRecord.attemptNumber,
		parentTurnRecordId: turnRecord.parentTurnRecordId,
		startedAt: turnRecord.startedAt,
		endedAt: turnRecord.endedAt,
	};
}

function createCompletedTurnRecord(args: {
	turnRecord: ProcessTurnRecord;
	turnId: string;
	displayTurn?: string;
	outcome: string;
	summary: string;
	output: string;
	turnResultMarkdown: string;
	createdAt: string;
	actionSource: TimelineActionSource;
	progress: ProcessTimelineTurnSummary["progress"];
}): ProcessTimelineTurnSummary {
	return {
		id: args.turnRecord.id,
		turnId: args.turnId,
		turnType: args.turnRecord.turnType,
		displayTurn: args.displayTurn ?? args.turnId,
		outcome: args.outcome,
		summary: args.summary,
		output: normalizeOutput(args.output) || (args.turnResultMarkdown ? "" : args.summary),
		turnResultMarkdown: args.turnResultMarkdown,
		pathType: args.turnRecord.pathType,
		createdAt: args.createdAt,
		presentation: timelinePresentationForTurnType(args.turnRecord.turnType),
		status: "completed",
		modelProfileId: args.turnRecord.modelProfileId ?? null,
		actionSource: args.actionSource,
		progress: args.progress,
		...durableTurnLineage(args.turnRecord),
	};
}

export function presentProcessTimelineTurns(input: {
	process: ProcessInstance;
	currentExecutionTurnRecordId?: string | null;
	turnRecords: readonly ProcessTurnRecord[];
	turnAnnotations: readonly ProcessTurnAnnotation[];
	events: readonly ProcessEvent[];
	activeTurn: PrimaryPathSnapshot["turnState"]["activeTurn"] | CompactActiveTurnSnapshot;
	selectedTurnType: ProcessTurnRecord["turnType"] | null;
	activeModelProfileId?: string | null;
}): ProcessTimelineTurnSummary[] {
	const outcomeEventsByTurnRecordId = createTurnOutcomeEventMap(input.events);
	const progressByTurnRecordId = buildTurnProgressIndex(input.events);
	const milestoneAnnotationsByTurnRecordId = createTurnAnnotationMap(
		input.turnAnnotations,
		"turn_milestone",
	);
	const acceptanceAnnotationsByTurnRecordId = createTurnAnnotationMap(
		input.turnAnnotations,
		"acceptance_state",
	);
	const externalTriggerAnnotationsByTurnRecordId = createTurnAnnotationMap(
		input.turnAnnotations,
		"external_trigger",
	);
	const actionSourceByTurnRecordId = buildActionSourceIndex(
		input.turnAnnotations,
		input.turnRecords,
	);
	const turns: ProcessTimelineTurnSummary[] = [];
	const sortedTurnRecords = [...input.turnRecords].sort((left, right) =>
		left.startedAt.localeCompare(right.startedAt),
	);
	const hasRunningTurn = sortedTurnRecords.some((turnRecord) => turnRecord.status === "running");
	const retryReplacingFailedTurnRecordId =
		!input.activeTurn &&
		!hasRunningTurn &&
		input.process.lifecycleStatus === "active" &&
		input.currentExecutionTurnRecordId == null &&
		typeof input.process.metadata?.retryFromTurnRecordId === "string"
			? input.process.metadata.retryFromTurnRecordId
			: null;

	for (const durableTurnRecord of sortedTurnRecords) {
		if (
			retryReplacingFailedTurnRecordId === durableTurnRecord.id &&
			durableTurnRecord.status === "failed" &&
			durableTurnRecord.turnId === input.process.selectedTurnId
		) {
			continue;
		}
		const turnRecord = effectiveTurnRecordForDisplay(durableTurnRecord, input.process);
		if (turnRecord.status === "running") {
			turns.push({
				id: turnRecord.id,
				turnId: turnRecord.turnId,
				turnType: turnRecord.turnType,
				displayTurn: turnRecord.turnId,
				outcome: "in_progress",
				summary: `Current step: ${formatDefinition(turnRecord.turnId)}`,
				output:
					input.activeTurn?.turnRecordId === turnRecord.id
						? input.activeTurn.assistant.text.trim()
						: "",
				turnResultMarkdown: "",
				pathType: turnRecord.pathType,
				createdAt: turnRecord.startedAt,
				presentation: timelinePresentationForTurnType(turnRecord.turnType),
				status: "in_progress",
				modelProfileId: turnRecord.modelProfileId ?? null,
				actionSource: actionSourceByTurnRecordId.get(turnRecord.id) ?? null,
				progress: progressByTurnRecordId.get(turnRecord.id) ?? null,
				...durableTurnLineage(turnRecord),
			});
			continue;
		}

		const turnResultMarkdown = stringValue(turnRecord.turnResultMarkdown);
		const outcomeEvent = outcomeEventsByTurnRecordId.get(turnRecord.id);
		const milestoneAnnotation = milestoneAnnotationsByTurnRecordId.get(turnRecord.id);
		const actionAnnotation =
			acceptanceAnnotationsByTurnRecordId.get(turnRecord.id) ??
			externalTriggerAnnotationsByTurnRecordId.get(turnRecord.id);
		let presentation: Omit<
			Parameters<typeof createCompletedTurnRecord>[0],
			"turnRecord" | "turnResultMarkdown" | "actionSource" | "progress"
		>;

		if (outcomeEvent) {
			const turnId = stringValue(outcomeEvent.data.turnId) || turnRecord.turnId || "turn";
			const outcome =
				stringValue(outcomeEvent.data.outcome) ||
				stringValue(milestoneAnnotation?.payload.outcome) ||
				fallbackOutcomeFromTurnRecord(turnRecord);
			const params = paramsRecord(outcomeEvent.data.params);
			presentation = {
				turnId,
				outcome,
				summary: summarizeTurnOutcome(turnId, outcome, params),
				output: outputFromTurnParams(params, { includeMarkdownFields: !turnResultMarkdown }),
				createdAt: turnRecord.endedAt ?? outcomeEvent.createdAt ?? turnRecord.startedAt,
			};
		} else if (actionAnnotation) {
			const label = annotationLabel(actionAnnotation);
			presentation = {
				turnId: turnRecord.turnId,
				displayTurn: label || turnRecord.turnId,
				outcome: label || "completed",
				summary: label || `${formatDefinition(turnRecord.turnId)} reviewed`,
				output: annotationOutput(actionAnnotation),
				createdAt: turnRecord.endedAt ?? actionAnnotation.createdAt ?? turnRecord.startedAt,
			};
		} else if (milestoneAnnotation) {
			const turnId = stringValue(milestoneAnnotation.payload.turnId) || turnRecord.turnId || "turn";
			const outcome =
				stringValue(milestoneAnnotation.payload.outcome) ||
				fallbackOutcomeFromTurnRecord(turnRecord);
			presentation = {
				turnId,
				outcome,
				summary: summarizeTurnOutcome(turnId, outcome, {}),
				output: "",
				createdAt: turnRecord.endedAt ?? milestoneAnnotation.createdAt ?? turnRecord.startedAt,
			};
		} else {
			const summary = fallbackSummaryFromTurnRecord(turnRecord);
			presentation = {
				turnId: turnRecord.turnId,
				outcome: fallbackOutcomeFromTurnRecord(turnRecord),
				summary,
				output: turnResultMarkdown ? "" : stringValue(turnRecord.errorSummary) || summary,
				createdAt: turnRecord.endedAt ?? turnRecord.startedAt,
			};
		}
		turns.push(
			createCompletedTurnRecord({
				...presentation,
				turnRecord,
				turnResultMarkdown,
				actionSource: actionSourceByTurnRecordId.get(turnRecord.id) ?? null,
				progress: progressByTurnRecordId.get(turnRecord.id) ?? null,
			}),
		);
	}

	if (
		input.activeTurn &&
		!turns.some((turnRecord) => turnRecord.id === input.activeTurn?.turnRecordId)
	) {
		const activeTurn = input.activeTurn;
		turns.push(
			buildActiveTimelineTurnSummary(activeTurn, {
				summary: `Current step: ${formatDefinition(activeTurn.turnId)}`,
				output: activeTurn.assistant.text.trim(),
				actionSource: actionSourceByTurnRecordId.get(activeTurn.turnRecordId) ?? null,
			}),
		);
	} else if (
		!turns.some((turnRecord) => turnRecord.status === "in_progress") &&
		input.process.lifecycleStatus === "active"
	) {
		const turnId = input.process.selectedTurnId ?? "unknown";
		turns.push({
			id: input.currentExecutionTurnRecordId ?? `current:${turnId}`,
			turnId,
			turnType: input.selectedTurnType ?? "llm",
			displayTurn: turnId,
			outcome: "in_progress",
			summary: `Current step: ${formatDefinition(turnId)}`,
			output: "",
			turnResultMarkdown: "",
			pathType: "primary",
			createdAt: input.process.updatedAt,
			presentation: timelinePresentationForTurnType(input.selectedTurnType ?? "llm"),
			status: "in_progress",
			modelProfileId:
				input.activeModelProfileId === undefined
					? (input.process.selectedTurnModelProfileId ?? null)
					: input.activeModelProfileId,
			attemptNumber: 1,
			parentTurnRecordId: null,
			startedAt: input.process.updatedAt,
			endedAt: null,
			actionSource: null,
			progress: null,
		});
	}

	return turns;
}

function buildTimelineInputSummary(input: ProcessInput): ProcessTimelineInputSummary {
	return {
		id: input.id,
		sequence: input.sequence,
		source: input.source,
		kind: input.kind,
		bodyMarkdown: input.bodyMarkdown,
		receivedAt: input.receivedAt,
		consumedAt: input.consumedAt,
	};
}

function stringValueOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function matchesTrigger(trigger: ProcessExternalTriggerSummary, event: ProcessEvent): boolean {
	const armingId = stringValueOrNull(event.data.armingId);
	const legacyTriggerId = stringValueOrNull(event.data.trigger);
	return armingId === trigger.id || legacyTriggerId === trigger.id;
}

function setupDetail(event: ProcessEvent | null): string | null {
	if (!event) {
		return null;
	}
	const provider = asRecord(event.data.provider) ?? {};
	const path = stringValueOrNull(event.data.path) ?? stringValueOrNull(provider.path);
	const pollInterval =
		stringValueOrNull(event.data.pollInterval) ?? stringValueOrNull(provider.pollInterval);
	if (path && pollInterval) {
		return `Watching ${path} · polling every ${pollInterval}.`;
	}
	if (path) {
		return `Watching ${path}.`;
	}
	if (pollInterval) {
		return `Polling every ${pollInterval}.`;
	}
	return null;
}

function joinDetails(...parts: Array<string | null>): string | null {
	const joined = parts.filter((part) => part && part.trim().length > 0).join(" ");
	return joined.length > 0 ? joined : null;
}

export function buildExternalTriggerSignals(args: {
	externalTriggers: readonly ProcessExternalTriggerSummary[];
	events: readonly ProcessEvent[];
	isWaitingForSelectedTurn: boolean;
}): ProcessExternalTriggerSignal[] {
	return args.externalTriggers.map((trigger) => {
		const matchingEvents = args.events.filter((event) => matchesTrigger(trigger, event));
		const latestEvent = matchingEvents.at(-1) ?? null;
		const latestArmedEvent =
			[...matchingEvents]
				.reverse()
				.find(
					(event) =>
						event.eventType === "external_trigger_listener_armed" ||
						event.eventType === "external_source_armed",
				) ?? null;
		const latestConfiguredEvent = latestArmedEvent ?? latestEvent;
		const configuredDetail = setupDetail(latestConfiguredEvent);

		if (
			latestEvent?.eventType === "external_trigger_failed" ||
			latestEvent?.eventType === "external_source_failed"
		) {
			return {
				triggerId: trigger.id,
				state: "error",
				occurredAt: latestEvent.createdAt,
				secondaryDetail: joinDetails(stringValueOrNull(latestEvent.data.message), configuredDetail),
			};
		}

		if (args.isWaitingForSelectedTurn) {
			return {
				triggerId: trigger.id,
				state: "armed",
				occurredAt: latestArmedEvent?.createdAt ?? null,
				secondaryDetail: configuredDetail ?? "No trigger attempts recorded yet.",
			};
		}

		if (
			latestEvent?.eventType === "external_trigger_consumed" ||
			latestEvent?.eventType === "external_source_consumed"
		) {
			return {
				triggerId: trigger.id,
				state: "triggered",
				occurredAt: latestEvent.createdAt,
				secondaryDetail: configuredDetail,
			};
		}

		return {
			triggerId: trigger.id,
			state: "waiting",
			occurredAt: null,
			secondaryDetail: configuredDetail,
		};
	});
}

const PROCESS_ERROR_CATEGORY_LABELS: Record<string, string> = {
	llm_error: "The model request failed",
	git_error: "A git operation failed",
	pi_crash: "The agent crashed",
	pipeline_error: "The CI pipeline failed",
	infrastructure: "An internal error occurred",
	protocol_error: "An internal error occurred",
	operator_abort: "The process was stopped",
};

const PROCESS_ERROR_GUIDANCE: Record<string, string> = {
	llm_error:
		"Retry once provider capacity or quota is available, or switch to a different model before continuing.",
	git_error: "Check the repository state, then retry or restart the process.",
	pipeline_error: "Review the pipeline output, then retry once the issue is resolved.",
	pi_crash: "Inspect the latest state, then retry or restart the process.",
};

const DEFAULT_PROCESS_ERROR_SUMMARY =
	"This process is parked in error and needs operator attention before it can continue.";
const DEFAULT_PROCESS_ERROR_GUIDANCE =
	"This process stopped before it produced a recoverable failed turn. Inspect the latest state, then retry or restart it when you are ready.";

function lowerFirst(value: string): string {
	const second = value[1];
	return second && second === second.toUpperCase() && second !== second.toLowerCase()
		? value
		: value.charAt(0).toLowerCase() + value.slice(1);
}

function findProviderMessage(value: unknown): string | null {
	const record = asRecord(value);
	if (!record) return null;
	const message = stringValueOrNull(record.message);
	return message ?? (record.error === undefined ? null : findProviderMessage(record.error));
}

function extractProviderMessage(value: string): string | null {
	const braceIndex = value.indexOf("{");
	if (braceIndex < 0) return null;
	try {
		return findProviderMessage(JSON.parse(value.slice(braceIndex)));
	} catch {
		return null;
	}
}

export function formatProcessErrorPresentation(
	rawReason: string | null | undefined,
	errorClass?: string | null,
): { summary: string; guidance: string; technicalDetail: string | null } {
	const raw = (rawReason ?? "").trim();
	const category = errorClass ? PROCESS_ERROR_CATEGORY_LABELS[errorClass] : undefined;
	const guidance =
		(errorClass && PROCESS_ERROR_GUIDANCE[errorClass]) || DEFAULT_PROCESS_ERROR_GUIDANCE;
	if (!raw) {
		return {
			summary: category ?? DEFAULT_PROCESS_ERROR_SUMMARY,
			guidance,
			technicalDetail: null,
		};
	}
	const withoutPrefix = raw.replace(/^Turn\s+'[^']*'\s+.*?failed:\s*/i, "").trim() || raw;
	const detail = extractProviderMessage(withoutPrefix) ?? withoutPrefix;
	const summary =
		category && detail.toLowerCase() !== category.toLowerCase()
			? `${category} — ${lowerFirst(detail)}`
			: (category ?? detail);
	return {
		summary: summary || DEFAULT_PROCESS_ERROR_SUMMARY,
		guidance,
		technicalDetail: raw === summary ? null : raw,
	};
}

export function buildCurrentTurnRecovery(input: {
	process: ProcessInstance;
	turnStarts: { getById(id: string): import("@leitwerk-dev/domain").TurnStartRecord | null };
	turnRecords: readonly ProcessTurnRecord[];
	selectedTurnDescription: string | null;
	piEntries: readonly PiSessionEntry[];
	continuation?: { hasProgress: boolean; userPrompt: string | null };
}): CurrentTurnRecoverySummary | null {
	if (input.process.lifecycleStatus !== "error") {
		return null;
	}
	const failedTurnRecordId = resolveCurrentExecutionTurnRecordId(input.process, input.turnStarts);
	if (!failedTurnRecordId) {
		return null;
	}
	const failedTurnRecord = input.turnRecords.find(
		(turnRecord) => turnRecord.id === failedTurnRecordId,
	);
	if (
		!failedTurnRecord ||
		failedTurnRecord.status !== "failed" ||
		failedTurnRecord.turnId !== input.process.selectedTurnId
	) {
		return null;
	}
	const recoveryContext =
		readFailedTurnRecoveryContext(input.process.metadata, failedTurnRecord.id) ??
		inferTerminalRecordingFailedTurnRecoveryContext(failedTurnRecord);
	const continuationBounds = { endedAt: failedTurnRecord.endedAt };
	const canContinue =
		failedTurnRecord.turnType === "llm" &&
		recoveryContext !== null &&
		(input.continuation?.hasProgress ??
			hasTurnContinuationProgress(input.piEntries, failedTurnRecord, continuationBounds));
	const rawErrorSummary = stringValueOrNull(failedTurnRecord.errorSummary);
	const presentation = formatProcessErrorPresentation(rawErrorSummary, failedTurnRecord.errorClass);
	const acceptedStart =
		input.process.currentExecution?.kind === "worker_start"
			? input.turnStarts.getById(input.process.currentExecution.id)
			: null;
	const acceptedLlmStart =
		acceptedStart?.state.kind === "accepted" && acceptedStart.state.start.kind === "llm"
			? acceptedStart.state.start
			: null;
	return {
		turnRecordId: failedTurnRecord.id,
		title: input.selectedTurnDescription ?? formatDefinition(failedTurnRecord.turnId),
		summary: presentation.summary,
		guidance: presentation.guidance,
		technicalDetail: presentation.technicalDetail,
		defaultContinuePrompt:
			input.continuation?.userPrompt ??
			resolveTurnContinuationUserPrompt(input.piEntries, failedTurnRecord, continuationBounds) ??
			normalizeContinuePrompt(input.process.metadata?.[CONTINUE_PROMPT_METADATA_KEY]) ??
			recoveryContext?.suggestedContinuePrompt ??
			DEFAULT_CONTINUE_PROMPT,
		canContinue,
		supportsModelOverride: failedTurnRecord.turnType === "llm",
		defaultModelProfileId: acceptedLlmStart?.model.profileId ?? failedTurnRecord.modelProfileId,
		providerOptions: acceptedLlmStart ? { ...acceptedLlmStart.providerOptions } : {},
	};
}

export function buildCurrentProcessError(input: {
	process: ProcessInstance;
	events: readonly ProcessEvent[];
	selectedTurnDescription: string | null;
	currentTurnRecovery: CurrentTurnRecoverySummary | null;
}): CurrentProcessErrorSummary | null {
	if (input.process.lifecycleStatus !== "error" || input.currentTurnRecovery) {
		return null;
	}
	const latestErrorEvent = [...input.events]
		.reverse()
		.find((event) => event.eventType === "lifecycle_parked" || event.eventType === "worker_failed");
	const eventData = latestErrorEvent?.data ?? null;
	const rawReason =
		stringValueOrNull(eventData?.reason) ??
		stringValueOrNull(eventData?.message) ??
		(eventData?.errorCode ? `Worker failed: ${String(eventData.errorCode)}` : null);
	const errorClass = stringValueOrNull(eventData?.errorClass);
	const presentation = formatProcessErrorPresentation(rawReason, errorClass);
	return {
		title:
			input.selectedTurnDescription ??
			(input.process.selectedTurnId
				? formatDefinition(input.process.selectedTurnId)
				: "Process error"),
		summary: presentation.summary,
		guidance: presentation.guidance,
		technicalDetail: presentation.technicalDetail,
	};
}

export function buildUsageEstimate(input: {
	turnRecords: readonly ProcessTurnRecord[];
	activeTurn: PrimaryPathSnapshot["turnState"]["activeTurn"] | CompactActiveTurnSnapshot;
	currentTurnRecordId: string | null;
	usageByTurnRecordId: Record<string, TurnTraceSnapshot["usage"]>;
	tracePreviewsByTurnRecordId: Record<string, TurnTracePreview>;
}): ProcessUsageEstimateSnapshot | null {
	let usage: TurnTraceSnapshot["usage"] = null;
	let totalLlmTurnCount = 0;
	let coveredTurnCount = 0;
	let missingUsageTurnCount = 0;
	let missingCostTurnCount = 0;
	let includesLiveTurn = false;

	for (const turnRecord of input.turnRecords) {
		if (turnRecord.turnType !== "llm") {
			continue;
		}
		totalLlmTurnCount += 1;
		const isActiveTurn = turnRecord.id === input.currentTurnRecordId;
		const turnUsage =
			isActiveTurn && input.activeTurn?.turnType === "llm"
				? (input.activeTurn.usage ??
					input.tracePreviewsByTurnRecordId[turnRecord.id]?.usage ??
					input.usageByTurnRecordId[turnRecord.id] ??
					null)
				: (input.tracePreviewsByTurnRecordId[turnRecord.id]?.usage ??
					input.usageByTurnRecordId[turnRecord.id] ??
					null);
		if (!turnUsage) {
			missingUsageTurnCount += 1;
			continue;
		}
		coveredTurnCount += 1;
		if (!turnUsage.cost) {
			missingCostTurnCount += 1;
		}
		if (isActiveTurn) {
			includesLiveTurn = true;
		}
		usage = mergeUsageSnapshots(usage, turnUsage);
	}

	if (!usage || totalLlmTurnCount === 0) {
		return null;
	}
	return {
		usage,
		includesLiveTurn,
		totalLlmTurnCount,
		coveredTurnCount,
		missingUsageTurnCount,
		missingCostTurnCount,
		isPartial: missingUsageTurnCount > 0 || missingCostTurnCount > 0,
	};
}

export function buildProcessUiSnapshotProjections(input: {
	process: ProcessInstance;
	turnStarts?: { getById(id: string): TurnStartRecord | null };
	startupTurnStarts?: readonly TurnStartRecord[];
	workerLeases?: readonly WorkerLease[];
	turnRecords: readonly ProcessTurnRecord[];
	turnAnnotations: readonly ProcessTurnAnnotation[];
	events: readonly ProcessEvent[];
	inputs: readonly ProcessInput[];
	selectedTurn: ProcessSelectedTurnSummary | null;
	primaryPathSnapshot: PrimaryPathSnapshot | PrimaryPathUiSnapshot;
	sessionTree?: ReadonlyPiSessionTree;
	sessionSummary?: SessionSummary | null;
	eventSummariesByTurnRecordId?: Record<string, CompactTurnSummary>;
	eventUsageByTurnRecordId?: Record<string, TurnTraceSnapshot["usage"]>;
	activeModelProfileId?: string | null;
}) {
	const tracePreviewsByTurnRecordId = {
		...(input.sessionSummary?.tracePreviewsByTurnRecordId ??
			(input.sessionTree
				? buildTurnTracePreviewsFromSession({
						tree: input.sessionTree,
						turnRecords: input.turnRecords,
						events: input.events,
					})
				: {})),
	};
	for (const turn of input.turnRecords) {
		const turnRecordId = turn.id;
		const summary = input.eventSummariesByTurnRecordId?.[turnRecordId];
		if (turn.status === "running" || !summary || tracePreviewsByTurnRecordId[turnRecordId])
			continue;
		tracePreviewsByTurnRecordId[turnRecordId] = {
			turnRecordId,
			assistantTextPreview: summary.assistant.text,
			assistantTextTruncated: summary.assistant.text.length >= REASONING_PREVIEW_MAX_CHARS,
			thinkingPreview: summary.assistant.thinking,
			thinkingPreviewTruncated: summary.assistant.thinking.length >= REASONING_PREVIEW_MAX_CHARS,
			toolCallCount: summary.toolCallCount,
			traceItemCount: summary.traceItemCount,
			hasReasoningDetails: Boolean(
				summary.assistant.thinking || summary.traceItemCount || summary.usage,
			),
			usage: summary.usage,
			piInput: null,
		};
	}
	const currentLeafEntryId =
		input.primaryPathSnapshot.currentLeaf?.entryId ??
		input.primaryPathSnapshot.semanticEntryRefs.currentPrimaryPathLeaf?.entryId ??
		null;
	const prompt = {
		...(input.sessionSummary?.prompt ??
			(input.sessionTree
				? extractFirstUserPromptOnBranch(
						input.sessionTree as unknown as ReadonlyEntryTree<PiSessionEntry>,
						currentLeafEntryId,
					)
				: { text: null, createdAt: null })),
	};
	prompt.text ??= extractInitialPromptFromParamsJson(input.process.paramsJson);
	const activeTurn = input.primaryPathSnapshot.turnState.activeTurn;
	const currentExecutionTurnRecordId = resolveCurrentExecutionTurnRecordId(
		input.process,
		input.turnStarts ?? { getById: () => null },
	);
	const recovery = buildCurrentTurnRecovery({
		process: input.process,
		turnRecords: input.turnRecords,
		selectedTurnDescription: input.selectedTurn?.description ?? null,
		piEntries: (input.sessionTree?.entries ?? []) as unknown as PiSessionEntry[],
		continuation:
			input.sessionSummary?.continuationByTurnRecordId[currentExecutionTurnRecordId ?? ""],
		turnStarts: input.turnStarts ?? { getById: () => null },
	});
	const startup = presentProcessStartupSummary(
		buildStartupEvidence({
			process: input.process,
			turnStarts: input.startupTurnStarts ?? [],
			leases: input.workerLeases ?? [],
			turnRecords: input.turnRecords,
		}),
	);
	return {
		process: projectProcessForUiSnapshot(input.process),
		primaryPath: compactPrimaryPathSnapshot(input.primaryPathSnapshot),
		timeline: {
			prompt,
			turns: presentProcessTimelineTurns({
				process: input.process,
				turnRecords: input.turnRecords,
				turnAnnotations: input.turnAnnotations,
				events: input.events,
				activeTurn,
				currentExecutionTurnRecordId,
				selectedTurnType: input.selectedTurn?.kind ?? null,
				activeModelProfileId: input.activeModelProfileId,
			}),
			tracePreviewsByTurnRecordId,
			inputs: input.inputs.map(buildTimelineInputSummary),
			externalTriggerSignals: buildExternalTriggerSignals({
				externalTriggers: input.selectedTurn?.externalTriggers ?? [],
				events: input.events,
				isWaitingForSelectedTurn:
					input.process.lifecycleStatus === "waiting" &&
					(input.selectedTurn?.turnId ?? null) === (input.process.selectedTurnId ?? null),
			}),
		} satisfies ProcessTimelineSnapshot,
		recovery,
		startup,
		startupRecovery: startup.recovery,
		processError: buildCurrentProcessError({
			process: input.process,
			events: input.events,
			selectedTurnDescription: input.selectedTurn?.description ?? null,
			currentTurnRecovery: recovery,
		}),
		usageEstimate: buildUsageEstimate({
			turnRecords: input.turnRecords,
			activeTurn,
			currentTurnRecordId: activeTurn?.turnRecordId ?? currentExecutionTurnRecordId,
			usageByTurnRecordId:
				input.eventUsageByTurnRecordId ?? buildUsageSnapshotsByTurnRecordId(input.events),
			tracePreviewsByTurnRecordId,
		}),
	};
}

export class ProcessUiSnapshotAssembler {
	constructor(private readonly deps: RouteDeps) {}

	async assemble(instanceId: string): Promise<ProcessDetailUiSnapshotResponseBody | null> {
		const process = this.deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		// Capture every synchronous durable read before yielding so one response cannot
		// combine process/turn state from opposite sides of a concurrent mutation.
		const projects = this.deps.projects.listByInstance(instanceId);
		const turnRecords = this.deps.turnRecords.listByInstance(instanceId);
		const events = compactDetailEvents(this.deps, instanceId, turnRecords);
		const turnAnnotations = this.deps.turnAnnotations.listByInstance(instanceId);
		const inputs = this.deps.inputs.listByInstance(instanceId);
		const leafOutcomeSnapshots = this.deps.leafOutcomeSnapshots.listByInstance(instanceId);
		const questionRequests = this.deps.questionRequests.listByInstance(instanceId);
		const toolApprovalRequests = this.deps.toolApprovalRequests.listByInstance(instanceId);
		const workerLeases = this.deps.leases.listByInstance(instanceId);
		const workerLease = workerLeases.find((lease) => lease.exitedAt === null) ?? null;
		const startupTurnStarts = this.deps.turnStarts.listByInstance(instanceId);
		const selectedTurn = getSelectedTurnSummaryForProcess(this.deps, process);
		const session = this.deps.turnSummaries.getSession(instanceId);
		const summaries = this.deps.turnSummaries.listByInstance(instanceId);
		const currentTurnRecordId = resolveCurrentExecutionTurnRecordId(process, this.deps.turnStarts);
		const activeRecord = turnRecords.find(
			(turn) => turn.id === currentTurnRecordId && turn.status === "running",
		);
		const activeTurn = activeRecord
			? {
					...(summaries[activeRecord.id] ?? emptyCompactTurnSummary()),
					turnRecordId: activeRecord.id,
					turnId: activeRecord.turnId,
					turnType: activeRecord.turnType,
					pathType: activeRecord.pathType,
					startedAt: activeRecord.startedAt,
					summaryPending: !summaries[activeRecord.id],
				}
			: null;
		const structural = parseStructuralProcessState(parseProcessStateJsonLenient(process.stateJson));
		const semanticEntryRefs = {
			...session?.primaryPath.semanticEntryRefs,
			...structural.semanticEntryRefs,
		};
		semanticEntryRefs.rootEntry ??= session?.primaryPath.semanticEntryRefs.rootEntry ?? null;
		semanticEntryRefs.currentPrimaryPathLeaf ??= session?.primaryPath.currentLeaf ?? null;
		const primaryPath: PrimaryPathUiSnapshot = {
			instanceId,
			rebuiltAt: new Date().toISOString(),
			throughEventSequence: this.deps.events.latestSequence(instanceId),
			primaryPathEntries: [],
			labels: {},
			entryCount: session?.primaryPath.entryCount ?? 0,
			entriesOmitted: true,
			currentLeaf: semanticEntryRefs.currentPrimaryPathLeaf,
			semanticEntryRefs,
			turnAnnotations: session?.primaryPath.turnAnnotations ?? [],
			detailRail: { keyPoints: [], futureTurns: [], currentPosition: null },
			turnState: {
				currentTurnRecordId,
				workerState: workerLease?.state ?? null,
				isStreaming: activeTurn !== null,
				activeTurn,
			},
		};
		const modelConfiguration = presentProcessModelConfiguration(
			this.deps.processModelPolicy.project({
				kind: "process_configuration",
				process,
				availability: this.deps.modelStatusCache.snapshot(),
			}),
		);
		const projections = buildProcessUiSnapshotProjections({
			process,
			turnStarts: this.deps.turnStarts,
			startupTurnStarts,
			workerLeases,
			turnRecords,
			turnAnnotations,
			events,
			inputs,
			selectedTurn,
			primaryPathSnapshot: primaryPath,
			sessionSummary: session,
			eventSummariesByTurnRecordId: summaries,
			eventUsageByTurnRecordId: Object.fromEntries(
				Object.entries(summaries).map(([id, summary]) => [id, summary.usage]),
			),
			activeModelProfileId: modelConfiguration.effectiveSelectedTurn?.modelProfileId ?? null,
		});
		const runDetails = buildProcessRunDetailsView(this.deps, process, projects);
		const navigation = presentProcessTurnNavigation({
			graph: getProcessGraph(this.deps.processGraphs, process.processId),
			turns: projections.timeline.turns,
			selectedTurnId: process.selectedTurnId,
			lifecycleStatus: process.lifecycleStatus,
		});

		return {
			...projections,
			timeline: { ...projections.timeline, turns: navigation.turns },
			plannedNextTurn: navigation.plannedNextTurn,
			instanceTree: presentProcessInstanceTree({
				process,
				turnRecords,
				turnAnnotations,
				turnDetails: runDetails.turns,
				currentPiEntryId: session?.leafId ?? null,
			}),
			leafOutcomeSnapshots,
			questionRequests,
			toolApprovalRequests,
			processDisplayName: getProcessDisplayName(this.deps, process.processId),
			processFlow: buildProcessFlowViewForProcess(this.deps.processGraphs, process.processId),
			definesLeafOutcome: processDefinesLeafOutcome(this.deps, process),
			selectedTurn,
			scheduledAction: getScheduledActionDetailForProcess(this.deps, process),
			modelConfiguration,
			runDetails,
			launchConfiguration: buildProcessLaunchConfigurationView(this.deps, process, projects),
			actions: listVisibleActionsForProcess(this.deps, process),
			toolRenderers: [...(this.deps.toolRenderers?.values() ?? [])],
			persistedModelSelectionWarning: readPersistedModelSelectionWarning(process),
			session: { signature: session?.signature ?? null },
			sessionTransfer: presentSessionTransferOperation(
				this.deps.sessionTransferService?.activeForProcess(process.id) ?? null,
			),
		};
	}

	async assembleReasoningDetail(input: {
		instanceId: string;
		turnRecordId: string;
	}): Promise<TurnReasoningDetailResponseBody | null> {
		const process = this.deps.processes.getById(input.instanceId);
		if (!process) {
			return null;
		}
		const turnRecord = this.deps.turnRecords.getById(input.turnRecordId);
		if (!turnRecord || turnRecord.instanceId !== input.instanceId) {
			return null;
		}
		const throughEventSequence = this.deps.events.latestSequence(input.instanceId);
		const events = this.deps.events.listByTurnRecord(input.instanceId, input.turnRecordId);
		if (turnRecord.status === "running") {
			const trace = snapshotTurnTrace(buildLiveTurnProjectionFromEvents(events));
			return {
				instanceId: input.instanceId,
				turnRecordId: input.turnRecordId,
				state: "live",
				throughEventSequence,
				sessionSignature: this.deps.turnSummaries.getSession(input.instanceId)?.signature ?? null,
				reasoning: trace,
			};
		}
		const session = await this.deps.sessionReader.readSessionTree(input.instanceId);
		const trace = buildCommittedTurnTrace({
			tree: session.piTree,
			turnRecord,
			events,
		});
		trace.usage ??= buildUsageSnapshotsByTurnRecordId(events)[turnRecord.id] ?? null;
		return {
			instanceId: input.instanceId,
			turnRecordId: input.turnRecordId,
			sessionSignature: session.signature,
			state: "committed",
			throughEventSequence,
			reasoning: trace,
		};
	}
}
