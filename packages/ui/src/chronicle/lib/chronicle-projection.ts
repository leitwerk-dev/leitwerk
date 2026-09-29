import {
	formatPathTypeLabel,
	type ProcessInput,
	type ProcessLeafOutcomeSnapshot,
	type ProcessQuestionRequest,
	type ProcessTurnRecord,
	type TurnProgressReport,
} from "@leitwerk-dev/domain";
import {
	type CompactActiveTurnSnapshot,
	type PrimaryPathActiveTurnSnapshot,
	type ProcessTimelineTurnSummary,
	reasoningPreviewTail,
	type TurnPiInputPart,
	type TurnTracePreview,
	type TurnTraceSnapshot,
	type TurnUsageSnapshot,
} from "@leitwerk-dev/protocol";

type ChronicleInput = Pick<
	ProcessInput,
	"id" | "sequence" | "source" | "kind" | "bodyMarkdown" | "receivedAt" | "consumedAt"
>;

import { formatDefinition } from "../../lib/format";
import { truncateText } from "../../lib/markdown";
import { hasDisplayableText } from "../../lib/pi-stream.js";
import {
	getProcessTerminalRailTitle,
	type ProcessTerminalStatus,
} from "../../lib/process-terminal-display.js";

type TurnRecordView = ProcessTimelineTurnSummary;

import {
	buildChronicleTurnRailItem,
	type ChronicleTurnPresentation,
	type ChronicleTurnRailItem,
	formatChronicleTurnTitle,
	getChronicleTurnKindLabel,
	getChronicleTurnPresentation,
	getChronicleTurnPreview,
} from "./chronicle-view-model.js";

export type ChronicleProjectedTurnRailItem = ChronicleTurnRailItem & {
	anchorId: string;
	retryLineageRootTurnRecordId?: string;
};

export interface ChronicleTerminalRailItem {
	terminalStatus: ProcessTerminalStatus;
	anchorId: string;
	title: string;
}

export interface ChronicleThinkingSection {
	kind: "thinking_preview";
	text: string;
	preview: string;
	previewTruncated: boolean;
	toolCallCount: number;
	traceItemCount: number;
}

export type ChronicleTriggeringInputSource = ProcessInput["source"] | "initial_prompt";

export interface ChronicleTriggeringInputSummary {
	inputId: string;
	source: ChronicleTriggeringInputSource;
	sourceLabel: string;
	bodyMarkdown: string;
	receivedAt: string;
	consumedAt: string;
}

export interface ChroniclePiInputSummary {
	parts: TurnPiInputPart[];
	fullPrompt: string;
	createdAt: string;
	userInput: string | null;
}

export interface ChronicleTurnFacts {
	startedAt: string | null;
	endedAt: string | null;
}

export interface ChronicleOperatorDecisionSection {
	kind: "operator_decision";
	text: string;
}

export interface ChronicleTurnResultSection {
	kind: "turn_result";
	markdown: string;
	resultSummary?: string;
}

export interface ChronicleTurnProgressSection {
	kind: "turn_progress";
	report: TurnProgressReport;
	attemptStatus?: string;
	recordedAt?: string;
}

export type ChronicleTurnClusterSection =
	| ChronicleThinkingSection
	| ChronicleOperatorDecisionSection
	| ChronicleTurnProgressSection
	| ChronicleTurnResultSection;

export interface ChronicleTurnClusterItem {
	kind: "turn_cluster";
	parentTurnRecordId?: string | null;
	reviewedTurnRecordId?: string;
	resources?: TurnRecordView["resources"];
	transition?: TurnRecordView["transition"];
	chronologyAt: string;
	anchorId: string;
	turnRecordId: string;
	turnId: string;
	turnType?: ProcessTurnRecord["turnType"];
	title: string;
	turnLabel: string;
	iteration?: TurnRecordView["iteration"];
	pathLabel: string | null;
	createdAt: string;
	preview: string;
	isOperatorDecision: boolean;
	turnPresentation: ChronicleTurnPresentation;
	turnKindLabel: string;
	terminalStatus: "completed" | "aborted" | null;
	sections: ChronicleTurnClusterSection[];
	modelProfileId: string | null;
	usage: TurnUsageSnapshot | null;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	piInput: ChroniclePiInputSummary | null;
	facts: ChronicleTurnFacts;
	failure?: { summary: string };
}

export interface ChroniclePromptItem {
	kind: "prompt";
	anchorId: string;
	createdAt: string | null;
	text: string;
	preview: string;
}

export interface ChronicleOperatorInputItem {
	kind: "operator_input";
	chronologyAt: string;
	inputId: string;
	source: ProcessInput["source"];
	sourceLabel: string;
	bodyMarkdown: string;
	receivedAt: string;
}

