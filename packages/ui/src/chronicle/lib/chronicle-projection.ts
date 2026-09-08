import {
	formatPathTypeLabel,
	type ProcessInput,
	type ProcessLeafOutcomeSnapshot,
	type ProcessQuestionRequest,
	type ProcessTurnRecord,
	type TurnProgressReport,
	trimToNull,
} from "@leitwerk-dev/domain";
import {
	buildTrailingLinePreview,
	type PrimaryPathActiveTurnSnapshot,
	type ProcessTimelineTurnSummary,
	type TurnPiInputPart,
	type TurnTracePreview,
	type TurnTraceSnapshot,
	type TurnUsageSnapshot,
} from "@leitwerk-dev/protocol";

type ChronicleInput = Pick<
	ProcessInput,
	"id" | "sequence" | "source" | "kind" | "bodyMarkdown" | "receivedAt" | "consumedAt"
>;

import type { ProcessRunDetailsView } from "@leitwerk-dev/protocol/http-contracts";
import { formatDefinition } from "../../lib/format";
import { markdownToPlainText, truncateText } from "../../lib/markdown";
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
	formatChronicleTurnLabel,
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

export interface ChronicleReasoningThinkingItem {
	kind: "thinking_chunk";
	text: string;
}

export interface ChronicleReasoningToolItem {
	kind: "tool_call";
	toolCall: TurnTraceSnapshot["toolCalls"][number];
}

export interface ChronicleReasoningOperationalEventItem {
	kind: "operational_event";
	event: Extract<TurnTraceSnapshot["traceItems"][number], { kind: "operational_event" }>;
}

export type ChronicleReasoningTimelineItem =
	| ChronicleReasoningThinkingItem
	| ChronicleReasoningToolItem
	| ChronicleReasoningOperationalEventItem;