export interface ChronicleLeafOutcomeItem {
	kind: "leaf_outcome";
	chronologyAt: string;
	anchorId: string;
	instanceId: string;
	snapshotId: string;
	leafEntryId: string;
	turnRecordId: string | null;
	title: string;
	ownerTurnTitle: string | null;
	rendererId: string | null;
	schemaVersion: number | null;
	props: ProcessLeafOutcomeSnapshot["props"];
	fallbackMarkdown: string | null;
	status: ProcessLeafOutcomeSnapshot["status"];
	warningCode: string | null;
	warningMessage: string | null;
	anchoredAt: string;
	createdAt: string;
	processLifecycleStatus: string | null;
	processSelectedTurnId: string | null;
	processUpdatedAt: string | null;
}

export interface ChronicleLeafOutcomePlaceholderItem {
	kind: "leaf_outcome_placeholder";
	latestTurnTitle: string | null;
}

export interface ChronicleLiveTailItem {
	progress?: TurnRecordView["progress"];
	progressRecordedAt?: string;
	kind: "live_tail";
	parentTurnRecordId?: string | null;
	anchorId: string;
	turnRecordId: string;
	turnId: string;
	turnType?: ProcessTurnRecord["turnType"];
	title: string;
	turnLabel: string;
	iteration?: TurnRecordView["iteration"];
	pathLabel: string | null;
	state: "tool_running" | "thinking" | "streaming" | "waiting";
	stateLabel: string;
	copy: string;
	assistantTextPreview: string;
	reasoningSection: ChronicleThinkingSection | null;
	toolCall: PrimaryPathActiveTurnSnapshot["toolCalls"][number] | null;
	usage: TurnUsageSnapshot | null;
	eventWindowTruncated: boolean;
	modelProfileId: string | null;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	piInput: ChroniclePiInputSummary | null;
	facts: ChronicleTurnFacts;
}

function formatPiTreePathLabel(
	turnRecord: Pick<ProcessTurnRecord, "turnType" | "pathType">,
): string | null {
	return turnRecord.turnType === "llm" ? formatPathTypeLabel(turnRecord.pathType) : null;
}

export type ChronicleTimelineItem =
	| ChroniclePromptItem
	| ChronicleTurnClusterItem
	| ChronicleOperatorInputItem
	| ChronicleLeafOutcomeItem
	| ChronicleLeafOutcomePlaceholderItem
	| ChronicleLiveTailItem;

export interface ChronicleProjection {
	promptItem: ChroniclePromptItem | null;
	turnRailItems: ChronicleProjectedTurnRailItem[];
	terminalRailItem: ChronicleTerminalRailItem | null;
	timelineItems: ChronicleTimelineItem[];
	initialAnchorId: string | null;
	initialFocusedTurnId: string | null;
	liveTail: ChronicleLiveTailItem | null;
	latestCompletedTurnTitle: string | null;
}

export interface BuildChronicleProjectionInput {
	turnRecords: readonly TurnRecordView[];
	turnTracePreviewIndex?: Record<string, TurnTracePreview | undefined>;
	initialUserInputText?: string | null;
	inputs: readonly ChronicleInput[];
	leafOutcomeSnapshots: readonly ProcessLeafOutcomeSnapshot[];
	definesLeafOutcome: boolean;
	activeTurn: PrimaryPathActiveTurnSnapshot | CompactActiveTurnSnapshot | null | undefined;
	lifecycleStatus?: string | null;
	selectedTurnId?: string | null;
	processUpdatedAt?: string | null;
	promptText?: string | null;
	promptCreatedAt?: string | null;
}

// Tunable inline reasoning window: keep the preview calm, recent, and line-based.
export const THINKING_PREVIEW_LINE_COUNT = 4;
const THINKING_PREVIEW_MAX_LENGTH = 1024;

function sanitizeDomToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildTurnAnchorId(turnRecordId: string): string {
	return `chronicle-turn-${sanitizeDomToken(turnRecordId)}`;
}

function buildLiveTailAnchorId(turnRecordId: string): string {
	return `chronicle-live-${sanitizeDomToken(turnRecordId)}`;
}

function buildPromptAnchorId(): string {
	return "chronicle-prompt";
}

function buildLeafOutcomeAnchorId(snapshotId: string): string {
	return `chronicle-leaf-outcome-${sanitizeDomToken(snapshotId)}`;
}

function buildTerminalAnchorId(status: ProcessTerminalStatus): string {
	return `chronicle-terminal-${sanitizeDomToken(status)}`;
}

interface TurnTraceProjectionSource {
	trace: TurnTraceSnapshot | undefined;
	preview: TurnTracePreview | undefined;
}

function buildEmptyReasoningSection(source: TurnTraceProjectionSource): ChronicleThinkingSection {
	return {
		kind: "thinking_preview",
		text: "",
		preview: "",
		previewTruncated: source.preview?.thinkingPreviewTruncated ?? false,
		toolCallCount: source.trace?.toolCalls.length ?? source.preview?.toolCallCount ?? 0,
		traceItemCount: source.trace?.traceItems.length ?? source.preview?.traceItemCount ?? 0,
	};
}

function buildReasoningSection(source: TurnTraceProjectionSource): ChronicleThinkingSection | null {
	const thinkingText = source.trace?.assistant.thinking ?? source.preview?.thinkingPreview ?? "";
	const hasTraceDetails =
		Boolean(source.trace?.toolCalls.length) ||
		source.trace?.traceItems.some(
			(item) =>
				item.kind === "operational_event" ||
				(item.kind === "thinking" && hasDisplayableText(item.text)),
		);
	const hasPreviewDetails =
		source.trace === undefined && source.preview?.hasReasoningDetails === true;
	if (!hasDisplayableText(thinkingText) && !hasTraceDetails && !hasPreviewDetails) {
		return null;
	}
	const thinkingPreview = source.trace
		? {
				text: reasoningPreviewTail(thinkingText),
				truncated: thinkingText.length > THINKING_PREVIEW_MAX_LENGTH,
			}
		: {
				text: source.preview?.thinkingPreview ?? "",
				truncated: source.preview?.thinkingPreviewTruncated ?? false,
			};
	return {
		kind: "thinking_preview",
		text: thinkingText,
		preview: thinkingPreview.text,
		previewTruncated: thinkingPreview.truncated,
		toolCallCount: source.trace?.toolCalls.length ?? source.preview?.toolCallCount ?? 0,
		traceItemCount: source.trace?.traceItems.length ?? source.preview?.traceItemCount ?? 0,
	};
}

function sourceLabel(source: ProcessInput["source"]): string {
	switch (source) {
		case "app_steer":
			return "Operator note";
		case "external_comment":
			return "External comment";
		case "action_prompt":
			return "Action prompt";
		default:
			return "Input";
	}
}

function toPiInputSummary(input: {
	traceSource: TurnTraceProjectionSource;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	initialUserInputText?: string | null;
}): ChroniclePiInputSummary | null {
	const previewInput = input.traceSource.preview?.piInput;
	const fullPrompt = previewInput?.userInputPreview ?? "";
	if (fullPrompt.trim() === "") {
		return null;
	}
	return {
		parts: [],
		fullPrompt,
		createdAt: previewInput?.createdAt ?? "",
		userInput:
			promptOrNull(input.triggeringInput?.bodyMarkdown) ??
			promptOrNull(input.initialUserInputText) ??
			null,
	};
}

function hasChronicleInputBody(input: ChronicleInput): boolean {
	return hasDisplayableText(input.bodyMarkdown);
}

function isChronicleTriggeringInput(input: ChronicleInput): boolean {
	if (!hasChronicleInputBody(input)) {
		return false;
	}
	return (
		input.source === "app_steer" ||
		input.source === "external_comment" ||
		input.source === "action_prompt"
	);
}

function isStandaloneChronicleOperatorInput(input: ChronicleInput): boolean {
	if (!hasChronicleInputBody(input)) {
		return false;
	}
	return input.source === "app_steer" || input.source === "external_comment";
}

function hasRenderableLeafOutcomeForTurn(
	turnRecordId: string,
	leafOutcomeSnapshots: readonly ProcessLeafOutcomeSnapshot[],
): boolean {
	return leafOutcomeSnapshots.some(
		(snapshot) =>
			snapshot.turnRecordId === turnRecordId &&
			snapshot.status === "ready" &&
			((typeof snapshot.rendererId === "string" && snapshot.rendererId.trim() !== "") ||
				hasDisplayableText(snapshot.fallbackMarkdown ?? "")),
	);
}

function shouldExposeEmptyReasoningDetails(
	turnRecord: Pick<TurnRecordView, "turnType" | "modelProfileId">,
	traceSource: TurnTraceProjectionSource,
): boolean {
	return (
		turnRecord.turnType === "llm" &&
		(traceSource.preview?.hasReasoningDetails === true || turnRecord.modelProfileId !== null)
	);
}