export interface ChronicleThinkingSection {
	kind: "thinking_preview";
	text: string;
	preview: string;
	previewTruncated: boolean;
	items: ChronicleReasoningTimelineItem[];
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

export type ChronicleTriggerSource = "external_event" | "user_action" | "unknown";
export type ChronicleRunMode = "scheduled" | "immediate" | "unknown";

export interface ChronicleTurnFacts {
	startedAt: string | null;
	endedAt: string | null;
	triggerSource: ChronicleTriggerSource;
	runMode: ChronicleRunMode;
	activeToolNames: readonly string[];
}

export interface ChronicleOperatorDecisionSection {
	kind: "operator_decision";
	text: string;
}

export interface ChronicleTurnResultSection {
	kind: "turn_result";
	markdown: string;
}

export interface ChronicleTurnProgressSection {
	kind: "turn_progress";
	report: TurnProgressReport;
}

export type ChronicleTurnClusterSection =
	| ChronicleThinkingSection
	| ChronicleOperatorDecisionSection
	| ChronicleTurnProgressSection
	| ChronicleTurnResultSection;

export interface ChronicleTurnClusterItem {
	kind: "turn_cluster";
	chronologyAt: string;
	anchorId: string;
	turnRecordId: string;
	turnId: string;
	turnType?: ProcessTurnRecord["turnType"];
	title: string;
	turnLabel: string;
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
	kind: "live_tail";
	anchorId: string;
	turnRecordId: string;
	turnId: string;
	turnType?: ProcessTurnRecord["turnType"];
	title: string;
	turnLabel: string;
	pathLabel: string | null;
	state: "tool_running" | "thinking" | "streaming" | "waiting";
	stateLabel: string;
	copy: string;
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

export interface ChronicleReasoningDetailEntry {
	entryId: string;
	turnRecordId: string;
	turnId: string;
	title: string;
	turnLabel: string;
	stateLabel: string | null;
	isLive: boolean;
	modelProfileId: string | null;
	usage: TurnUsageSnapshot | null;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	piInput: ChroniclePiInputSummary | null;
	facts: ChronicleTurnFacts;
	reasoningSection: ChronicleThinkingSection;
}

export interface BuildChronicleProjectionInput {
	turnRecords: readonly TurnRecordView[];
	turnTraceIndex: Record<string, TurnTraceSnapshot | undefined>;
	turnTracePreviewIndex?: Record<string, TurnTracePreview | undefined>;
	runDetails?: ProcessRunDetailsView | null;
	initialUserInputText?: string | null;
	inputs: readonly ChronicleInput[];
	leafOutcomeSnapshots: readonly ProcessLeafOutcomeSnapshot[];
	definesLeafOutcome: boolean;
	activeTurn: PrimaryPathActiveTurnSnapshot | null | undefined;
	lifecycleStatus?: string | null;
	selectedTurnId?: string | null;
	processUpdatedAt?: string | null;
	promptText?: string | null;
	promptCreatedAt?: string | null;
}

// Tunable inline reasoning window: keep the preview calm, recent, and line-based.
export const THINKING_PREVIEW_LINE_COUNT = 3;
const THINKING_PREVIEW_MAX_LENGTH = 320;

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

function normalizeComparableText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function buildReasoningTimelineItems(
	turnTrace: TurnTraceSnapshot | undefined,
): ChronicleReasoningTimelineItem[] {
	const traceItems = turnTrace?.traceItems ?? [];
	const toolCalls = turnTrace?.toolCalls ?? [];
	const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall]));
	const resolvedItems: ChronicleReasoningTimelineItem[] = [];
	const seenToolCallIds = new Set<string>();

	for (const traceItem of traceItems) {
		if (traceItem.kind === "thinking") {
			if (!hasDisplayableText(traceItem.text)) {
				continue;
			}
			resolvedItems.push({
				kind: "thinking_chunk",
				text: traceItem.text,
			});
			continue;
		}
		if (traceItem.kind === "operational_event") {
			resolvedItems.push({
				kind: "operational_event",
				event: traceItem,
			});
			continue;
		}
		const toolCall = toolCallsById.get(traceItem.toolCallId);
		if (!toolCall) {
			continue;
		}
		seenToolCallIds.add(toolCall.toolCallId);
		resolvedItems.push({
			kind: "tool_call",
			toolCall,
		});
	}

	if (resolvedItems.length === 0) {
		const thinkingText = turnTrace?.assistant.thinking ?? "";
		if (hasDisplayableText(thinkingText)) {
			resolvedItems.push({
				kind: "thinking_chunk",
				text: thinkingText,
			});
		}
		for (const toolCall of toolCalls) {
			resolvedItems.push({
				kind: "tool_call",
				toolCall,
			});
			seenToolCallIds.add(toolCall.toolCallId);
		}
		return resolvedItems;
	}

	for (const toolCall of toolCalls) {
		if (seenToolCallIds.has(toolCall.toolCallId)) {
			continue;
		}
		resolvedItems.push({
			kind: "tool_call",
			toolCall,
		});
		seenToolCallIds.add(toolCall.toolCallId);
	}

	return resolvedItems;
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
		items: [],
		toolCallCount: source.trace?.toolCalls.length ?? source.preview?.toolCallCount ?? 0,
		traceItemCount: source.trace?.traceItems.length ?? source.preview?.traceItemCount ?? 0,
	};
}