function buildTurnClusterItem(input: {
	turnRecord: TurnRecordView;
	turnTracePreview: TurnTracePreview | undefined;
	terminalStatus: "completed" | "aborted" | null;
	hasRenderableLeafOutcome: boolean;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	initialUserInputText?: string | null;
}): ChronicleTurnClusterItem {
	const { turnRecord, turnTracePreview, triggeringInput } = input;
	const traceSource = { trace: undefined, preview: turnTracePreview };
	const sections: ChronicleTurnClusterSection[] = [];
	const turnPresentation = getChronicleTurnPresentation(turnRecord);
	const reasoningSection =
		buildReasoningSection(traceSource) ??
		(shouldExposeEmptyReasoningDetails(turnRecord, traceSource)
			? buildEmptyReasoningSection(traceSource)
			: null);
	if (reasoningSection) {
		sections.push(reasoningSection);
	}

	const assistantText = turnTracePreview?.assistantTextPreview.trim() ?? "";
	const fallbackText =
		!hasDisplayableText(turnRecord.turnResultMarkdown) && hasDisplayableText(turnRecord.output)
			? turnRecord.output.trim()
			: "";

	if (turnRecord.progress) {
		sections.push({
			kind: "turn_progress",
			report: turnRecord.progress,
			recordedAt: turnRecord.progressRecordedAt,
			attemptStatus:
				turnRecord.status === "in_progress"
					? "in_progress"
					: turnRecord.outcome === "failed" || turnRecord.outcome === "superseded"
						? turnRecord.outcome
						: "succeeded",
		});
	}

	if (assistantText.length === 0 && fallbackText.length > 0) {
		sections.push({
			kind: "operator_decision",
			text: fallbackText,
		});
	}

	if (!input.hasRenderableLeafOutcome && hasDisplayableText(turnRecord.turnResultMarkdown)) {
		sections.push({
			kind: "turn_result",
			markdown: turnRecord.turnResultMarkdown,
			resultSummary: turnRecord.resultSummary,
		});
	}

	return {
		kind: "turn_cluster",
		parentTurnRecordId: turnRecord.parentTurnRecordId,
		reviewedTurnRecordId: turnRecord.reviewedTurnRecordId,
		resources: turnRecord.resources,
		transition: turnRecord.transition,
		chronologyAt: turnRecord.createdAt,
		anchorId: buildTurnAnchorId(turnRecord.id),
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		turnType: turnRecord.turnType,
		title: formatChronicleTurnTitle(turnRecord),
		turnLabel: turnRecord.turnId,
		...(turnRecord.iteration ? { iteration: turnRecord.iteration } : {}),
		pathLabel: formatPiTreePathLabel(turnRecord),
		createdAt: turnRecord.createdAt,
		preview: getChronicleTurnPreview(turnRecord, 320),
		isOperatorDecision: turnPresentation === "operator_decision",
		turnPresentation,
		turnKindLabel: getChronicleTurnKindLabel(turnRecord),
		terminalStatus: input.terminalStatus,
		sections,
		modelProfileId: turnRecord.modelProfileId,
		usage: turnTracePreview?.usage ?? null,
		triggeringInput,
		piInput: toPiInputSummary({
			traceSource,
			triggeringInput,
			initialUserInputText: input.initialUserInputText,
		}),
		facts: { startedAt: turnRecord.startedAt, endedAt: turnRecord.endedAt },
		failure:
			turnRecord.outcome === "failed"
				? { summary: turnRecord.output || turnRecord.summary || "This turn failed." }
				: undefined,
	};
}

function buildLeafOutcomeItems(
	snapshots: readonly ProcessLeafOutcomeSnapshot[],
	turnTitlesByTurnRecordId: ReadonlyMap<string, string>,
	processState: {
		lifecycleStatus: string | null;
		selectedTurnId: string | null;
		updatedAt: string | null;
	},
): ChronicleLeafOutcomeItem[] {
	return snapshots.map((snapshot) => ({
		kind: "leaf_outcome",
		chronologyAt: snapshot.anchoredAt,
		anchorId: buildLeafOutcomeAnchorId(snapshot.id),
		instanceId: snapshot.instanceId,
		snapshotId: snapshot.id,
		leafEntryId: snapshot.leafEntryId,
		turnRecordId: snapshot.turnRecordId,
		title: "Result",
		ownerTurnTitle: snapshot.turnRecordId
			? (turnTitlesByTurnRecordId.get(snapshot.turnRecordId) ?? null)
			: null,
		rendererId: snapshot.rendererId,
		schemaVersion: snapshot.schemaVersion,
		props: snapshot.props,
		fallbackMarkdown: snapshot.fallbackMarkdown,
		status: snapshot.status,
		warningCode: snapshot.warningCode,
		warningMessage: snapshot.warningMessage,
		anchoredAt: snapshot.anchoredAt,
		createdAt: snapshot.createdAt,
		processLifecycleStatus: processState.lifecycleStatus,
		processSelectedTurnId: processState.selectedTurnId,
		processUpdatedAt: processState.updatedAt,
	}));
}

function promptOrNull(value: string | null | undefined): string | null {
	return value?.trim() ? value : null;
}

function buildPromptItem(
	text: string | null | undefined,
	createdAt: string | null | undefined,
): ChroniclePromptItem {
	const resolvedText = promptOrNull(text) ?? "";
	return {
		kind: "prompt",
		anchorId: buildPromptAnchorId(),
		createdAt: typeof createdAt === "string" && createdAt.trim() !== "" ? createdAt : null,
		text: resolvedText,
		preview: truncateText(resolvedText || "No prompt recorded.", 120),
	};
}

function sortInputsByConsumedAt(left: ChronicleInput, right: ChronicleInput): number {
	const leftTimestamp = left.consumedAt ?? left.receivedAt;
	const rightTimestamp = right.consumedAt ?? right.receivedAt;
	return leftTimestamp.localeCompare(rightTimestamp) || left.sequence - right.sequence;
}

function sortInputsByReceivedAt(left: ChronicleInput, right: ChronicleInput): number {
	return left.receivedAt.localeCompare(right.receivedAt) || left.sequence - right.sequence;
}

function sortTurnRecordsByStartedAt(
	left: Pick<TurnRecordView, "startedAt" | "id">,
	right: Pick<TurnRecordView, "startedAt" | "id">,
): number {
	return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
}

function isConsumedTriggeringInputCandidate(input: ChronicleInput): boolean {
	return (
		isChronicleTriggeringInput(input) &&
		typeof input.consumedAt === "string" &&
		input.consumedAt !== ""
	);
}

function toTriggeringInputSummary(
	input: ChronicleInput,
	fallbackConsumedAt?: string,
): ChronicleTriggeringInputSummary | null {
	const consumedAt = input.consumedAt ?? fallbackConsumedAt ?? input.receivedAt;
	if (!consumedAt) {
		return null;
	}
	return {
		inputId: input.id,
		source: input.source,
		sourceLabel: sourceLabel(input.source),
		bodyMarkdown: input.bodyMarkdown,
		receivedAt: input.receivedAt,
		consumedAt,
	};
}

function buildInitialPromptTriggeringInputSummary(
	initialUserInputText: string | null | undefined,
	promptCreatedAt: string | null | undefined,
	fallbackTimestamp: string,
): ChronicleTriggeringInputSummary | null {
	const normalizedPrompt = promptOrNull(initialUserInputText) ?? "";
	if (!hasDisplayableText(normalizedPrompt)) {
		return null;
	}
	const timestamp =
		typeof promptCreatedAt === "string" && promptCreatedAt.trim() !== ""
			? promptCreatedAt
			: fallbackTimestamp;
	return {
		inputId: "chronicle-initial-prompt",
		source: "initial_prompt",
		sourceLabel: "Initial prompt",
		bodyMarkdown: normalizedPrompt,
		receivedAt: timestamp,
		consumedAt: timestamp,
	};
}

function buildTriggeringInputIndex(
	input: BuildChronicleProjectionInput,
): Map<string, ChronicleTriggeringInputSummary> {
	const consumedCandidates = input.inputs
		.filter(isConsumedTriggeringInputCandidate)
		.sort(sortInputsByConsumedAt);
	const receivedCandidates = input.inputs
		.filter(isChronicleTriggeringInput)
		.sort(sortInputsByReceivedAt);

	const turnRecords = [...input.turnRecords].sort(sortTurnRecordsByStartedAt);
	if (turnRecords.length === 0) {
		return new Map();
	}

	const firstTurnRecordId = turnRecords[0]?.id ?? null;
	const initialPromptSummary = buildInitialPromptTriggeringInputSummary(
		input.initialUserInputText,
		input.promptCreatedAt,
		turnRecords[0]?.startedAt ?? "",
	);
	const index = new Map<string, ChronicleTriggeringInputSummary>();
	const assignedInputIds = new Set<string>();
	let nextConsumedCandidateIndex = 0;
	let windowStartExclusive: string | null = null;

	for (const turnRecord of turnRecords) {
		while (nextConsumedCandidateIndex < consumedCandidates.length) {
			const candidate = consumedCandidates[nextConsumedCandidateIndex];
			const consumedAt = candidate.consumedAt;
			if (!consumedAt) {
				nextConsumedCandidateIndex += 1;
				continue;
			}
			if (windowStartExclusive && consumedAt.localeCompare(windowStartExclusive) <= 0) {
				nextConsumedCandidateIndex += 1;
				continue;
			}
			if (consumedAt.localeCompare(turnRecord.startedAt) > 0) {
				break;
			}
			const summary = toTriggeringInputSummary(candidate);
			if (summary) {
				index.set(turnRecord.id, summary);
				assignedInputIds.add(candidate.id);
			}
			nextConsumedCandidateIndex += 1;
			break;
		}

		if (turnRecord.id === firstTurnRecordId && !index.has(turnRecord.id) && initialPromptSummary) {
			index.set(turnRecord.id, initialPromptSummary);
		}

		if (!index.has(turnRecord.id)) {
			for (
				let receivedIndex = receivedCandidates.length - 1;
				receivedIndex >= 0;
				receivedIndex -= 1
			) {
				const candidate = receivedCandidates[receivedIndex];
				if (assignedInputIds.has(candidate.id)) {
					continue;
				}
				if (windowStartExclusive && candidate.receivedAt.localeCompare(windowStartExclusive) <= 0) {
					break;
				}
				if (candidate.receivedAt.localeCompare(turnRecord.startedAt) > 0) {
					continue;
				}
				const summary = toTriggeringInputSummary(candidate, candidate.receivedAt);
				if (summary) {
					index.set(turnRecord.id, summary);
					assignedInputIds.add(candidate.id);
				}
				break;
			}
		}

		windowStartExclusive = turnRecord.endedAt ?? turnRecord.startedAt;
	}

	return index;
}