function buildReasoningSection(source: TurnTraceProjectionSource): ChronicleThinkingSection | null {
	const thinkingText = source.trace?.assistant.thinking ?? source.preview?.thinkingPreview ?? "";
	const items = buildReasoningTimelineItems(source.trace);
	const hasPreviewDetails =
		source.trace === undefined && source.preview?.hasReasoningDetails === true;
	if (!hasDisplayableText(thinkingText) && items.length === 0 && !hasPreviewDetails) {
		return null;
	}
	const thinkingPreview = source.trace
		? buildTrailingLinePreview(
				thinkingText,
				THINKING_PREVIEW_LINE_COUNT,
				THINKING_PREVIEW_MAX_LENGTH,
			)
		: {
				text: source.preview?.thinkingPreview ?? "",
				truncated: source.preview?.thinkingPreviewTruncated ?? false,
			};
	return {
		kind: "thinking_preview",
		text: thinkingText,
		preview: thinkingPreview.text,
		previewTruncated: thinkingPreview.truncated,
		items,
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

type ChronicleActionSource = ProcessTimelineTurnSummary["actionSource"];

function uniqueNonEmptyToolNames(values: readonly string[]): string[] {
	const names = new Set<string>();
	for (const value of values) {
		const toolName = value.trim();
		if (toolName !== "") {
			names.add(toolName);
		}
	}
	return [...names];
}

function activeToolNamesForTurn(
	runDetails: ProcessRunDetailsView | null | undefined,
	turnId: string,
): readonly string[] {
	const turn = runDetails?.turns.find((candidate) => candidate.turnId === turnId);
	return uniqueNonEmptyToolNames([
		...(turn?.activePiToolNames ?? []),
		...(turn?.outcomeActions.map((action) => action.name) ?? []),
	]);
}

function triggerSourceFor(
	triggeringInput: ChronicleTriggeringInputSummary | null,
	actionSource: ChronicleActionSource | null,
): ChronicleTriggerSource {
	if (actionSource === "ui") {
		return "user_action";
	}
	if (actionSource === "external" || actionSource === "scheduled") {
		return "external_event";
	}
	if (!triggeringInput) {
		return "unknown";
	}
	switch (triggeringInput.source) {
		case "external_comment":
		case "watcher_event":
			return "external_event";
		case "app_steer":
		case "action_prompt":
		case "initial_prompt":
			return "user_action";
		default:
			return "unknown";
	}
}

function runModeFor(
	triggeringInput: ChronicleTriggeringInputSummary | null,
	actionSource: ChronicleActionSource | null,
): ChronicleRunMode {
	if (actionSource === "scheduled") {
		return "scheduled";
	}
	if (actionSource === "ui" || actionSource === "external") {
		return "immediate";
	}
	if (
		triggeringInput?.source === "initial_prompt" ||
		triggeringInput?.source === "app_steer" ||
		triggeringInput?.source === "external_comment" ||
		triggeringInput?.source === "action_prompt" ||
		triggeringInput?.source === "watcher_event"
	) {
		return "immediate";
	}
	return "unknown";
}

function toPiInputSummary(input: {
	traceSource: TurnTraceProjectionSource;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	initialUserInputText?: string | null;
}): ChroniclePiInputSummary | null {
	const piInput = input.traceSource.trace?.piInput;
	const previewInput = input.traceSource.preview?.piInput;
	const fullPrompt = piInput?.fullPrompt ?? previewInput?.userInputPreview ?? "";
	if (fullPrompt.trim() === "") {
		return null;
	}
	return {
		parts: piInput ? [...piInput.parts] : [],
		fullPrompt,
		createdAt: piInput?.createdAt ?? previewInput?.createdAt ?? "",
		userInput:
			trimToNull(input.triggeringInput?.bodyMarkdown) ??
			trimToNull(input.initialUserInputText) ??
			null,
	};
}

function buildTurnFacts(input: {
	turnId: string;
	durableTurnRecord: TurnRecordView | undefined;
	activeTurn?: PrimaryPathActiveTurnSnapshot | null;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	actionSource: ChronicleActionSource | null;
	runDetails?: ProcessRunDetailsView | null;
}): ChronicleTurnFacts {
	return {
		startedAt: input.durableTurnRecord?.startedAt ?? input.activeTurn?.startedAt ?? null,
		endedAt: input.durableTurnRecord?.endedAt ?? null,
		triggerSource: triggerSourceFor(input.triggeringInput, input.actionSource),
		runMode: runModeFor(input.triggeringInput, input.actionSource),
		activeToolNames: activeToolNamesForTurn(input.runDetails, input.turnId),
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

function hasDistinctTurnResult(
	turnRecord: TurnRecordView,
	assistantOutputText: string,
	assistantOutputTruncated = false,
): boolean {
	if (!hasDisplayableText(turnRecord.turnResultMarkdown)) {
		return false;
	}
	const markdownText = normalizeComparableText(markdownToPlainText(turnRecord.turnResultMarkdown));
	const assistantText = normalizeComparableText(assistantOutputText);
	if (markdownText.length === 0) {
		return false;
	}
	if (assistantOutputTruncated && assistantText.length > 0) {
		return !markdownText.startsWith(assistantText);
	}
	return markdownText !== assistantText;
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
		(Boolean(traceSource.trace?.piInput) ||
			traceSource.trace?.usage != null ||
			traceSource.preview?.hasReasoningDetails === true ||
			turnRecord.modelProfileId !== null)
	);
}

function buildTurnClusterItem(input: {
	turnRecord: TurnRecordView;
	turnTrace: TurnTraceSnapshot | undefined;
	turnTracePreview: TurnTracePreview | undefined;
	terminalStatus: "completed" | "aborted" | null;
	hasRenderableLeafOutcome: boolean;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	facts: ChronicleTurnFacts;
	initialUserInputText?: string | null;
}): ChronicleTurnClusterItem {
	const { turnRecord, turnTrace, turnTracePreview, triggeringInput } = input;
	const traceSource = { trace: turnTrace, preview: turnTracePreview };
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

	const assistantText =
		turnTrace?.assistant.text?.trim() ?? turnTracePreview?.assistantTextPreview.trim() ?? "";
	const fallbackText =
		!hasDisplayableText(turnRecord.turnResultMarkdown) && hasDisplayableText(turnRecord.output)
			? turnRecord.output.trim()
			: "";

	if (turnRecord.progress) {
		sections.push({ kind: "turn_progress", report: turnRecord.progress });
	}

	if (assistantText.length === 0 && fallbackText.length > 0) {
		sections.push({
			kind: "operator_decision",
			text: fallbackText,
		});
	}

	if (
		!input.hasRenderableLeafOutcome &&
		hasDistinctTurnResult(
			turnRecord,
			assistantText || fallbackText,
			turnTrace === undefined && turnTracePreview?.assistantTextTruncated === true,
		)
	) {
		sections.push({
			kind: "turn_result",
			markdown: turnRecord.turnResultMarkdown,
		});
	}

	return {
		kind: "turn_cluster",
		chronologyAt: turnRecord.createdAt,
		anchorId: buildTurnAnchorId(turnRecord.id),
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		turnType: turnRecord.turnType,
		title: formatChronicleTurnLabel(turnRecord.displayTurn),
		turnLabel: turnRecord.turnId,
		pathLabel: formatPiTreePathLabel(turnRecord),
		createdAt: turnRecord.createdAt,
		preview: getChronicleTurnPreview(turnRecord, 320),
		isOperatorDecision: turnPresentation === "operator_decision",
		turnPresentation,
		turnKindLabel: getChronicleTurnKindLabel(turnRecord),
		terminalStatus: input.terminalStatus,
		sections,
		modelProfileId: turnRecord.modelProfileId,
		usage: turnTrace?.usage ?? turnTracePreview?.usage ?? null,
		triggeringInput,
		piInput: toPiInputSummary({
			traceSource,
			triggeringInput,
			initialUserInputText: input.initialUserInputText,
		}),
		facts: input.facts,
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

function buildPromptItem(
	text: string | null | undefined,
	createdAt: string | null | undefined,
): ChroniclePromptItem {
	const resolvedText = typeof text === "string" ? text.trim() : "";
	return {
		kind: "prompt",
		anchorId: buildPromptAnchorId(),
		createdAt: typeof createdAt === "string" && createdAt.trim() !== "" ? createdAt : null,
		text: resolvedText,
		preview: truncateText(resolvedText || "No prompt recorded.", 120),
	};
}

function compareChronicleTimestamps(left: string, right: string): number {
	return left.localeCompare(right);
}

function sortInputsByConsumedAt(left: ChronicleInput, right: ChronicleInput): number {
	const leftTimestamp = left.consumedAt ?? left.receivedAt;
	const rightTimestamp = right.consumedAt ?? right.receivedAt;
	const timestampComparison = compareChronicleTimestamps(leftTimestamp, rightTimestamp);
	if (timestampComparison !== 0) {
		return timestampComparison;
	}
	return left.sequence - right.sequence;
}

function sortInputsByReceivedAt(left: ChronicleInput, right: ChronicleInput): number {
	const timestampComparison = compareChronicleTimestamps(left.receivedAt, right.receivedAt);
	if (timestampComparison !== 0) {
		return timestampComparison;
	}
	return left.sequence - right.sequence;
}

function sortTurnRecordsByStartedAt(
	left: Pick<TurnRecordView, "startedAt" | "id">,
	right: Pick<TurnRecordView, "startedAt" | "id">,
): number {
	const startedAtComparison = compareChronicleTimestamps(left.startedAt, right.startedAt);
	if (startedAtComparison !== 0) {
		return startedAtComparison;
	}
	return left.id.localeCompare(right.id);
}

function isConsumedTriggeringInputCandidate(input: ChronicleInput): boolean {
	return (
		isChronicleTriggeringInput(input) &&
		typeof input.consumedAt === "string" &&
		input.consumedAt !== ""
	);
}

function isReceivedTriggeringInputCandidate(input: ChronicleInput): boolean {
	return isChronicleTriggeringInput(input);
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
	const normalizedPrompt = trimToNull(initialUserInputText) ?? "";
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
		.filter(isReceivedTriggeringInputCandidate)
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
			if (
				windowStartExclusive &&
				compareChronicleTimestamps(consumedAt, windowStartExclusive) <= 0
			) {
				nextConsumedCandidateIndex += 1;
				continue;
			}
			if (compareChronicleTimestamps(consumedAt, turnRecord.startedAt) > 0) {
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
				if (
					windowStartExclusive &&
					compareChronicleTimestamps(candidate.receivedAt, windowStartExclusive) <= 0
				) {
					break;
				}
				if (compareChronicleTimestamps(candidate.receivedAt, turnRecord.startedAt) > 0) {
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

function mergeLiveToolCallsWithSessionDetails(
	activeToolCalls: ReadonlyArray<PrimaryPathActiveTurnSnapshot["toolCalls"][number]>,
	sessionToolCalls: ReadonlyArray<TurnTraceSnapshot["toolCalls"][number]> | undefined,
): TurnTraceSnapshot["toolCalls"] {
	const sessionToolCallsById = new Map(
		(sessionToolCalls ?? []).map((toolCall) => [toolCall.toolCallId, toolCall]),
	);
	const seenToolCallIds = new Set<string>();
	const mergedToolCalls: TurnTraceSnapshot["toolCalls"] = activeToolCalls.map((toolCall) => {
		seenToolCallIds.add(toolCall.toolCallId);
		const sessionToolCall = sessionToolCallsById.get(toolCall.toolCallId);
		if (!sessionToolCall) {
			return toolCall;
		}
		return {
			...toolCall,
			arguments: toolCall.arguments ?? sessionToolCall.arguments,
			resultText: sessionToolCall.resultText,
			truncated: sessionToolCall.truncated,
		};
	});
	for (const sessionToolCall of sessionToolCalls ?? []) {
		if (!seenToolCallIds.has(sessionToolCall.toolCallId)) {
			mergedToolCalls.push(sessionToolCall);
		}
	}
	return mergedToolCalls;
}

function buildLiveTail(input: {
	turnRecord: TurnRecordView | null;
	activeTurn: PrimaryPathActiveTurnSnapshot | null | undefined;
	turnTrace: TurnTraceSnapshot | undefined;
	turnTracePreview: TurnTracePreview | undefined;
	triggeringInput: ChronicleTriggeringInputSummary | null;
	facts: ChronicleTurnFacts | null;
	runDetails?: ProcessRunDetailsView | null;
	initialUserInputText?: string | null;
}): ChronicleLiveTailItem | null {
	const { turnRecord, activeTurn, turnTrace, turnTracePreview, triggeringInput } = input;
	if (!turnRecord) {
		return null;
	}
	const liveToolCalls = activeTurn
		? mergeLiveToolCallsWithSessionDetails(activeTurn.toolCalls, turnTrace?.toolCalls)
		: [];
	const runningToolCall = activeTurn
		? ([...liveToolCalls].reverse().find((toolCall) => toolCall.status === "running") ?? null)
		: null;
	const thinkingText = activeTurn?.assistant.thinking ?? "";
	const assistantText = activeTurn?.assistant.text.trim() ?? "";
	const hasThinkingText = thinkingText.trim().length > 0;
	const reasoningSection = activeTurn
		? buildReasoningSection({
				trace: {
					assistant: activeTurn.assistant,
					toolCalls: liveToolCalls,
					traceItems: activeTurn.traceItems,
					usage: activeTurn.usage,
					piInput: turnTrace?.piInput ?? null,
				},
				preview: turnTracePreview,
			})
		: null;
	const state = runningToolCall
		? "tool_running"
		: hasThinkingText
			? "thinking"
			: assistantText.length > 0
				? "streaming"
				: "waiting";
	const thinkingPreview = buildTrailingLinePreview(
		thinkingText,
		THINKING_PREVIEW_LINE_COUNT,
		THINKING_PREVIEW_MAX_LENGTH,
	);
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
		anchorId: buildLiveTailAnchorId(turnRecord.id),
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		turnType: turnRecord.turnType,
		title: formatChronicleTurnLabel(turnRecord.displayTurn),
		turnLabel: turnRecord.turnId,
		pathLabel: activeTurn ? formatPiTreePathLabel(activeTurn) : formatPiTreePathLabel(turnRecord),
		state,
		stateLabel,
		copy,
		reasoningSection,
		toolCall: runningToolCall,
		usage: activeTurn?.usage ?? null,
		eventWindowTruncated: activeTurn?.eventWindowTruncated ?? false,
		modelProfileId: turnRecord.modelProfileId,
		triggeringInput,
		piInput: toPiInputSummary({
			traceSource: { trace: turnTrace, preview: turnTracePreview },
			triggeringInput,
			initialUserInputText: input.initialUserInputText,
		}),
		facts:
			input.facts ??
			buildTurnFacts({
				turnId: turnRecord.turnId,
				durableTurnRecord: undefined,
				activeTurn: activeTurn ?? null,
				triggeringInput,
				actionSource: null,
				runDetails: input.runDetails,
			}),
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

function findReasoningSection(
	sections: readonly ChronicleTurnClusterSection[],
): ChronicleThinkingSection | null {
	for (const section of sections) {
		if (section.kind === "thinking_preview") {
			return section;
		}
	}
	return null;
}

export function extractChronicleReasoningDetailEntries(
	projection: ChronicleProjection,
	questionRequests: readonly ProcessQuestionRequest[] = [],
): ChronicleReasoningDetailEntry[] {
	const entries: ChronicleReasoningDetailEntry[] = [];
	const questionTurnRecordIds = new Set(questionRequests.map((request) => request.turnRecordId));
	for (const item of projection.timelineItems) {
		if (item.kind !== "turn_cluster" && item.kind !== "live_tail") {
			continue;
		}
		const recordedReasoningSection =
			item.kind === "turn_cluster" ? findReasoningSection(item.sections) : item.reasoningSection;
		const reasoningSection =
			recordedReasoningSection ??
			(questionTurnRecordIds.has(item.turnRecordId)
				? buildEmptyReasoningSection({ trace: undefined, preview: undefined })
				: null);
		if (!reasoningSection) {
			continue;
		}
		if (item.kind === "turn_cluster") {
			entries.push({
				entryId: item.turnRecordId,
				turnRecordId: item.turnRecordId,
				turnId: item.turnId,
				title: item.title,
				turnLabel: item.turnLabel,
				stateLabel: null,
				isLive: false,
				modelProfileId: item.modelProfileId,
				usage: item.usage,
				triggeringInput: item.triggeringInput,
				piInput: item.piInput,
				facts: item.facts,
				reasoningSection,
			});
			continue;
		}
		entries.push({
			entryId: item.turnRecordId,
			turnRecordId: item.turnRecordId,
			turnId: item.turnId,
			title: item.title,
			turnLabel: item.turnLabel,
			stateLabel: item.stateLabel,
			isLive: true,
			modelProfileId: item.modelProfileId,
			usage: item.usage,
			triggeringInput: item.triggeringInput,
			piInput: item.piInput,
			facts: item.facts,
			reasoningSection,
		});
	}
	return entries;
}

export function buildChronicleProjection(
	input: BuildChronicleProjectionInput,
): ChronicleProjection {
	const isTerminal = input.lifecycleStatus === "completed" || input.lifecycleStatus === "aborted";
	const resolvedTerminalStatus: ProcessTerminalStatus | null = isTerminal
		? (input.lifecycleStatus as ProcessTerminalStatus)
		: null;
	const displayPromptText = trimToNull(input.initialUserInputText) ?? trimToNull(input.promptText);
	const promptItem = displayPromptText
		? buildPromptItem(displayPromptText, input.promptCreatedAt)
		: null;
	const triggeringInputIndex = buildTriggeringInputIndex(input);
	const durableTurnRecordById = new Map(
		input.turnRecords.map((turnRecord) => [turnRecord.id, turnRecord]),
	);
	const completedTurnRecords = input.turnRecords.filter(
		(turnRecord) => turnRecord.status === "completed",
	);
	const lastCompletedId = completedTurnRecords.at(-1)?.id ?? null;
	const completedTurnClusters = completedTurnRecords.map((turnRecord) => {
		const isLast = turnRecord.id === lastCompletedId;
		const triggeringInput = triggeringInputIndex.get(turnRecord.id) ?? null;
		return buildTurnClusterItem({
			turnRecord,
			turnTrace: input.turnTraceIndex[turnRecord.id],
			turnTracePreview: input.turnTracePreviewIndex?.[turnRecord.id],
			terminalStatus: isLast ? resolvedTerminalStatus : null,
			hasRenderableLeafOutcome: hasRenderableLeafOutcomeForTurn(
				turnRecord.id,
				input.leafOutcomeSnapshots,
			),
			triggeringInput,
			facts: buildTurnFacts({
				turnId: turnRecord.turnId,
				durableTurnRecord: durableTurnRecordById.get(turnRecord.id),
				triggeringInput,
				actionSource: turnRecord.actionSource,
				runDetails: input.runDetails,
			}),
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
		input.turnRecords.map((turnRecord) => [
			turnRecord.id,
			formatChronicleTurnLabel(turnRecord.displayTurn),
		]),
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
		turnTrace: activeTurnRecord ? input.turnTraceIndex[activeTurnRecord.id] : undefined,
		turnTracePreview: activeTurnRecord
			? input.turnTracePreviewIndex?.[activeTurnRecord.id]
			: undefined,
		triggeringInput: liveTailTriggeringInput,
		facts: activeTurnRecord
			? buildTurnFacts({
					turnId: activeTurnRecord.turnId,
					durableTurnRecord: durableTurnRecordById.get(activeTurnRecord.id),
					activeTurn: input.activeTurn ?? null,
					triggeringInput: liveTailTriggeringInput,
					actionSource: activeTurnRecord.actionSource,
					runDetails: input.runDetails,
				})
			: null,
		runDetails: input.runDetails,
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

	const latestAnchorableTimelineItem = [...timelineItems]
		.reverse()
		.find(
			(item): item is Extract<ChronicleTimelineItem, { anchorId: string }> => "anchorId" in item,
		);
	const latestFocusedTurnId = [...timelineItems].reverse().find((item) => {
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