function buildLiveTail(input: {
	turnRecord: TurnRecordView | null;
	activeTurn: PrimaryPathActiveTurnSnapshot | CompactActiveTurnSnapshot | null | undefined;
	turnTracePreview: TurnTracePreview | undefined;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	initialUserInputText?: string | null;
}): ChronicleLiveTailItem | null {
	const { turnRecord, activeTurn, turnTracePreview, triggeringInput } = input;
	if (!turnRecord) {
		return null;
	}
	const liveToolCalls = activeTurn
		? "toolCalls" in activeTurn
			? activeTurn.toolCalls
			: activeTurn.currentTool
				? [
						{
							...activeTurn.currentTool,
							startedAt: activeTurn.startedAt,
							completedAt: null,
							arguments: null,
							result: null,
						},
					]
				: []
		: [];
	const runningToolCall = activeTurn
		? (liveToolCalls.findLast((toolCall) => toolCall.status === "running") ?? null)
		: null;
	const thinkingText = activeTurn?.assistant.thinking ?? "";
	const assistantText = activeTurn?.assistant.text.trim() ?? "";
	const hasThinkingText = thinkingText.trim().length > 0;
	const reasoningSection = activeTurn
		? buildReasoningSection({
				trace: {
					assistant: activeTurn.assistant,
					toolCalls: liveToolCalls,
					traceItems: "traceItems" in activeTurn ? activeTurn.traceItems : [],
					usage: activeTurn.usage,
					piInput: null,
				},
				preview: turnTracePreview,
			})
		: null;
	if (activeTurn && "currentTool" in activeTurn) {
		if (reasoningSection) {
			reasoningSection.toolCallCount = activeTurn.toolCallCount;
			reasoningSection.traceItemCount = activeTurn.traceItemCount;
		}
	}
	const state = runningToolCall
		? "tool_running"
		: hasThinkingText
			? "thinking"
			: assistantText.length > 0
				? "streaming"
				: "waiting";
	const thinkingPreview = {
		text: reasoningPreviewTail(thinkingText),
		truncated: thinkingText.length > THINKING_PREVIEW_MAX_LENGTH,
	};
	const copy =
		state === "tool_running"
			? `Running ${formatDefinition(runningToolCall?.toolName ?? "tool")}…`
			: state === "thinking"
				? thinkingPreview.text
				: state === "streaming"
					? truncateText(assistantText, 320)
					: getChronicleTurnPreview(turnRecord, 220) || "Waiting for more activity…";
	const stateLabel =
		state === "tool_running"
			? "Running action"
			: state === "thinking"
				? "Reasoning"
				: state === "streaming"
					? "Writing response"
					: "Waiting for activity";

	return {
		kind: "live_tail",
		progress: turnRecord.progress,
		progressRecordedAt: turnRecord.progressRecordedAt,
		parentTurnRecordId: turnRecord.parentTurnRecordId,
		anchorId: buildLiveTailAnchorId(turnRecord.id),
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		turnType: turnRecord.turnType,
		title: formatChronicleTurnTitle(turnRecord),
		turnLabel: turnRecord.turnId,
		...(turnRecord.iteration ? { iteration: turnRecord.iteration } : {}),
		pathLabel: activeTurn ? formatPiTreePathLabel(activeTurn) : formatPiTreePathLabel(turnRecord),
		state,
		stateLabel,
		copy,
		assistantTextPreview: reasoningPreviewTail(assistantText),
		reasoningSection:
			reasoningSection ??
			(activeTurn && turnRecord.turnType === "llm" && assistantText.length === 0
				? buildEmptyReasoningSection({ trace: undefined, preview: turnTracePreview })
				: null),
		toolCall: runningToolCall,
		usage: activeTurn?.usage ?? null,
		eventWindowTruncated:
			activeTurn && "eventWindowTruncated" in activeTurn ? activeTurn.eventWindowTruncated : false,
		modelProfileId: turnRecord.modelProfileId,
		triggeringInput,
		piInput: toPiInputSummary({
			traceSource: { trace: undefined, preview: turnTracePreview },
			triggeringInput,
			initialUserInputText: input.initialUserInputText,
		}),
		facts: {
			startedAt: turnRecord.startedAt ?? activeTurn?.startedAt ?? null,
			endedAt: turnRecord.endedAt,
		},
	};
}

function buildRetryLineageRootIndex(turnRecords: readonly TurnRecordView[]): Map<string, string> {
	const durableById = new Map(turnRecords.map((turnRecord) => [turnRecord.id, turnRecord]));
	const rootByTurnRecordId = new Map<string, string>();

	const resolveRootTurnRecordId = (turnRecordId: string): string => {
		const cached = rootByTurnRecordId.get(turnRecordId);
		if (cached) {
			return cached;
		}
		let currentTurnRecordId = turnRecordId;
		const seenTurnRecordIds = new Set<string>();
		while (!seenTurnRecordIds.has(currentTurnRecordId)) {
			seenTurnRecordIds.add(currentTurnRecordId);
			const currentTurnRecord = durableById.get(currentTurnRecordId);
			const parentTurnRecordId = currentTurnRecord?.parentTurnRecordId ?? null;
			if (!parentTurnRecordId) {
				break;
			}
			currentTurnRecordId = parentTurnRecordId;
		}
		rootByTurnRecordId.set(turnRecordId, currentTurnRecordId);
		return currentTurnRecordId;
	};

	for (const turnRecord of turnRecords) {
		resolveRootTurnRecordId(turnRecord.id);
	}

	return rootByTurnRecordId;
}

function buildTurnRailItems(
	turnRecords: readonly TurnRecordView[],
	liveTail: ChronicleLiveTailItem | null,
): ChronicleProjectedTurnRailItem[] {
	const retryLineageRootByTurnRecordId = buildRetryLineageRootIndex(turnRecords);
	return turnRecords.map((turnRecord) => ({
		...buildChronicleTurnRailItem(turnRecord),
		anchorId:
			turnRecord.status === "in_progress" && liveTail
				? liveTail.anchorId
				: buildTurnAnchorId(turnRecord.id),
		retryLineageRootTurnRecordId:
			retryLineageRootByTurnRecordId.get(turnRecord.id) ?? turnRecord.id,
	}));
}

function buildTerminalRailItem(
	terminalStatus: ProcessTerminalStatus | null,
): ChronicleTerminalRailItem | null {
	if (!terminalStatus) {
		return null;
	}
	return {
		terminalStatus,
		anchorId: buildTerminalAnchorId(terminalStatus),
		title: getProcessTerminalRailTitle(terminalStatus),
	};
}

function chronicleItemOrder(item: ChronicleTimelineItem): number {
	switch (item.kind) {
		case "prompt":
			return -1;
		case "operator_input":
			return 0;
		case "turn_cluster":
			return 1;
		case "leaf_outcome":
			return 2;
		default:
			return 3;
	}
}

function compareChronicleItems(left: ChronicleTimelineItem, right: ChronicleTimelineItem): number {
	if (!("chronologyAt" in left) || !("chronologyAt" in right)) {
		return 0;
	}
	const timestampComparison = left.chronologyAt.localeCompare(right.chronologyAt);
	if (timestampComparison !== 0) {
		return timestampComparison;
	}
	return chronicleItemOrder(left) - chronicleItemOrder(right);
}

export function extractChronicleReasoningTurnRecordIds(
	projection: ChronicleProjection,
	questionRequests: readonly ProcessQuestionRequest[] = [],
): string[] {
	const questionTurnRecordIds = new Set(questionRequests.map((request) => request.turnRecordId));
	return projection.timelineItems.flatMap((item) => {
		if (item.kind !== "turn_cluster" && item.kind !== "live_tail") return [];
		const hasReasoning =
			item.kind === "turn_cluster"
				? item.sections.some((section) => section.kind === "thinking_preview")
				: item.reasoningSection || item.turnType === "llm";
		return hasReasoning || questionTurnRecordIds.has(item.turnRecordId) ? [item.turnRecordId] : [];
	});
}

export function buildChronicleProjection(
	input: BuildChronicleProjectionInput,
): ChronicleProjection {
	const isTerminal = input.lifecycleStatus === "completed" || input.lifecycleStatus === "aborted";
	const resolvedTerminalStatus: ProcessTerminalStatus | null = isTerminal
		? (input.lifecycleStatus as ProcessTerminalStatus)
		: null;
	const displayPromptText =
		promptOrNull(input.initialUserInputText) ?? promptOrNull(input.promptText);
	const promptItem = displayPromptText
		? buildPromptItem(displayPromptText, input.promptCreatedAt)
		: null;
	const triggeringInputIndex = buildTriggeringInputIndex(input);
	const completedTurnRecords = input.turnRecords.filter(
		(turnRecord) => turnRecord.status === "completed",
	);
	const lastCompletedId = completedTurnRecords.at(-1)?.id ?? null;
	const completedTurnClusters = completedTurnRecords.map((turnRecord) => {
		const isLast = turnRecord.id === lastCompletedId;
		const triggeringInput = triggeringInputIndex.get(turnRecord.id) ?? null;
		return buildTurnClusterItem({
			turnRecord,
			turnTracePreview: input.turnTracePreviewIndex?.[turnRecord.id],
			terminalStatus: isLast ? resolvedTerminalStatus : null,
			hasRenderableLeafOutcome: hasRenderableLeafOutcomeForTurn(
				turnRecord.id,
				input.leafOutcomeSnapshots,
			),
			triggeringInput,
			initialUserInputText: input.initialUserInputText,
		});
	});
	const operatorInputs = input.inputs
		.filter(isStandaloneChronicleOperatorInput)
		.map<ChronicleOperatorInputItem>((processInput) => ({
			kind: "operator_input",
			chronologyAt: processInput.receivedAt,
			inputId: processInput.id,
			source: processInput.source,
			sourceLabel: sourceLabel(processInput.source),
			bodyMarkdown: processInput.bodyMarkdown,
			receivedAt: processInput.receivedAt,
		}));
	const turnTitlesByTurnRecordId = new Map(
		input.turnRecords.map((turnRecord) => [turnRecord.id, formatChronicleTurnTitle(turnRecord)]),
	);
	const leafOutcomeItems = buildLeafOutcomeItems(
		input.leafOutcomeSnapshots,
		turnTitlesByTurnRecordId,
		{
			lifecycleStatus: input.lifecycleStatus ?? null,
			selectedTurnId: input.selectedTurnId ?? null,
			updatedAt: input.processUpdatedAt ?? null,
		},
	);
	const activeTurnRecord =
		input.turnRecords.find((turnRecord) => turnRecord.status === "in_progress") ?? null;
	const liveTailTriggeringInput =
		(activeTurnRecord && triggeringInputIndex.get(activeTurnRecord.id)) ?? null;
	const liveTail = buildLiveTail({
		turnRecord: activeTurnRecord,
		activeTurn: input.activeTurn,
		turnTracePreview: activeTurnRecord
			? input.turnTracePreviewIndex?.[activeTurnRecord.id]
			: undefined,
		triggeringInput: liveTailTriggeringInput,
		initialUserInputText: input.initialUserInputText,
	});
	const terminalRailItem = buildTerminalRailItem(resolvedTerminalStatus);
	const timelineItems = [
		...(promptItem ? [promptItem] : []),
		...completedTurnClusters,
		...operatorInputs,
		...leafOutcomeItems,
	].sort(compareChronicleItems);

	if (liveTail) {
		timelineItems.push(liveTail);
	} else if (
		input.definesLeafOutcome &&
		completedTurnClusters.length > 0 &&
		leafOutcomeItems.length === 0
	) {
		timelineItems.push({
			kind: "leaf_outcome_placeholder",
			latestTurnTitle: completedTurnClusters.at(-1)?.title ?? null,
		});
	}

	const latestAnchorableTimelineItem = timelineItems.findLast(
		(item): item is Extract<ChronicleTimelineItem, { anchorId: string }> => "anchorId" in item,
	);
	const latestFocusedTurnId = timelineItems.findLast((item) => {
		return (
			((item.kind === "turn_cluster" || item.kind === "live_tail") &&
				typeof item.turnRecordId === "string") ||
			item.kind === "leaf_outcome"
		);
	});

	return {
		promptItem,
		turnRailItems: buildTurnRailItems(input.turnRecords, liveTail),
		terminalRailItem,
		timelineItems,
		initialAnchorId: terminalRailItem?.anchorId ?? latestAnchorableTimelineItem?.anchorId ?? null,
		initialFocusedTurnId:
			activeTurnRecord?.id ??
			(latestFocusedTurnId && "turnRecordId" in latestFocusedTurnId
				? latestFocusedTurnId.turnRecordId
				: (input.turnRecords.at(-1)?.id ?? null)),
		liveTail,
		latestCompletedTurnTitle: completedTurnClusters.at(-1)?.title ?? null,
	};
}
