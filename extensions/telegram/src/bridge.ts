import { randomBytes } from "node:crypto";
import type {
	ProcessInstance,
	ProcessLeafOutcomeSnapshot,
	ProcessTurnRecord,
	ProcessTurnRecordPathType,
} from "@leitwerk-dev/domain";
import type {
	CoreServerSetupDeps,
	FormDefinition,
	LauncherFieldOptionDefinition,
	LauncherModelConfigPreviewLike,
	LauncherModelConfigSchemaLike,
	ModelProfileOptionSummaryLike,
	ProcessActionSummaryLike,
	ProcessLaunchPlan,
	ProcessModelSelectionServiceLike,
	ServerExtensionEventMap,
	ServerExtensionLogger,
	UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";
import { buildActionKeyboard, continuableFailedTurnRecordId } from "./actions.js";
import { TELEGRAM_ACTOR } from "./actor.js";
import type { TelegramExtensionConfig } from "./config.js";
import {
	type ActionPreviewLike,
	applyFormSkip,
	applyFormText,
	applyQuestionText,
	buildActionFormSession,
	buildActionModelPrompt,
	buildActionModelSession,
	buildActionModelSwitchWarning,
	buildContinueSession,
	buildFieldPrompt,
	buildQuestionPrompt,
	buildQuestionSession,
	buildRecoveryModelPrompt,
	buildRecoveryModelSession,
	canSkipActionFormField,
	currentField,
	type PendingActionFormSession,
	type PendingActionModelSession,
	type PendingRecoveryModelSession,
	type PendingTelegramSession,
} from "./form-session.js";
import {
	applyLaunchFieldText,
	applyLaunchFieldValue,
	applyLaunchModelStepAction,
	applyLaunchModelStepText,
	beginLaunchModelEdit,
	buildLaunchFieldPrompt,
	buildLaunchInput,
	buildLaunchModelConfig,
	buildLaunchModelStepPrompt,
	buildLaunchModelSummary,
	buildLaunchReview,
	createLaunchSession,
	currentLaunchField,
	currentLaunchModelStep,
	finishLaunchModelEdit,
	getLaunchFieldOptions,
	hasLaunchModelControls,
	type LaunchFieldOptionsById,
	type LaunchModelStep,
	type LaunchModelStepAction,
	type LaunchModelStepResult,
	moveLaunchSessionToValidationField,
	type PendingLaunchSession,
	seedLaunchModelConfigFromPlan,
} from "./launch-session.js";
import {
	escapeTelegramHtml as escapeHtml,
	renderResultMarkdownForTelegram,
	splitPlainTelegramText,
	splitTelegramHtml,
	type TelegramResultPart,
	telegramHtmlToPlainText,
} from "./markdown-html.js";
import { renderMermaidPng } from "./mermaid-image.js";
import {
	buildActionSubmittedMessage,
	buildActionsPromptMessage,
	buildLeafOutcomeMessage,
	buildLifecycleMessage,
	buildProcessCreatedMessage,
	buildStatusMessage,
	buildTurnOutcomeMessage,
	buildTurnStartedMessage,
	formatTurnIdLabel,
} from "./process-feed.js";
import { ProcessThreadStore, threadKey } from "./process-thread-store.js";
import { buildTopicTitle } from "./topic-title.js";
import type {
	TelegramCallbackUpdate,
	TelegramClient,
	TelegramForumTopicClosedUpdate,
	TelegramForumTopicCreatedUpdate,
	TelegramInlineKeyboard,
	TelegramProcessThread,
	TelegramReplyMarkup,
	TelegramTextUpdate,
} from "./types.js";

type TelegramCallbackCommand =
	| { kind: "process_action"; actionId: string; instanceId: string }
	| { kind: "action_form_skip"; fieldId: string; instanceId: string; sessionId: string }
	| { kind: "action_model_select"; instanceId: string; sessionId: string; profileIndex: number }
	| { kind: "action_model_skip"; instanceId: string; sessionId: string }
	| { kind: "retry"; instanceId: string }
	| { kind: "continue"; instanceId: string };

type TelegramLaunchCallbackCommand =
	| { kind: "select_launcher"; sessionKey: string; launcherId: string }
	| { kind: "field_value"; sessionKey: string; fieldId: string; value: unknown }
	| { kind: "skip_field"; sessionKey: string; fieldId: string }
	| { kind: "edit_models"; sessionKey: string }
	| ({ kind: "model_step"; sessionKey: string; stepKey: string } & LaunchModelStepAction)
	| { kind: "finish_model_edit"; sessionKey: string }
	| { kind: "confirm_launch"; sessionKey: string }
	| { kind: "cancel_launch"; sessionKey: string };

interface ChatTarget {
	chatId: string;
	messageThreadId?: number;
}

type TelegramActionExecutionSummary = ProcessActionSummaryLike & {
	preview?: ActionPreviewLike | null;
};

interface StoredLaunchCallbackCommand {
	command: TelegramLaunchCallbackCommand;
	expiresAt: number;
}

interface ResolvedLaunchCallbackCommand {
	token: string;
	command: TelegramLaunchCallbackCommand;
}

const LAUNCH_CALLBACK_PREFIX = "launch:";
const LAUNCH_SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_LAUNCHER_BUTTONS = 30;
const MAX_FIELD_OPTION_BUTTONS = 20;
const MAX_MODEL_PROFILE_BUTTONS = 20;
const CONTINUE_PROMPT =
	"Send an optional continuation instruction, or send /skip to continue with the default prompt.";

function commandName(text: string): string | null {
	return /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(text.trim())?.[1]?.toLowerCase() ?? null;
}

function commandArgs(text: string): string {
	return text
		.trim()
		.replace(/^\/\w+(?:@\w+)?\s*/, "")
		.trim();
}

function rows<T>(items: readonly T[], size: number): T[][] {
	return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => [
		...items.slice(index * size, index * size + size),
	]);
}

function messageTarget(chatId: string, messageThreadId: number | undefined) {
	return { chatId, ...(messageThreadId !== undefined ? { messageThreadId } : {}) };
}

function launchSessionKey(input: {
	chatId: string;
	messageThreadId?: number;
	from: { id: number } | null | undefined;
}): string | null {
	return typeof input.from?.id === "number"
		? `${input.chatId}:${input.messageThreadId ?? 0}:${input.from.id}`
		: null;
}

function splitScopedCallbackPayload(payload: string): { instanceId: string; value: string } | null {
	const separator = payload.indexOf(":");
	if (separator <= 0 || separator === payload.length - 1) return null;
	return {
		instanceId: payload.slice(0, separator),
		value: payload.slice(separator + 1),
	};
}

function parseTripleCallbackPayload(
	payload: string,
): { instanceId: string; sessionId: string; value: string } | null {
	const parts = payload.split(":");
	const [instanceId, sessionId, ...rest] = parts;
	if (!instanceId || !sessionId) return null;
	return { instanceId, sessionId, value: rest.join(":") };
}

function parseActionFormSkipCallbackPayload(
	payload: string,
): Extract<TelegramCallbackCommand, { kind: "action_form_skip" }> | null {
	const parsed = parseTripleCallbackPayload(payload);
	if (!parsed) return null;
	return {
		kind: "action_form_skip",
		instanceId: parsed.instanceId,
		sessionId: parsed.sessionId,
		fieldId: parsed.value,
	};
}

function parseCallbackCommand(data: string): TelegramCallbackCommand | null {
	if (data.startsWith("a:")) {
		const scoped = splitScopedCallbackPayload(data.slice("a:".length));
		return scoped
			? { kind: "process_action", instanceId: scoped.instanceId, actionId: scoped.value }
			: null;
	}
	if (data.startsWith("fs:")) {
		return parseActionFormSkipCallbackPayload(data.slice("fs:".length));
	}
	if (data.startsWith("ams:")) {
		return parseActionModelSelectCallbackPayload(data.slice("ams:".length));
	}
	if (data.startsWith("amk:")) {
		return parseActionModelSkipCallbackPayload(data.slice("amk:".length));
	}
	if (data.startsWith("r:")) {
		const instanceId = data.slice("r:".length);
		return instanceId ? { kind: "retry", instanceId } : null;
	}
	if (data.startsWith("c:")) {
		const instanceId = data.slice("c:".length);
		return instanceId ? { kind: "continue", instanceId } : null;
	}
	return null;
}

function parseActionModelSelectCallbackPayload(
	payload: string,
): Extract<TelegramCallbackCommand, { kind: "action_model_select" }> | null {
	const parsed = parseTripleCallbackPayload(payload);
	if (!parsed) return null;
	const profileIndex = Number(parsed.value);
	if (!Number.isInteger(profileIndex) || profileIndex < 1) return null;
	return {
		kind: "action_model_select",
		instanceId: parsed.instanceId,
		sessionId: parsed.sessionId,
		profileIndex,
	};
}

function parseActionModelSkipCallbackPayload(
	payload: string,
): Extract<TelegramCallbackCommand, { kind: "action_model_skip" }> | null {
	const parsed = parseTripleCallbackPayload(payload);
	if (!parsed) return null;
	return {
		kind: "action_model_skip",
		instanceId: parsed.instanceId,
		sessionId: parsed.sessionId,
	};
}

function resolveProfileByTextOrIndex(
	text: string,
	profiles: readonly ModelProfileOptionSummaryLike[],
): ModelProfileOptionSummaryLike | null {
	const byIdOrLabel = profiles.find(
		(p) => p.id === text || p.label.toLowerCase() === text.toLowerCase(),
	);
	if (byIdOrLabel) return byIdOrLabel;
	const index = Number(text);
	if (Number.isInteger(index) && index >= 1 && index <= profiles.length) {
		return profiles[index - 1] ?? null;
	}
	return null;
}

function resolveModelProfileFromSession(
	session: PendingTelegramSession | undefined,
	profileIndex: number,
): ModelProfileOptionSummaryLike | null {
	const profiles =
		session?.kind === "action_model"
			? session.profiles
			: session?.kind === "recovery_model"
				? session.profiles
				: null;
	if (!profiles) return null;
	return profiles[profileIndex - 1] ?? null;
}

function processCanAcceptFreeText(process: ProcessInstance): boolean {
	return !["completed", "aborted", "error"].includes(process.lifecycleStatus);
}

function processIsFinished(process: ProcessInstance): boolean {
	return process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted";
}

function resultTurnRecordKey(instanceId: string, turnRecordId: string): string {
	return `${instanceId}:${turnRecordId}`;
}

function recoveryActionLabels(process: ProcessInstance): string[] {
	if (process.lifecycleStatus !== "error" || !process.currentExecution) return [];
	return ["Retry", ...(continuableFailedTurnRecordId(process) ? ["Continue"] : [])];
}

function readActionPreview(action: ProcessActionSummaryLike): ActionPreviewLike | null {
	const preview = (action as { preview?: unknown }).preview;
	if (!isRecord(preview)) return null;
	return {
		...(typeof preview.kind === "string" ? { kind: preview.kind } : {}),
		...(typeof preview.turnId === "string" ? { turnId: preview.turnId } : {}),
		...(typeof preview.lifecycleStatus === "string"
			? { lifecycleStatus: preview.lifecycleStatus }
			: {}),
	};
}

function shouldDeferActionPromptUntilTurnTerminalEvent(changedFields: readonly string[]): boolean {
	return changedFields.includes("currentExecution");
}

function shouldDeferCompletedLifecycleUntilTurnOutcome(input: {
	process: ProcessInstance;
	changedFields: readonly string[];
}): boolean {
	return (
		input.process.lifecycleStatus === "completed" &&
		input.changedFields.includes("currentExecution")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClaimedLaunchThread(
	process: ProcessInstance,
	expectedChatId: string,
): Pick<TelegramProcessThread, "mode" | "chatId" | "messageThreadId"> | null {
	const telegram = isRecord(process.metadata?.telegram) ? process.metadata.telegram : null;
	const thread = isRecord(telegram?.launchThread) ? telegram.launchThread : null;
	return thread?.mode === "forum_topic" &&
		thread.chatId === expectedChatId &&
		typeof thread.messageThreadId === "number"
		? { mode: "forum_topic", chatId: thread.chatId, messageThreadId: thread.messageThreadId }
		: null;
}

function createActionFormSessionId(): string {
	return randomBytes(4).toString("hex");
}

function attachLaunchThreadMetadata(
	launchPlan: ProcessLaunchPlan,
	thread: Pick<TelegramProcessThread, "mode" | "chatId" | "messageThreadId">,
): ProcessLaunchPlan {
	const metadata = launchPlan.processInput.metadata ?? {};
	const telegram = isRecord(metadata.telegram) ? metadata.telegram : {};
	return {
		...launchPlan,
		processInput: {
			...launchPlan.processInput,
			metadata: {
				...metadata,
				telegram: {
					...telegram,
					launchThread: { ...thread },
				},
			},
		},
	};
}

export class TelegramBridge {
	private readonly store: ProcessThreadStore;
	private readonly sessions = new Map<string, PendingTelegramSession>();
	private readonly launchSessions = new Map<string, PendingLaunchSession>();
	private readonly launchCallbacks = new Map<string, StoredLaunchCallbackCommand>();
	private nextLaunchCallbackId = 1;
	private readonly processModelSelection: ProcessModelSelectionServiceLike | null;
	private readonly threadEligibleInstanceIds = new Set<string>();
	private readonly introSentInstanceIds = new Set<string>();
	private readonly closedThreadKeys = new Set<string>();
	private readonly sentResultTurnRecordKeys = new Set<string>();
	private readonly deferredCompletedLifecycleProcesses = new Map<string, ProcessInstance>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly lastTurnInfo = new Map<
		string,
		{ pathType: ProcessTurnRecordPathType; turnId: string }
	>();

	constructor(
		private readonly input: {
			config: TelegramExtensionConfig;
			deps: CoreServerSetupDeps;
			client: TelegramClient;
			logger?: ServerExtensionLogger;
		},
	) {
		this.store = new ProcessThreadStore(input.deps);
		this.processModelSelection = input.deps.processModelSelection ?? null;
		input.client.onText((update) => this.handleText(update));
		input.client.onCallback((update) => this.handleCallback(update));
		input.client.onForumTopicCreated((update) => this.handleForumTopicCreated(update));
		input.client.onForumTopicClosed((update) => this.handleForumTopicClosed(update));
	}

	async start(): Promise<void> {
		for (const instanceId of this.store.rebuildFromEvents()) {
			this.threadEligibleInstanceIds.add(instanceId);
			this.introSentInstanceIds.add(instanceId);
		}
		this.seedLastTurnInfoFromEvents();
		await this.input.client.start();
		for (const request of this.input.deps.processQuestions?.listOpen() ?? []) {
			await this.onQuestionRequested({ instanceId: request.instanceId, request });
		}
	}

	/**
	 * After a server restart the in-memory lastTurnInfo map is empty.
	 * Rebuild it from the most recent turn_started event for every non-terminal
	 * process that already has a Telegram thread, so that /status and actions
	 * prompts show the correct path label without waiting for the next turn.
	 */
	private seedLastTurnInfoFromEvents(): void {
		for (const process of this.input.deps.processes.listAll()) {
			if (["completed", "aborted"].includes(process.lifecycleStatus)) continue;
			if (!this.store.getByInstanceId(process.id)) continue;
			if (this.lastTurnInfo.has(process.id)) continue;
			const events = this.input.deps.events.listByInstance(process.id, 50);
			const turnStartedEvent = events.find((e) => e.eventType === "turn_started");
			if (!turnStartedEvent) continue;
			const pathType = turnStartedEvent.data.pathType as ProcessTurnRecordPathType | undefined;
			const turnId = turnStartedEvent.data.turnId as string | undefined;
			if (pathType && turnId) {
				this.lastTurnInfo.set(process.id, { pathType, turnId });
			}
		}
	}

	async stop(): Promise<void> {
		await this.input.client.stop();
	}

	register(events: {
		on<K extends keyof ServerExtensionEventMap & string>(
			event: K,
			handler: (payload: ServerExtensionEventMap[K]) => void | Promise<void>,
		): void;
	}): void {
		const on = <K extends keyof ServerExtensionEventMap & string>(
			event: K,
			handler: (payload: ServerExtensionEventMap[K]) => Promise<void>,
		) =>
			events.on(event, (payload) => void this.enqueue(payload.instanceId, () => handler(payload)));
		on("process_created", (payload) => this.onProcessCreated(payload));
		on("process_updated", (payload) => this.onProcessUpdated(payload));
		on("turn_started", (payload) => this.onTurnStarted(payload.turnRecord));
		on("turn_failed", (payload) => this.onTurnFailed(payload));
		on("leaf_outcome_captured", (payload) => this.onLeafOutcome(payload.snapshot));
		on("question_requested", (payload) => this.onQuestionRequested(payload));
		on("turn_outcome", (payload) => this.onTurnOutcome(payload));
	}

	private enqueue(instanceId: string, task: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(instanceId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(task)
			.catch((error) => this.logError(error, "Telegram bridge task failed"));
		const stored = next.finally(() => {
			if (this.queues.get(instanceId) === stored) this.queues.delete(instanceId);
		});
		this.queues.set(instanceId, stored);
		return stored;
	}

	private async onProcessCreated(
		payload: ServerExtensionEventMap["process_created"],
	): Promise<void> {
		this.threadEligibleInstanceIds.add(payload.process.id);
		const thread = await this.ensureThread(payload.process);
		if (!thread) return;
		await this.sendProcessIntro(thread, payload.process);
		if (processIsFinished(payload.process)) {
			await this.closeThread(thread);
			return;
		}
		if (["waiting", "error"].includes(payload.process.lifecycleStatus)) {
			await this.sendActionsForProcess(payload.process);
		}
	}

	private async onProcessUpdated(
		payload: ServerExtensionEventMap["process_updated"],
	): Promise<void> {
		const thread = await this.getThread(payload.process);
		if (!thread) return;
		if (payload.changedFields.includes("title")) {
			await this.syncThreadTitle(thread, payload.process);
		}
		const deferCompletedLifecycle = shouldDeferCompletedLifecycleUntilTurnOutcome({
			process: payload.process,
			changedFields: payload.changedFields,
		});
		if (deferCompletedLifecycle) {
			this.deferredCompletedLifecycleProcesses.set(payload.process.id, payload.process);
		} else if (payload.changedFields.includes("lifecycleStatus")) {
			this.deferredCompletedLifecycleProcesses.delete(payload.process.id);
			const lifecycleMessage = buildLifecycleMessage({
				process: payload.process,
				status: payload.process.lifecycleStatus,
			});
			if (lifecycleMessage) await this.sendHtml(thread, lifecycleMessage);
			if (processIsFinished(payload.process)) {
				await this.closeThread(thread);
				return;
			}
		}
		if (
			(payload.process.lifecycleStatus === "waiting" ||
				payload.process.lifecycleStatus === "error" ||
				payload.changedFields.includes("selectedTurnId")) &&
			!shouldDeferActionPromptUntilTurnTerminalEvent(payload.changedFields)
		) {
			await this.sendActionsForProcess(payload.process);
		}
	}

	private async onTurnStarted(turnRecord: ProcessTurnRecord): Promise<void> {
		const thread = await this.getThread(turnRecord.instanceId);
		if (!thread) return;
		const modelLabel = this.resolveTurnModelLabel(turnRecord);
		const turnDescription = formatTurnIdLabel(turnRecord.turnId);
		this.lastTurnInfo.set(turnRecord.instanceId, {
			pathType: turnRecord.pathType,
			turnId: turnRecord.turnId,
		});
		await this.sendHtml(
			thread,
			buildTurnStartedMessage(turnRecord, { turnDescription, modelLabel }),
		);
	}

	private async onQuestionRequested(
		payload: ServerExtensionEventMap["question_requested"],
	): Promise<void> {
		const thread = await this.getThread(payload.instanceId);
		if (!thread) return;
		const key = threadKey(thread.chatId, thread.messageThreadId);
		const existing = this.sessions.get(key);
		if (existing?.kind === "question" && existing.request.id === payload.request.id) return;
		const session = buildQuestionSession(payload);
		this.sessions.set(key, session);
		await this.sendCurrentSessionPrompt(thread, session);
	}

	// Resolves the human-readable label for the model currently running in a turn.
	// Intentionally queries unfiltered availableProfiles (not filtered through allowedModelProfileIds)
	// because this describes what IS running, not what the user could have selected.
	private resolveTurnModelLabel(turnRecord: ProcessTurnRecord): string | null {
		if (turnRecord.turnType !== "llm" || !turnRecord.modelProfileId) return null;
		const profile = this.processModelSelection
			?.listAvailableProfiles(turnRecord.instanceId)
			?.find((p) => p.id === turnRecord.modelProfileId);
		return profile?.label ?? turnRecord.modelProfileId;
	}

	private filterProfiles<T extends ModelProfileOptionSummaryLike>(
		profiles: readonly T[],
	): readonly T[] {
		const allowedIds = this.input.config.allowedModelProfileIds;
		if (!allowedIds.length) return profiles;
		const allowed = new Set(allowedIds);
		return profiles.filter((p) => allowed.has(p.id));
	}

	private listSelectableProfiles(instanceId: string): readonly ModelProfileOptionSummaryLike[] {
		if (!this.input.config.actionModelSelection.enabled || !this.processModelSelection) return [];
		return this.filterProfiles(this.processModelSelection.listAvailableProfiles(instanceId) ?? []);
	}

	private filterLaunchSchemaAvailableProfiles(
		schema: LauncherModelConfigSchemaLike | null,
	): LauncherModelConfigSchemaLike | null {
		return schema
			? { ...schema, availableProfiles: this.filterProfiles(schema.availableProfiles) }
			: null;
	}

	private async onTurnFailed(payload: ServerExtensionEventMap["turn_failed"]): Promise<void> {
		const { turnRecord } = payload;
		const thread = await this.getThread(turnRecord.instanceId);
		if (!thread) return;
		const errorSummary = payload.errorSummary.trim() || turnRecord.errorSummary || "Turn failed";
		const errorClass = payload.errorClass ?? turnRecord.errorClass ?? null;
		await this.sendHtml(
			thread,
			[
				`⚠️ <b>Turn failed</b>: ${escapeHtml(turnRecord.turnId)}`,
				`Error: ${escapeHtml(errorSummary)}`,
				...(errorClass ? [`Class: ${escapeHtml(errorClass)}`] : []),
				"",
				"Use the recovery buttons for retry or continue options.",
			].join("\n"),
		);
		const process = this.input.deps.processes.getById(turnRecord.instanceId);
		if (process) await this.sendActionsForProcess(process);
	}

	private async sendPublishedResult(
		thread: TelegramProcessThread,
		input: {
			instanceId: string;
			turnRecordId: string;
			markdown: string;
			buildMessage: (leadingHtml: string) => string;
		},
	): Promise<void> {
		const markdown = input.markdown.trim();
		if (!markdown) return;
		const dedupeKey = resultTurnRecordKey(input.instanceId, input.turnRecordId);
		if (this.sentResultTurnRecordKeys.has(dedupeKey)) return;
		const parts = renderResultMarkdownForTelegram({
			markdown,
			instanceId: input.instanceId,
			turnRecordId: input.turnRecordId,
		});
		const leadingHtml = parts[0]?.kind === "html" ? parts[0] : null;
		await this.sendHtml(thread, input.buildMessage(leadingHtml?.html ?? ""));
		await this.sendResultParts(
			thread,
			input.instanceId,
			input.turnRecordId,
			parts.slice(leadingHtml ? 1 : 0),
		);
		this.sentResultTurnRecordKeys.add(dedupeKey);
	}

	private async onLeafOutcome(snapshot: ProcessLeafOutcomeSnapshot): Promise<void> {
		const thread = await this.getThread(snapshot.instanceId);
		if (!thread) return;
		const markdown = snapshot.fallbackMarkdown?.trim() ?? "";
		if (markdown && snapshot.turnRecordId) {
			await this.sendPublishedResult(thread, {
				instanceId: snapshot.instanceId,
				turnRecordId: snapshot.turnRecordId,
				markdown,
				buildMessage: (markdownHtml) => buildLeafOutcomeMessage({ snapshot, markdownHtml }),
			});
			return;
		}
		await this.sendHtml(thread, buildLeafOutcomeMessage({ snapshot }));
	}

	private async onTurnOutcome(payload: ServerExtensionEventMap["turn_outcome"]): Promise<void> {
		const thread = await this.getThread(payload.instanceId);
		if (!thread) return;
		const pathType = this.lastTurnInfo.get(payload.instanceId)?.pathType ?? null;
		await this.sendPublishedResult(thread, {
			instanceId: payload.instanceId,
			turnRecordId: payload.turnRecordId,
			markdown: payload.turnResultMarkdown ?? "",
			buildMessage: (markdownHtml) =>
				buildTurnOutcomeMessage({
					turnId: payload.turnId,
					outcome: payload.outcome,
					markdown: payload.turnResultMarkdown ?? "",
					markdownHtml,
					pathType,
				}),
		});
		const deferredCompletedProcess = this.deferredCompletedLifecycleProcesses.get(
			payload.instanceId,
		);
		if (deferredCompletedProcess) {
			this.deferredCompletedLifecycleProcesses.delete(payload.instanceId);
			const process =
				this.input.deps.processes.getById(payload.instanceId) ?? deferredCompletedProcess;
			const lifecycleMessage = buildLifecycleMessage({
				process,
				status: process.lifecycleStatus,
			});
			if (lifecycleMessage) await this.sendHtml(thread, lifecycleMessage);
			if (processIsFinished(process)) await this.closeThread(thread);
			return;
		}
		const process = this.input.deps.processes.getById(payload.instanceId);
		if (process && ["waiting", "error"].includes(process.lifecycleStatus)) {
			await this.sendActionsForProcess(process);
		}
	}

	private async ensureThread(process: ProcessInstance): Promise<TelegramProcessThread | null> {
		const existing = this.store.getByInstanceId(process.id);
		if (existing) return existing;
		const topicName = buildTopicTitle({ process, template: this.input.config.topicTitleTemplate });
		const claimedThread = readClaimedLaunchThread(process, this.input.config.delivery.forumChatId);
		if (claimedThread) {
			const thread: TelegramProcessThread = { ...claimedThread, topicName };
			try {
				await this.input.client.editForumTopic({
					chatId: thread.chatId,
					messageThreadId: thread.messageThreadId,
					name: topicName,
				});
			} catch (error) {
				this.logError(error, "Failed to rename claimed Telegram launch topic");
			}
			this.store.record(process, thread);
			return thread;
		}
		try {
			const topic = await this.input.client.createForumTopic({
				chatId: this.input.config.delivery.forumChatId,
				name: topicName,
			});
			const thread: TelegramProcessThread = {
				mode: "forum_topic",
				chatId: this.input.config.delivery.forumChatId,
				messageThreadId: topic.messageThreadId,
				topicName,
			};
			this.store.record(process, thread);
			return thread;
		} catch (error) {
			this.logError(error, "Failed to create Telegram process topic");
			return null;
		}
	}

	private async getThread(input: ProcessInstance | string): Promise<TelegramProcessThread | null> {
		const instanceId = typeof input === "string" ? input : input.id;
		const existing = this.store.getByInstanceId(instanceId);
		if (existing) return existing;
		if (!this.threadEligibleInstanceIds.has(instanceId)) return null;
		const process = typeof input === "string" ? this.input.deps.processes.getById(input) : input;
		if (!process) return null;
		const thread = await this.ensureThread(process);
		if (thread) await this.sendProcessIntro(thread, process);
		return thread;
	}

	private async sendProcessIntro(
		thread: TelegramProcessThread,
		process: ProcessInstance,
	): Promise<void> {
		if (this.introSentInstanceIds.has(process.id)) return;
		await this.sendHtml(
			thread,
			buildProcessCreatedMessage({ process, serverBaseUrl: this.input.deps.serverBaseUrl }),
		);
		this.introSentInstanceIds.add(process.id);
	}

	private async closeThread(thread: TelegramProcessThread): Promise<void> {
		if (this.closedThreadKeys.has(threadKey(thread.chatId, thread.messageThreadId))) return;
		try {
			await this.input.client.closeForumTopic({
				chatId: thread.chatId,
				messageThreadId: thread.messageThreadId,
			});
		} catch (error) {
			this.logError(error, "Failed to close Telegram process topic");
		}
	}

	private async syncThreadTitle(
		thread: TelegramProcessThread,
		process: ProcessInstance,
	): Promise<void> {
		const topicName = buildTopicTitle({ process, template: this.input.config.topicTitleTemplate });
		if (topicName === thread.topicName) return;
		try {
			await this.input.client.editForumTopic({
				chatId: thread.chatId,
				messageThreadId: thread.messageThreadId,
				name: topicName,
			});
			this.store.record(process, { ...thread, topicName });
		} catch (error) {
			this.logError(error, "Failed to rename Telegram process topic");
		}
	}

	private async sendActionsForProcess(
		process: ProcessInstance,
		options: { explicit?: boolean } = {},
	): Promise<void> {
		const thread = this.store.getByInstanceId(process.id);
		if (!thread) return;
		const actions =
			process.lifecycleStatus === "waiting"
				? this.input.deps.processActions.listVisibleActions(process.id)
				: [];
		const isRecoveryOrHumanWait = ["waiting", "error"].includes(process.lifecycleStatus);
		if (!options.explicit && !isRecoveryOrHumanWait && actions.length === 0) return;
		const keyboard = buildActionKeyboard({
			process,
			actions,
		});
		if (!keyboard) {
			if (options.explicit)
				await this.sendHtml(thread, "No actions are available for this process.");
			return;
		}
		const turnInfo = this.lastTurnInfo.get(process.id);
		await this.sendHtml(
			thread,
			buildActionsPromptMessage({
				process,
				actions,
				recoveryActions: recoveryActionLabels(process),
				currentTurnDescription: turnInfo ? formatTurnIdLabel(turnInfo.turnId) : null,
				currentTurnPathType: turnInfo?.pathType ?? null,
			}),
			keyboard,
		);
	}

	private async handleForumTopicCreated(update: TelegramForumTopicCreatedUpdate): Promise<void> {
		if (!this.isAllowed(update.from)) return;
		if (update.chatId !== this.input.config.delivery.forumChatId) return;
		if (this.store.getInstanceIdForThread(update.chatId, update.messageThreadId)) return;
		await this.sendUnmappedTopicHelp(update.chatId, update.messageThreadId);
	}

	private async handleForumTopicClosed(update: TelegramForumTopicClosedUpdate): Promise<void> {
		if (update.chatId !== this.input.config.delivery.forumChatId) return;
		const instanceId = this.store.getInstanceIdForThread(update.chatId, update.messageThreadId);
		if (!instanceId) return;
		this.closedThreadKeys.add(threadKey(update.chatId, update.messageThreadId));
		await this.enqueue(instanceId, () => this.abortProcessForClosedTopic(instanceId));
	}

	private async abortProcessForClosedTopic(instanceId: string): Promise<void> {
		const process = this.input.deps.processes.getById(instanceId);
		if (!process || processIsFinished(process)) return;
		const result = await this.input.deps.commands.abortProcess(instanceId, {
			actor: TELEGRAM_ACTOR,
		});
		if (!result.ok) {
			this.logError(
				result.message ?? result.code ?? "Abort failed",
				"Failed to abort closed Telegram topic",
			);
		}
	}

	private async handleText(update: TelegramTextUpdate): Promise<void> {
		if (!this.isAllowed(update.from)) return;
		const name = commandName(update.text);
		const instanceId = this.store.getInstanceIdForThread(update.chatId, update.messageThreadId);
		if (!instanceId) {
			await this.handleUnmappedTopicText(update, name);
			return;
		}
		await this.enqueue(instanceId, () => this.handleProcessText(instanceId, update, name));
	}

	private async handleUnmappedTopicText(
		update: TelegramTextUpdate,
		name: string | null,
	): Promise<void> {
		const key = launchSessionKey(update);
		if (!key) return;
		const inConfiguredForum = update.chatId === this.input.config.delivery.forumChatId;
		if (!inConfiguredForum) {
			if (name === "help") {
				await this.sendPlainToChat(
					update.chatId,
					update.messageThreadId,
					"This bot is operated from the configured process forum chat.",
				);
			}
			return;
		}
		if (name === "cancel") {
			this.launchSessions.delete(key);
			await this.sendHtmlToChat(update.chatId, update.messageThreadId, "Cancelled.");
			return;
		}
		if (name === "help") {
			await this.sendUnmappedTopicHelp(update.chatId, update.messageThreadId);
			return;
		}
		if (name === "launchers") {
			await this.sendLauncherList(update, key, { includeButtons: false });
			return;
		}
		if (name === "launch") {
			if (update.messageThreadId === undefined) {
				await this.sendHtmlToChat(
					update.chatId,
					update.messageThreadId,
					"Create a new forum topic first, then send /launch in that topic.",
				);
				return;
			}
			const launcherId = commandArgs(update.text);
			if (launcherId) {
				await this.startLaunchSession(update, key, launcherId);
				return;
			}
			await this.sendLauncherList(update, key, { includeButtons: true });
			return;
		}

		const session = this.launchSessions.get(key);
		if (session) {
			await this.handleLaunchSessionText(key, session, update, name);
			return;
		}
		if (name) {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"Unknown command. Use /help for available commands.",
			);
		}
	}

	private async handleProcessText(
		instanceId: string,
		update: TelegramTextUpdate,
		name: string | null,
	): Promise<void> {
		const thread = this.store.getByInstanceId(instanceId);
		if (!thread) return;
		const key = threadKey(update.chatId, update.messageThreadId);
		if (name === "cancel") {
			if (this.sessions.get(key)?.kind === "question") {
				await this.sendHtml(
					thread,
					"The active turn is still waiting for this answer. Answer here, use the Web UI, or stop the turn.",
				);
				return;
			}
			this.sessions.delete(key);
			await this.sendHtml(thread, "Cancelled.");
			return;
		}
		if (name === "actions") {
			const process = this.input.deps.processes.getById(instanceId);
			if (process) await this.sendActionsForProcess(process, { explicit: true });
			return;
		}
		if (name === "status") {
			const process = this.input.deps.processes.getById(instanceId);
			if (process) {
				const actions =
					process.lifecycleStatus === "waiting"
						? this.input.deps.processActions.listVisibleActions(process.id)
						: [];
				const turnInfo = this.lastTurnInfo.get(instanceId);
				await this.sendHtml(
					thread,
					buildStatusMessage({
						process,
						actions,
						currentTurnDescription: turnInfo ? formatTurnIdLabel(turnInfo.turnId) : null,
						currentTurnPathType: turnInfo?.pathType ?? null,
					}),
				);
			}
			return;
		}
		if (name === "help") {
			await this.sendHtml(
				thread,
				"Use /actions for current actions, /status for status, /skip to skip optional prompts, /cancel to cancel a pending prompt. Close this topic to abort the process. To launch a new process, create a new topic and send /launch there.",
			);
			return;
		}
		if (name === "launch") {
			await this.sendHtml(
				thread,
				"This topic is already linked to a process. Create a new forum topic and send /launch there to start another process.",
			);
			return;
		}

		const session = this.sessions.get(key);
		if (session) {
			await this.handleSessionText(key, session, update.text, thread, name);
			return;
		}
		if (name) {
			await this.sendHtml(thread, "Unknown command. Use /help for available commands.");
			return;
		}

		const process = this.input.deps.processes.getById(instanceId);
		if (!process) return;
		if (!processCanAcceptFreeText(process)) {
			await this.sendHtml(
				thread,
				"This process is not accepting free-text input right now. Use /actions for available options.",
			);
			return;
		}
		const result = await this.input.deps.commands.queueInputs(
			instanceId,
			[{ source: "external_comment", kind: "instruction", bodyMarkdown: update.text }],
			{
				dispatchErrorMessage: "Failed to deliver the Telegram input to the worker",
				actor: TELEGRAM_ACTOR,
			},
		);
		await this.sendCommandResult(thread, result, "💬 Sent to process.", "Failed to send input");
	}

	private async handleCallback(update: TelegramCallbackUpdate): Promise<void> {
		if (!this.isAllowed(update.from)) {
			await this.answerCallback(update.id, "Not allowed", true);
			return;
		}
		const launchCallback = this.readLaunchCallbackCommand(update.data);
		if (launchCallback) {
			const key = launchSessionKey(update);
			if (!key || key !== launchCallback.command.sessionKey) {
				await this.answerCallback(
					update.id,
					"This launch button belongs to another session.",
					true,
				);
				return;
			}
			this.launchCallbacks.delete(launchCallback.token);
			await this.answerCallback(update.id);
			await this.executeLaunchCallbackCommand(key, update, launchCallback.command);
			return;
		}
		if (update.data.startsWith(LAUNCH_CALLBACK_PREFIX)) {
			await this.answerCallback(
				update.id,
				"This launch button expired. Send /launch to start again.",
				true,
			);
			return;
		}
		const command = parseCallbackCommand(update.data);
		if (!command) {
			await this.answerCallback(update.id, "Unknown button. Send /actions to refresh.", true);
			return;
		}
		const resolved = this.resolveCallbackInstance(update, command);
		if (!resolved.ok) {
			await this.answerCallback(update.id, resolved.message, true);
			return;
		}
		await this.answerCallback(update.id);
		await this.enqueue(resolved.instanceId, () =>
			this.executeCallbackCommand(resolved.instanceId, command),
		);
	}

	private resolveCallbackInstance(
		update: TelegramCallbackUpdate,
		command: TelegramCallbackCommand,
	): { ok: true; instanceId: string } | { ok: false; message: string } {
		const threadInstanceId = this.store.getInstanceIdForThread(
			update.chatId,
			update.messageThreadId,
		);
		if (!threadInstanceId) {
			return { ok: false, message: "This button is not in a process topic." };
		}
		if (command.instanceId !== threadInstanceId) {
			return { ok: false, message: "This button belongs to another process topic." };
		}
		return { ok: true, instanceId: threadInstanceId };
	}

	private async answerCallback(id: string, text?: string, showAlert?: boolean): Promise<void> {
		await this.input.client.answerCallbackQuery({
			callbackQueryId: id,
			...(text ? { text } : {}),
			...(showAlert !== undefined ? { showAlert } : {}),
		});
	}

	private getLauncher(launcherId: string): UiLauncherSummary | null {
		return (
			this.input.deps.launcherService
				.listUiLaunchers()
				.find((launcher) => launcher.id === launcherId) ?? null
		);
	}

	private async sendUnmappedTopicHelp(
		chatId: string,
		messageThreadId: number | undefined,
	): Promise<void> {
		await this.sendHtmlToChat(
			chatId,
			messageThreadId,
			[
				"This topic can become a new leitwerk process.",
				"Send /launch to choose a process launcher, then answer the prompts here.",
				"Required fields are asked first; optional fields come after and can be skipped with /skip.",
				"Use /launchers to list launcher ids, or /cancel to discard a pending launch draft.",
			].join("\n"),
		);
	}

	private async sendLauncherList(
		update: TelegramTextUpdate,
		sessionKey: string,
		options: { includeButtons: boolean },
	): Promise<void> {
		const launchers = this.input.deps.launcherService.listUiLaunchers();
		if (launchers.length === 0) {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"No launchers are available.",
			);
			return;
		}
		const lines = ["Available launchers:", ""];
		for (const launcher of launchers) {
			const description = launcher.description.trim();
			lines.push(
				description
					? `- ${launcher.label} (${launcher.id}) — ${description}`
					: `- ${launcher.label} (${launcher.id})`,
			);
		}
		if (launchers.length > MAX_LAUNCHER_BUTTONS && options.includeButtons) {
			lines.push(
				"",
				`Showing buttons for the first ${MAX_LAUNCHER_BUTTONS}. Use /launch <launcherId> for others.`,
			);
		}
		await this.sendHtmlToChat(
			update.chatId,
			update.messageThreadId,
			escapeHtml(lines.join("\n")),
			options.includeButtons ? this.buildLauncherListKeyboard(launchers, sessionKey) : undefined,
		);
	}

	private async startLaunchSession(
		update: TelegramTextUpdate | TelegramCallbackUpdate,
		sessionKey: string,
		launcherId: string,
	): Promise<void> {
		if (update.chatId !== this.input.config.delivery.forumChatId) {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"Launches are only available from the configured process forum chat.",
			);
			return;
		}
		if (update.messageThreadId === undefined) {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"Create a new forum topic first, then send /launch in that topic.",
			);
			return;
		}
		const launcher = this.getLauncher(launcherId);
		if (!launcher) {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				`Unknown launcher: ${escapeHtml(launcherId)}`,
			);
			return;
		}
		let defaults: Record<string, unknown>;
		try {
			defaults = await this.input.deps.launcherService.resolveUiDefaults(launcher.id);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launcher defaults");
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"Couldn't load launcher defaults. Try /launch again later.",
			);
			return;
		}
		const session = createLaunchSession({
			launcher,
			defaults,
			ttlMs: LAUNCH_SESSION_TTL_MS,
		});
		this.launchSessions.set(sessionKey, session);
		await this.sendHtmlToChat(
			update.chatId,
			update.messageThreadId,
			`Starting launcher: ${escapeHtml(launcher.label)}. I’ll ask required fields first, then optional fields. Use /skip for optional/defaulted fields and /cancel to discard this draft.`,
		);
		await this.sendNextLaunchPrompt(sessionKey, session, update);
	}

	private async handleLaunchSessionText(
		sessionKey: string,
		session: PendingLaunchSession,
		update: TelegramTextUpdate,
		name: string | null,
	): Promise<void> {
		if (session.expiresAt < Date.now()) {
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"This launch draft expired. Send /launch to start again.",
			);
			return;
		}
		if (name && name !== "skip") {
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"Finish this launch prompt, or send /cancel to discard it.",
			);
			return;
		}
		const launcher = this.getLauncher(session.launcherId);
		if (!launcher) {
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				update.chatId,
				update.messageThreadId,
				"This launcher is no longer available. Send /launch to choose another.",
			);
			return;
		}
		if (session.modelEdit) {
			await this.handleLaunchModelText(sessionKey, session, update);
			return;
		}
		const optionsById = await this.resolveLaunchOptions(session);
		const step = applyLaunchFieldText(session, launcher, update.text, optionsById);
		if (!step.ok) {
			await this.sendHtmlToChat(update.chatId, update.messageThreadId, escapeHtml(step.prompt));
			return;
		}
		if (step.done) {
			await this.sendLaunchReview(sessionKey, session, launcher, update);
			return;
		}
		await this.sendNextLaunchPrompt(sessionKey, session, update);
	}

	private async executeLaunchCallbackCommand(
		sessionKey: string,
		update: TelegramCallbackUpdate,
		command: TelegramLaunchCallbackCommand,
	): Promise<void> {
		switch (command.kind) {
			case "select_launcher":
				await this.startLaunchSession(update, sessionKey, command.launcherId);
				return;
			case "cancel_launch":
				this.launchSessions.delete(sessionKey);
				await this.sendHtmlToChat(update.chatId, update.messageThreadId, "Cancelled.");
				return;
			case "edit_models":
				await this.startLaunchModelEdit(sessionKey, update);
				return;
			case "model_step":
				await this.executeLaunchModelCallbackCommand(sessionKey, update, command);
				return;
			case "finish_model_edit":
				await this.finishLaunchModelEdit(sessionKey, update);
				return;
			case "confirm_launch": {
				const session = await this.getActiveLaunchSession(sessionKey, update);
				if (!session) return;
				if (session.modelEdit) {
					await this.sendHtmlToChat(
						update.chatId,
						update.messageThreadId,
						"Finish model setup before starting this process.",
					);
					await this.sendNextLaunchModelPrompt(sessionKey, session, update);
					return;
				}
				await this.executeLaunchSession(sessionKey, session, update);
				return;
			}
			case "field_value":
			case "skip_field": {
				const context = await this.getLaunchContext(sessionKey, update);
				if (!context) return;
				const { session, launcher } = context;
				const field = currentLaunchField(session, launcher);
				if (!field || field.id !== command.fieldId) {
					await this.sendHtmlToChat(
						update.chatId,
						update.messageThreadId,
						"That launch button is stale. Continue with the latest prompt or send /cancel.",
					);
					return;
				}
				const optionsById = await this.resolveLaunchOptions(session);
				const step =
					command.kind === "skip_field"
						? applyLaunchFieldText(session, launcher, "/skip", optionsById)
						: applyLaunchFieldValue(session, launcher, command.value, optionsById);
				if (!step.ok) {
					await this.sendHtmlToChat(update.chatId, update.messageThreadId, escapeHtml(step.prompt));
					return;
				}
				if (step.done) {
					await this.sendLaunchReview(sessionKey, session, launcher, update);
					return;
				}
				await this.sendNextLaunchPrompt(sessionKey, session, update);
				return;
			}
		}
	}

	private async getLaunchModelSchema(
		session: PendingLaunchSession,
	): Promise<LauncherModelConfigSchemaLike | null> {
		try {
			const schema = await this.input.deps.launcherModelConfigs.getSchema(session.launcherId);
			return this.filterLaunchSchemaAvailableProfiles(schema);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launcher model schema");
			return null;
		}
	}

	private async getLaunchModelPreview(
		session: PendingLaunchSession,
	): Promise<LauncherModelConfigPreviewLike | null> {
		try {
			return await this.input.deps.launcherModelConfigs.preview(
				session.launcherId,
				buildLaunchInput(session),
				{ modelConfig: buildLaunchModelConfig(session) },
			);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launcher model preview");
			return null;
		}
	}

	private async getActiveLaunchSession(
		sessionKey: string,
		target: ChatTarget,
	): Promise<PendingLaunchSession | null> {
		const session = this.launchSessions.get(sessionKey);
		if (session && session.expiresAt >= Date.now()) return session;
		if (session) this.launchSessions.delete(sessionKey);
		await this.sendHtmlToChat(
			target.chatId,
			target.messageThreadId,
			"This launch draft expired. Send /launch to start again.",
		);
		return null;
	}

	private async getLaunchContext(
		sessionKey: string,
		target: ChatTarget,
	): Promise<{ session: PendingLaunchSession; launcher: UiLauncherSummary } | null> {
		const session = await this.getActiveLaunchSession(sessionKey, target);
		if (!session) return null;
		const launcher = this.getLauncher(session.launcherId);
		if (launcher) return { session, launcher };
		this.launchSessions.delete(sessionKey);
		await this.sendHtmlToChat(
			target.chatId,
			target.messageThreadId,
			"This launcher is no longer available. Send /launch to choose another.",
		);
		return null;
	}

	private async sendLaunchReviewForSession(
		sessionKey: string,
		session: PendingLaunchSession,
		target: ChatTarget,
	): Promise<void> {
		const launcher = this.getLauncher(session.launcherId);
		if (!launcher) {
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				target.chatId,
				target.messageThreadId,
				"This launcher is no longer available. Send /launch to choose another.",
			);
			return;
		}
		await this.sendLaunchReview(sessionKey, session, launcher, target);
	}

	private async finishLaunchModelEditAndReview(
		sessionKey: string,
		session: PendingLaunchSession,
		target: ChatTarget,
	): Promise<void> {
		finishLaunchModelEdit(session);
		await this.sendLaunchReviewForSession(sessionKey, session, target);
	}

	private async startLaunchModelEdit(sessionKey: string, target: ChatTarget): Promise<void> {
		const session = await this.getActiveLaunchSession(sessionKey, target);
		if (!session) return;
		const schema = await this.getLaunchModelSchema(session);
		if (!hasLaunchModelControls(schema)) {
			await this.sendHtmlToChat(
				target.chatId,
				target.messageThreadId,
				"This launcher has no editable model setup.",
			);
			return;
		}
		beginLaunchModelEdit(session, schema);
		await this.sendNextLaunchModelPrompt(sessionKey, session, target);
	}

	private async executeLaunchModelCallbackCommand(
		sessionKey: string,
		target: ChatTarget,
		command: Extract<TelegramLaunchCallbackCommand, { kind: "model_step" }>,
	): Promise<void> {
		const session = await this.getActiveLaunchSession(sessionKey, target);
		if (!session) return;
		const schema = await this.getLaunchModelSchema(session);
		if (!hasLaunchModelControls(schema)) {
			await this.finishLaunchModelEditAndReview(sessionKey, session, target);
			return;
		}
		const step = currentLaunchModelStep(session, schema);
		if (!step || step.key !== command.stepKey) {
			await this.sendHtmlToChat(
				target.chatId,
				target.messageThreadId,
				"That model button is stale. Continue with the latest prompt or send /cancel.",
			);
			await this.sendNextLaunchModelPrompt(sessionKey, session, target);
			return;
		}
		const action: LaunchModelStepAction =
			command.action === "set"
				? { action: "set", value: command.value }
				: command.action === "inherit"
					? { action: "inherit" }
					: { action: "skip" };
		await this.continueAfterLaunchModelResult(
			sessionKey,
			session,
			schema,
			applyLaunchModelStepAction(session, schema, action),
			target,
		);
	}

	private async finishLaunchModelEdit(sessionKey: string, target: ChatTarget): Promise<void> {
		const session = await this.getActiveLaunchSession(sessionKey, target);
		if (session) await this.finishLaunchModelEditAndReview(sessionKey, session, target);
	}

	private async handleLaunchModelText(
		sessionKey: string,
		session: PendingLaunchSession,
		update: TelegramTextUpdate,
	): Promise<void> {
		const schema = await this.getLaunchModelSchema(session);
		if (!hasLaunchModelControls(schema)) {
			await this.finishLaunchModelEditAndReview(sessionKey, session, update);
			return;
		}
		await this.continueAfterLaunchModelResult(
			sessionKey,
			session,
			schema,
			applyLaunchModelStepText(session, schema, update.text),
			update,
		);
	}

	private async continueAfterLaunchModelResult(
		sessionKey: string,
		session: PendingLaunchSession,
		schema: LauncherModelConfigSchemaLike,
		result: LaunchModelStepResult,
		target: ChatTarget,
	): Promise<void> {
		if (!result.ok) {
			const step = currentLaunchModelStep(session, schema);
			await this.sendHtmlToChat(
				target.chatId,
				target.messageThreadId,
				escapeHtml(result.prompt),
				step ? this.buildLaunchModelReplyMarkup({ sessionKey, step, schema }) : undefined,
			);
			return;
		}
		if (result.done) {
			await this.sendLaunchReviewForSession(sessionKey, session, target);
			return;
		}
		await this.sendNextLaunchModelPrompt(sessionKey, session, target);
	}

	private resolveLaunchRecentValues(
		session: PendingLaunchSession,
	): Record<string, readonly string[]> {
		try {
			return this.input.deps.launcherRecentValues.list(session.launcherId);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launcher recent values");
			return {};
		}
	}

	private recordLaunchRecentValuesBestEffort(session: PendingLaunchSession): void {
		try {
			this.input.deps.launcherRecentValues.record(session.launcherId, buildLaunchInput(session));
		} catch (error) {
			this.logError(error, "Failed to record Telegram launcher recent values");
		}
	}

	private async resolveLaunchOptions(
		session: PendingLaunchSession,
	): Promise<LaunchFieldOptionsById> {
		const launcher = this.getLauncher(session.launcherId);
		if (!launcher?.launchConfigSchema.fields.some((field) => field.kind === "select")) {
			return {};
		}
		try {
			return await this.input.deps.launcherService.resolveUiOptions(
				session.launcherId,
				buildLaunchInput(session),
			);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launch field options");
			return {};
		}
	}

	private async sendNextLaunchModelPrompt(
		sessionKey: string,
		session: PendingLaunchSession,
		target: ChatTarget,
	): Promise<void> {
		const schema = await this.getLaunchModelSchema(session);
		if (!hasLaunchModelControls(schema)) {
			await this.finishLaunchModelEditAndReview(sessionKey, session, target);
			return;
		}
		const step = currentLaunchModelStep(session, schema);
		if (!step) {
			await this.sendLaunchReviewForSession(sessionKey, session, target);
			return;
		}
		const preview = await this.getLaunchModelPreview(session);
		const prompt = buildLaunchModelStepPrompt({ step, schema, session, preview });
		await this.sendHtmlToChat(
			target.chatId,
			target.messageThreadId,
			escapeHtml(prompt),
			this.buildLaunchModelReplyMarkup({ sessionKey, step, schema }),
		);
	}

	private async sendNextLaunchPrompt(
		sessionKey: string,
		session: PendingLaunchSession,
		target: ChatTarget,
	): Promise<void> {
		if (session.modelEdit) {
			await this.sendNextLaunchModelPrompt(sessionKey, session, target);
			return;
		}
		const launcher = this.getLauncher(session.launcherId);
		if (!launcher) return;
		const field = currentLaunchField(session, launcher);
		if (!field) {
			await this.sendLaunchReview(sessionKey, session, launcher, target);
			return;
		}
		const optionsById = await this.resolveLaunchOptions(session);
		const recentValuesById = this.resolveLaunchRecentValues(session);
		const fieldOptions = getLaunchFieldOptions(field, optionsById);
		const fieldRecentValues = recentValuesById[field.id] ?? [];
		const prompt = buildLaunchFieldPrompt({
			field,
			currentValue: session.values[field.id],
			options: fieldOptions,
			recentValues: fieldRecentValues,
		});
		await this.sendHtmlToChat(
			target.chatId,
			target.messageThreadId,
			escapeHtml(prompt),
			this.buildLaunchFieldReplyMarkup({
				sessionKey,
				fieldId: field.id,
				fieldKind: field.kind,
				currentValue: session.values[field.id],
				options: fieldOptions,
				recentValues: fieldRecentValues,
				required: field.required,
			}),
		);
	}

	private async sendLaunchReview(
		sessionKey: string,
		session: PendingLaunchSession,
		launcher: UiLauncherSummary,
		target: ChatTarget,
	): Promise<void> {
		const prepared = await this.prepareLaunchSession(session, launcher);
		if (!prepared.ok) {
			await this.sendHtmlToChat(
				target.chatId,
				target.messageThreadId,
				escapeHtml(prepared.message),
			);
			if (prepared.reprompt) await this.sendNextLaunchPrompt(sessionKey, session, target);
			return;
		}
		const schema = await this.getLaunchModelSchema(session);
		const modelSummary = hasLaunchModelControls(schema)
			? buildLaunchModelSummary({
					schema,
					session,
					preview: await this.getLaunchModelPreview(session),
				})
			: null;
		await this.sendHtmlToChat(
			target.chatId,
			target.messageThreadId,
			escapeHtml(
				[
					buildLaunchReview({ launcher, session }),
					...(modelSummary ? ["", modelSummary] : []),
				].join("\n"),
			),
			this.buildLaunchConfirmationKeyboard(sessionKey, Boolean(modelSummary)),
		);
	}

	private async prepareLaunchSession(
		session: PendingLaunchSession,
		launcher: UiLauncherSummary,
	): Promise<
		{ ok: true; launchPlan: ProcessLaunchPlan } | { ok: false; message: string; reprompt: boolean }
	> {
		let resolved: Awaited<ReturnType<CoreServerSetupDeps["launcherService"]["resolveUiLauncher"]>>;
		try {
			resolved = await this.input.deps.launcherService.resolveUiLauncher(
				launcher.id,
				buildLaunchInput(session),
			);
		} catch (error) {
			this.logError(error, "Failed to resolve Telegram launcher input");
			return {
				ok: false,
				message: "Couldn't validate launcher input. Try again or send /cancel.",
				reprompt: false,
			};
		}
		if (!resolved.ok) {
			const field = moveLaunchSessionToValidationField(session, launcher, resolved.errors);
			return {
				ok: false,
				message:
					resolved.errors.map((error) => error.message).join("\n") || "Launcher input is invalid.",
				reprompt: Boolean(field),
			};
		}
		let prepared: Awaited<ReturnType<CoreServerSetupDeps["launchPlans"]["prepare"]>>;
		try {
			prepared = await this.input.deps.launchPlans.prepare(resolved.launcher.launchPlan, {
				...(session.modelConfigTouched
					? { modelConfig: buildLaunchModelConfig(session), replaceModelConfig: true }
					: {}),
			});
		} catch (error) {
			this.logError(error, "Failed to prepare Telegram launch plan");
			return {
				ok: false,
				message: "Couldn't prepare this launch. Try again or send /cancel.",
				reprompt: false,
			};
		}
		if (!prepared.ok) {
			return {
				ok: false,
				message:
					prepared.errors.map((error) => error.message).join("\n") ||
					"Launch configuration is invalid.",
				reprompt: false,
			};
		}
		seedLaunchModelConfigFromPlan(session, prepared.launchPlan);
		return { ok: true, launchPlan: prepared.launchPlan };
	}

	private async executeLaunchSession(
		sessionKey: string,
		session: PendingLaunchSession,
		target: ChatTarget,
	): Promise<void> {
		const { chatId, messageThreadId } = target;
		const launcher = this.getLauncher(session.launcherId);
		if (!launcher) {
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				chatId,
				messageThreadId,
				"This launcher is no longer available. Send /launch to choose another.",
			);
			return;
		}
		const prepared = await this.prepareLaunchSession(session, launcher);
		if (!prepared.ok) {
			await this.sendHtmlToChat(chatId, messageThreadId, escapeHtml(prepared.message));
			if (prepared.reprompt) await this.sendNextLaunchPrompt(sessionKey, session, target);
			return;
		}
		if (messageThreadId === undefined) {
			await this.sendHtmlToChat(
				chatId,
				messageThreadId,
				"Create a new forum topic first, then send /launch in that topic.",
			);
			return;
		}
		const launchPlan = attachLaunchThreadMetadata(prepared.launchPlan, {
			mode: "forum_topic",
			chatId,
			messageThreadId,
		});
		let result: Awaited<
			ReturnType<CoreServerSetupDeps["processLaunches"]["createProcessFromLaunchPlan"]>
		>;
		try {
			result = await this.input.deps.processLaunches.createProcessFromLaunchPlan(launchPlan, {
				actor: TELEGRAM_ACTOR,
			});
		} catch (error) {
			this.logError(error, "Failed to create Telegram-launched process");
			await this.sendHtmlToChat(
				chatId,
				messageThreadId,
				"Couldn't create this process. Try again or send /cancel.",
			);
			return;
		}
		if (result.ok) {
			this.recordLaunchRecentValuesBestEffort(session);
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				chatId,
				messageThreadId,
				`✅ Process launched. Web UI: ${escapeHtml(`${this.input.deps.serverBaseUrl.replace(/\/$/, "")}/processes/${result.process.id}`)}`,
			);
			return;
		}
		const process = "process" in result ? result.process : null;
		if (process) {
			this.recordLaunchRecentValuesBestEffort(session);
			this.launchSessions.delete(sessionKey);
			await this.sendHtmlToChat(
				chatId,
				messageThreadId,
				`⚠️ Process was created but launch had a follow-up problem. Web UI: ${escapeHtml(`${this.input.deps.serverBaseUrl.replace(/\/$/, "")}/processes/${process.id}`)}`,
			);
			return;
		}
		await this.sendHtmlToChat(
			chatId,
			messageThreadId,
			`⚠️ ${escapeHtml(String(result.body.error ?? "Launch failed"))}`,
		);
	}

	private createLaunchCallbackCommand(command: TelegramLaunchCallbackCommand): string {
		const token = `${Date.now().toString(36)}_${(this.nextLaunchCallbackId++).toString(36)}`;
		this.launchCallbacks.set(token, {
			command,
			expiresAt: Date.now() + LAUNCH_SESSION_TTL_MS,
		});
		return `${LAUNCH_CALLBACK_PREFIX}${token}`;
	}

	private readLaunchCallbackCommand(data: string): ResolvedLaunchCallbackCommand | null {
		if (!data.startsWith(LAUNCH_CALLBACK_PREFIX)) return null;
		const token = data.slice(LAUNCH_CALLBACK_PREFIX.length);
		const stored = this.launchCallbacks.get(token);
		if (!stored) return null;
		if (stored.expiresAt < Date.now()) {
			this.launchCallbacks.delete(token);
			return null;
		}
		return { token, command: stored.command };
	}

	private buildLauncherListKeyboard(
		launchers: readonly UiLauncherSummary[],
		sessionKey: string,
	): TelegramInlineKeyboard | undefined {
		const buttons = launchers.slice(0, MAX_LAUNCHER_BUTTONS).map((launcher) => ({
			text: launcher.label,
			callbackData: this.createLaunchCallbackCommand({
				kind: "select_launcher",
				sessionKey,
				launcherId: launcher.id,
			}),
		}));
		return buttons.length ? { inlineKeyboard: rows(buttons, 1) } : undefined;
	}

	private buildLaunchConfirmationKeyboard(
		sessionKey: string,
		includeModelControls: boolean,
	): TelegramInlineKeyboard {
		return {
			inlineKeyboard: [
				[
					{
						text: "Start process",
						callbackData: this.createLaunchCallbackCommand({
							kind: "confirm_launch",
							sessionKey,
						}),
					},
					{
						text: "Cancel",
						callbackData: this.createLaunchCallbackCommand({
							kind: "cancel_launch",
							sessionKey,
						}),
					},
				],
				...(includeModelControls
					? [
							[
								{
									text: "Change models",
									callbackData: this.createLaunchCallbackCommand({
										kind: "edit_models",
										sessionKey,
									}),
								},
							],
						]
					: []),
			],
		};
	}

	private buildLaunchModelReplyMarkup(input: {
		sessionKey: string;
		step: LaunchModelStep;
		schema: LauncherModelConfigSchemaLike;
	}): TelegramInlineKeyboard {
		const buttons: Array<{ text: string; callbackData: string }> = [];
		for (const profile of input.schema.availableProfiles.slice(0, MAX_MODEL_PROFILE_BUTTONS)) {
			buttons.push({
				text: profile.id,
				callbackData: this.createLaunchCallbackCommand({
					kind: "model_step",
					sessionKey: input.sessionKey,
					stepKey: input.step.key,
					action: "set",
					value: profile.id,
				}),
			});
		}
		buttons.push(
			{
				text: "Inherit",
				callbackData: this.createLaunchCallbackCommand({
					kind: "model_step",
					sessionKey: input.sessionKey,
					stepKey: input.step.key,
					action: "inherit",
				}),
			},
			{
				text: "Keep current",
				callbackData: this.createLaunchCallbackCommand({
					kind: "model_step",
					sessionKey: input.sessionKey,
					stepKey: input.step.key,
					action: "skip",
				}),
			},
			{
				text: "Done",
				callbackData: this.createLaunchCallbackCommand({
					kind: "finish_model_edit",
					sessionKey: input.sessionKey,
				}),
			},
		);
		return { inlineKeyboard: rows(buttons, 1) };
	}

	private buildLaunchFieldReplyMarkup(input: {
		sessionKey: string;
		fieldId: string;
		fieldKind: string;
		currentValue: unknown;
		options: readonly LauncherFieldOptionDefinition[];
		recentValues: readonly string[];
		required?: boolean;
	}): TelegramReplyMarkup | undefined {
		const buttons: Array<{ text: string; callbackData: string }> = [];
		if (input.fieldKind === "boolean") {
			buttons.push(
				{
					text: "Yes",
					callbackData: this.createLaunchCallbackCommand({
						kind: "field_value",
						sessionKey: input.sessionKey,
						fieldId: input.fieldId,
						value: true,
					}),
				},
				{
					text: "No",
					callbackData: this.createLaunchCallbackCommand({
						kind: "field_value",
						sessionKey: input.sessionKey,
						fieldId: input.fieldId,
						value: false,
					}),
				},
			);
		} else if (input.fieldKind === "select") {
			for (const option of input.options.slice(0, MAX_FIELD_OPTION_BUTTONS)) {
				buttons.push({
					text: option.label,
					callbackData: this.createLaunchCallbackCommand({
						kind: "field_value",
						sessionKey: input.sessionKey,
						fieldId: input.fieldId,
						value: option.value,
					}),
				});
			}
		} else {
			for (const value of input.recentValues.slice(0, MAX_FIELD_OPTION_BUTTONS)) {
				buttons.push({
					text: this.formatRecentValueButtonText(value),
					callbackData: this.createLaunchCallbackCommand({
						kind: "field_value",
						sessionKey: input.sessionKey,
						fieldId: input.fieldId,
						value,
					}),
				});
			}
		}
		const hasCurrentValue =
			typeof input.currentValue === "boolean" ||
			(typeof input.currentValue === "number" && Number.isFinite(input.currentValue)) ||
			(typeof input.currentValue === "string" && input.currentValue.trim() !== "");
		if (
			input.fieldKind !== "boolean" &&
			input.fieldKind !== "select" &&
			input.required &&
			!hasCurrentValue &&
			buttons.length === 0
		) {
			return {
				forceReply: true,
				selective: true,
				inputFieldPlaceholder: "Reply with this field value",
			};
		}
		if (!input.required || hasCurrentValue) {
			buttons.push({
				text: hasCurrentValue ? "Use default" : "Skip",
				callbackData: this.createLaunchCallbackCommand({
					kind: "skip_field",
					sessionKey: input.sessionKey,
					fieldId: input.fieldId,
				}),
			});
		}
		if (buttons.length > 0) return { inlineKeyboard: rows(buttons, 1) };
		return {
			forceReply: true,
			selective: true,
			inputFieldPlaceholder: "Reply with this field value",
		};
	}

	private formatRecentValueButtonText(value: string): string {
		const normalized = value.replace(/\s+/g, " ").trim();
		return normalized.length > 56 ? `${normalized.slice(0, 55)}…` : normalized;
	}

	private buildActionFormFieldReplyMarkup(
		session: PendingActionFormSession,
		field: NonNullable<ReturnType<typeof currentField>>,
	): TelegramInlineKeyboard | undefined {
		if (!canSkipActionFormField(field)) {
			return undefined;
		}
		return {
			inlineKeyboard: [
				[
					{
						text: "Skip",
						callbackData: `fs:${session.instanceId}:${session.sessionId}:${field.id}`,
					},
				],
			],
		};
	}

	private async sendActionFormFieldPrompt(
		thread: TelegramProcessThread,
		session: PendingActionFormSession,
		field: NonNullable<ReturnType<typeof currentField>>,
		prompt = buildFieldPrompt(field),
	): Promise<void> {
		await this.sendHtml(
			thread,
			escapeHtml(prompt),
			this.buildActionFormFieldReplyMarkup(session, field),
		);
	}

	private async executeCallbackCommand(
		instanceId: string,
		command: TelegramCallbackCommand,
	): Promise<void> {
		const process = this.input.deps.processes.getById(instanceId);
		if (!process) return;
		const thread = this.store.getByInstanceId(process.id);
		if (!thread) return;
		const key = threadKey(thread.chatId, thread.messageThreadId);

		switch (command.kind) {
			case "process_action": {
				if (process.lifecycleStatus !== "waiting") {
					await this.sendHtml(
						thread,
						"That action is no longer available. Use /actions to refresh.",
					);
					return;
				}
				const action = this.input.deps.processActions
					.listVisibleActions(process.id)
					.find((candidate) => candidate.id === command.actionId);
				if (!action) {
					await this.sendHtml(
						thread,
						"That action is no longer available. Use /actions to refresh.",
					);
					return;
				}
				if (action.form?.fields.length) {
					const session = buildActionFormSession({
						instanceId: process.id,
						actionId: action.id,
						actionLabel: action.label,
						actionPreview: readActionPreview(action),
						sessionId: createActionFormSessionId(),
						form: action.form,
					});
					this.sessions.set(key, session);
					const field = currentField(session);
					if (field) await this.sendActionFormFieldPrompt(thread, session, field);
					return;
				}
				await this.maybeSelectActionModel({
					instanceId: process.id,
					action,
					formValues: {},
					sessionKey: key,
					thread,
				});
				return;
			}
			case "action_form_skip": {
				await this.skipCurrentActionFormField(key, command.sessionId, command.fieldId, thread);
				return;
			}
			case "action_model_select": {
				const modelSession = this.sessions.get(key);
				const modelProfile = resolveModelProfileFromSession(modelSession, command.profileIndex);
				if (!modelProfile) {
					await this.sendHtml(
						thread,
						"That model option is no longer available. Use /actions to start again.",
					);
					return;
				}
				if (modelSession?.kind === "recovery_model") {
					await this.handleRecoveryModelSelect(
						key,
						command.sessionId,
						modelProfile.id,
						modelSession,
						thread,
					);
					return;
				}
				await this.handleActionModelSelect(key, command.sessionId, modelProfile.id, thread);
				return;
			}
			case "action_model_skip": {
				const modelSession = this.sessions.get(key);
				if (modelSession?.kind === "recovery_model") {
					await this.handleRecoveryModelSkip(key, command.sessionId, modelSession, thread);
					return;
				}
				await this.handleActionModelSkip(key, command.sessionId, thread);
				return;
			}
			case "retry": {
				await this.maybeSelectRecoveryModel({
					instanceId: process.id,
					recoveryKind: "retry",
					sessionKey: key,
					thread,
					execute: (opts) =>
						this.input.deps.commands
							.retryProcess(process.id, {
								...(opts?.nextTurnModelProfileId !== undefined ? opts : {}),
								actor: TELEGRAM_ACTOR,
							})
							.then((result) => {
								this.sendCommandResult(thread, result, "Retry started.", "Retry failed");
							}),
				});
				return;
			}
			case "continue": {
				const turnRecordId = continuableFailedTurnRecordId(process);
				if (!turnRecordId) {
					await this.sendHtml(thread, "No failed turn is available to continue.");
					return;
				}
				await this.maybeSelectRecoveryModel({
					instanceId: process.id,
					recoveryKind: "continue",
					turnRecordId,
					sessionKey: key,
					thread,
					execute: (opts) => {
						const session = buildContinueSession({
							instanceId: process.id,
							turnRecordId,
							nextTurnModelProfileId: opts?.nextTurnModelProfileId,
						});
						this.sessions.set(key, session);
						this.sendCurrentSessionPrompt(thread, session);
					},
				});
				return;
			}
		}
	}

	private async sendCurrentSessionPrompt(
		thread: TelegramProcessThread,
		session: PendingTelegramSession,
	): Promise<boolean> {
		if (session.kind === "continue") {
			await this.sendHtml(thread, CONTINUE_PROMPT);
			return true;
		}
		if (session.kind === "question") {
			await this.sendHtml(thread, escapeHtml(buildQuestionPrompt(session)));
			return true;
		}
		if (session.kind === "action_model") {
			await this.sendActionModelPrompt(thread, session);
			return true;
		}
		if (session.kind === "recovery_model") {
			await this.sendRecoveryModelPrompt(thread, session);
			return true;
		}
		const field = currentField(session);
		if (!field) return false;
		if (session.kind === "action_form") {
			await this.sendActionFormFieldPrompt(thread, session, field);
			return true;
		}
		await this.sendHtml(thread, escapeHtml(buildFieldPrompt(field)));
		return true;
	}

	private async maybeSelectActionModel(input: {
		instanceId: string;
		action: {
			id: string;
			label: string;
			form?: FormDefinition;
			preview?: ActionPreviewLike | null;
		};
		formValues: Record<string, unknown>;
		sessionKey: string;
		thread: TelegramProcessThread;
	}): Promise<void> {
		const fallback = () =>
			this.executeProcessAction(
				input.instanceId,
				{ id: input.action.id, label: input.action.label, preview: input.action.preview },
				input.formValues,
				input.thread,
			);
		try {
			const profiles = this.listSelectableProfiles(input.instanceId);
			if (!profiles.length) return fallback();
			const result = await this.processModelSelection?.preview(
				input.instanceId,
				input.action.id,
				input.formValues,
			);
			if (!result) return fallback();
			if (result.kind === "operational_failure") {
				this.input.logger?.warn?.(
					{ code: result.code },
					"Action model preview unavailable; falling back to direct execution",
				);
				return fallback();
			}
			if (result.kind !== "llm_turn") return fallback();
			const sessionId = createActionFormSessionId();
			const session = buildActionModelSession({
				instanceId: input.instanceId,
				actionId: input.action.id,
				actionLabel: input.action.label,
				actionPreview: input.action.preview,
				sessionId,
				formValues: input.formValues,
				preview: result,
				profiles,
			});
			this.sessions.set(input.sessionKey, session);
			await this.sendActionModelPrompt(input.thread, session);
		} catch (error) {
			this.logError(error, "Action model preview failed; falling back to direct execution");
			return fallback();
		}
	}

	private async resolveActionModelSession(
		sessionKey: string,
		sessionId: string,
		thread: TelegramProcessThread,
	): Promise<PendingActionModelSession | null> {
		const session = this.sessions.get(sessionKey);
		if (!session || session.kind !== "action_model" || session.sessionId !== sessionId) {
			await this.sendHtml(thread, "That model selection expired. Use /actions to start again.");
			return null;
		}
		if (session.expiresAt < Date.now()) {
			this.sessions.delete(sessionKey);
			await this.sendHtml(thread, "That model selection expired. Use /actions to start again.");
			return null;
		}
		this.sessions.delete(sessionKey);
		return session;
	}

	private executeActionModelSession(
		session: PendingActionModelSession,
		thread: TelegramProcessThread,
		opts?: { nextTurnModelProfileId?: string | null },
	): Promise<void> {
		return this.executeProcessAction(
			session.instanceId,
			{ id: session.actionId, label: session.actionLabel, preview: session.actionPreview },
			session.formValues,
			thread,
			opts,
		);
	}

	private async sendActionModelSwitchWarning(
		session: PendingActionModelSession,
		effectiveModelProfileId: string | null | undefined,
		thread: TelegramProcessThread,
	): Promise<void> {
		if (!effectiveModelProfileId) return;
		const warning = buildActionModelSwitchWarning({ session, effectiveModelProfileId });
		if (warning) await this.sendHtml(thread, escapeHtml(warning));
	}

	private async handleActionModelSelect(
		sessionKey: string,
		sessionId: string,
		modelProfileId: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		const session = await this.resolveActionModelSession(sessionKey, sessionId, thread);
		if (!session) return;
		await this.sendActionModelSwitchWarning(session, modelProfileId, thread);
		await this.executeActionModelSession(session, thread, {
			nextTurnModelProfileId: modelProfileId,
		});
	}

	private async handleActionModelSkip(
		sessionKey: string,
		sessionId: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		const session = await this.resolveActionModelSession(sessionKey, sessionId, thread);
		if (!session) return;
		const resolved = session.preview.resolvedModel;
		await this.sendActionModelSwitchWarning(
			session,
			resolved?.status === "resolved" ? resolved.modelProfileId : null,
			thread,
		);
		await this.executeActionModelSession(session, thread);
	}

	private async sendActionModelPrompt(
		thread: TelegramProcessThread,
		session: PendingActionModelSession,
	): Promise<void> {
		await this.sendHtml(
			thread,
			escapeHtml(buildActionModelPrompt({ session })),
			this.buildActionModelReplyMarkup(session),
		);
	}

	private buildActionModelReplyMarkup(
		session: PendingActionModelSession,
	): TelegramInlineKeyboard | undefined {
		const buttons: Array<{ text: string; callbackData: string }> = [];
		let index = 0;
		for (const profile of session.profiles.slice(0, 20)) {
			index += 1;
			const switchesModel = buildActionModelSwitchWarning({
				session,
				effectiveModelProfileId: profile.id,
			});
			buttons.push({
				text: `${switchesModel ? "⚠ " : ""}${profile.id}`,
				callbackData: `ams:${session.instanceId}:${session.sessionId}:${index}`,
			});
		}
		const resolved = session.preview.resolvedModel;
		const resolvedProfileId = resolved?.status === "resolved" ? resolved.modelProfileId : null;
		const keepingCurrentSwitchesModel = resolvedProfileId
			? buildActionModelSwitchWarning({ session, effectiveModelProfileId: resolvedProfileId })
			: null;
		buttons.push({
			text: `${keepingCurrentSwitchesModel ? "⚠ " : ""}Keep current`,
			callbackData: `amk:${session.instanceId}:${session.sessionId}`,
		});
		return buttons.length ? { inlineKeyboard: rows(buttons, 1) } : undefined;
	}

	private async applyActionFormStep(
		key: string,
		session: PendingActionFormSession,
		step: ReturnType<typeof applyFormText>,
		thread: TelegramProcessThread,
	): Promise<void> {
		if (!step.ok || !step.done) {
			const field = currentField(session);
			if (field) {
				await this.sendActionFormFieldPrompt(thread, session, field, step.prompt);
			} else {
				await this.sendHtml(thread, escapeHtml(step.prompt));
			}
			return;
		}
		this.sessions.delete(key);
		await this.maybeSelectActionModel({
			instanceId: session.instanceId,
			action: {
				id: session.actionId,
				label: session.actionLabel,
				form: session.form,
				preview: session.actionPreview,
			},
			formValues: step.values,
			sessionKey: key,
			thread,
		});
	}

	private async applyActionFormText(
		key: string,
		session: PendingActionFormSession,
		text: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		await this.applyActionFormStep(key, session, applyFormText(session, text), thread);
	}

	private async applyActionFormSkip(
		key: string,
		session: PendingActionFormSession,
		thread: TelegramProcessThread,
	): Promise<void> {
		await this.applyActionFormStep(key, session, applyFormSkip(session), thread);
	}

	private async skipCurrentActionFormField(
		key: string,
		sessionId: string,
		fieldId: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		const session = this.sessions.get(key);
		if (!session || session.kind !== "action_form") {
			await this.sendHtml(thread, "This form prompt expired. Use /actions to start again.");
			return;
		}
		if (session.expiresAt < Date.now()) {
			this.sessions.delete(key);
			await this.sendHtml(thread, "This form prompt expired. Use /actions to start again.");
			return;
		}
		const field = currentField(session);
		if (session.sessionId !== sessionId || !field || field.id !== fieldId) {
			await this.sendHtml(
				thread,
				"That skip button is stale. Continue with the latest prompt or send /cancel.",
			);
			return;
		}
		if (!canSkipActionFormField(field)) {
			await this.sendActionFormFieldPrompt(
				thread,
				session,
				field,
				`${field.label} is required and cannot be skipped.\n${buildFieldPrompt(field)}`,
			);
			return;
		}
		await this.applyActionFormSkip(key, session, thread);
	}

	private async handleSessionText(
		key: string,
		session: PendingTelegramSession,
		text: string,
		thread: TelegramProcessThread,
		name: string | null,
	): Promise<void> {
		if (session.expiresAt < Date.now()) {
			this.sessions.delete(key);
			await this.sendHtml(thread, "This prompt expired. Use /actions to start again.");
			return;
		}
		if (session.kind === "continue") {
			const prompt = name === "skip" ? null : text;
			this.sessions.delete(key);
			const result = await this.input.deps.commands.continueFailedTurn(
				session.instanceId,
				session.turnRecordId,
				{
					prompt,
					...(session.nextTurnModelProfileId !== undefined &&
					session.nextTurnModelProfileId !== null
						? { nextTurnModelProfileId: session.nextTurnModelProfileId }
						: {}),
					actor: TELEGRAM_ACTOR,
				},
			);
			await this.sendCommandResult(thread, result, "Continue started.", "Continue failed");
			return;
		}
		if (session.kind === "question") {
			if (name) {
				await this.sendHtml(thread, escapeHtml(buildQuestionPrompt(session)));
				return;
			}
			const step = applyQuestionText(session, text);
			if (!step.done) {
				await this.sendHtml(thread, escapeHtml(step.prompt ?? buildQuestionPrompt(session)));
				return;
			}
			const service = this.input.deps.processQuestions;
			const result = service
				? await service.submitAnswers(
						session.instanceId,
						session.request.id,
						step.draft,
						TELEGRAM_ACTOR,
					)
				: { ok: false as const, message: "Answers cannot be submitted through Telegram." };
			this.sessions.delete(key);
			await this.sendHtml(
				thread,
				result.ok ? "✅ Answers sent. The active turn is continuing." : escapeHtml(result.message),
			);
			return;
		}
		if (session.kind === "action_model") {
			if (name === "skip") {
				await this.handleActionModelSkip(key, session.sessionId, thread);
				return;
			}
			if (name === "cancel") {
				this.sessions.delete(key);
				await this.sendHtml(thread, "Cancelled.");
				return;
			}
			await this.handleActionModelText(key, session, text, thread);
			return;
		}
		if (session.kind === "recovery_model") {
			if (name === "skip") {
				await this.handleRecoveryModelSkip(key, session.sessionId, session, thread);
				return;
			}
			if (name === "cancel") {
				this.sessions.delete(key);
				await this.sendHtml(thread, "Cancelled.");
				return;
			}
			await this.handleRecoveryModelText(key, session, text, thread);
			return;
		}
		if (name === "skip") {
			const field = currentField(session);
			if (!canSkipActionFormField(field)) {
				if (field) {
					await this.sendActionFormFieldPrompt(
						thread,
						session,
						field,
						`${field.label} is required and cannot be skipped.\n${buildFieldPrompt(field)}`,
					);
				}
				return;
			}
			await this.applyActionFormSkip(key, session as PendingActionFormSession, thread);
			return;
		}
		await this.applyActionFormText(key, session as PendingActionFormSession, text, thread);
	}

	private async handleActionModelText(
		sessionKey: string,
		session: PendingActionModelSession,
		text: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		const profile = resolveProfileByTextOrIndex(text.trim(), session.profiles);
		if (profile) {
			this.sessions.delete(sessionKey);
			await this.sendActionModelSwitchWarning(session, profile.id, thread);
			return this.executeActionModelSession(session, thread, {
				nextTurnModelProfileId: profile.id,
			});
		}
		await this.sendHtml(
			thread,
			escapeHtml(`Model must match an available profile.\n${buildActionModelPrompt({ session })}`),
			this.buildActionModelReplyMarkup(session),
		);
	}

	private async maybeSelectRecoveryModel(input: {
		instanceId: string;
		recoveryKind: "retry" | "continue";
		turnRecordId?: string;
		sessionKey: string;
		thread: TelegramProcessThread;
		execute: (opts?: { nextTurnModelProfileId?: string | null }) => void | Promise<void>;
	}): Promise<void> {
		try {
			const profiles = this.listSelectableProfiles(input.instanceId);
			if (!profiles.length) return input.execute();
			const sessionId = createActionFormSessionId();
			const session = buildRecoveryModelSession({
				instanceId: input.instanceId,
				recoveryKind: input.recoveryKind,
				turnRecordId: input.turnRecordId,
				sessionId,
				profiles,
			});
			this.sessions.set(input.sessionKey, session);
			await this.sendRecoveryModelPrompt(input.thread, session);
		} catch (error) {
			this.logError(error, "Recovery model selection failed; falling back to direct execution");
			return input.execute();
		}
	}

	private async handleRecoveryModelSelect(
		sessionKey: string,
		_sessionId: string,
		modelProfileId: string,
		session: PendingRecoveryModelSession,
		thread: TelegramProcessThread,
	): Promise<void> {
		this.sessions.delete(sessionKey);
		await this.executeRecoveryModelSession(session, thread, {
			nextTurnModelProfileId: modelProfileId,
		});
	}

	private async handleRecoveryModelSkip(
		sessionKey: string,
		_sessionId: string,
		session: PendingRecoveryModelSession,
		thread: TelegramProcessThread,
	): Promise<void> {
		this.sessions.delete(sessionKey);
		await this.executeRecoveryModelSession(session, thread);
	}

	private async handleRecoveryModelText(
		sessionKey: string,
		session: PendingRecoveryModelSession,
		text: string,
		thread: TelegramProcessThread,
	): Promise<void> {
		const profile = resolveProfileByTextOrIndex(text.trim(), session.profiles);
		if (profile) {
			this.sessions.delete(sessionKey);
			await this.executeRecoveryModelSession(session, thread, {
				nextTurnModelProfileId: profile.id,
			});
			return;
		}
		await this.sendHtml(
			thread,
			escapeHtml(
				`Model must match an available profile.\n${buildRecoveryModelPrompt({ session })}`,
			),
			this.buildRecoveryModelReplyMarkup(session),
		);
	}

	private async executeRecoveryModelSession(
		session: PendingRecoveryModelSession,
		thread: TelegramProcessThread,
		opts?: { nextTurnModelProfileId?: string | null },
	): Promise<void> {
		if (session.recoveryKind === "retry") {
			const retryOpts = {
				...(opts?.nextTurnModelProfileId !== undefined ? opts : {}),
				actor: TELEGRAM_ACTOR,
			};
			void this.input.deps.commands.retryProcess(session.instanceId, retryOpts).then((result) => {
				this.sendCommandResult(thread, result, "Retry started.", "Retry failed");
			});
		} else {
			const continueSession = buildContinueSession({
				instanceId: session.instanceId,
				turnRecordId: session.turnRecordId ?? "",
				nextTurnModelProfileId: opts?.nextTurnModelProfileId,
			});
			const key = threadKey(thread.chatId, thread.messageThreadId);
			this.sessions.set(key, continueSession);
			await this.sendCurrentSessionPrompt(thread, continueSession);
		}
	}

	private async sendRecoveryModelPrompt(
		thread: TelegramProcessThread,
		session: PendingRecoveryModelSession,
	): Promise<void> {
		await this.sendHtml(
			thread,
			escapeHtml(buildRecoveryModelPrompt({ session })),
			this.buildRecoveryModelReplyMarkup(session),
		);
	}

	private buildRecoveryModelReplyMarkup(
		session: PendingRecoveryModelSession,
	): TelegramInlineKeyboard | undefined {
		const buttons: Array<{ text: string; callbackData: string }> = [];
		let index = 0;
		for (const profile of session.profiles.slice(0, 20)) {
			index += 1;
			buttons.push({
				text: profile.id,
				callbackData: `ams:${session.instanceId}:${session.sessionId}:${index}`,
			});
		}
		buttons.push({
			text: "Keep current",
			callbackData: `amk:${session.instanceId}:${session.sessionId}`,
		});
		return buttons.length ? { inlineKeyboard: rows(buttons, 1) } : undefined;
	}

	private async executeProcessAction(
		instanceId: string,
		action: TelegramActionExecutionSummary,
		input: Record<string, unknown>,
		thread: TelegramProcessThread,
		opts?: { nextTurnModelProfileId?: string | null },
	): Promise<void> {
		const executeOpts: Parameters<typeof this.input.deps.processActions.executeAction>[3] = {
			source: "ui",
			origin: "external_interface",
			actor: TELEGRAM_ACTOR,
		};
		if (opts?.nextTurnModelProfileId !== undefined) {
			executeOpts.nextTurnModelProfileId = opts.nextTurnModelProfileId;
		}
		const result = await this.input.deps.processActions.executeAction(
			instanceId,
			action.id,
			input,
			executeOpts,
		);
		await this.sendCommandResult(
			thread,
			result,
			buildActionSubmittedMessage({ action, values: input }),
			`Action failed: ${action.label}`,
		);
	}

	private async sendCommandResult(
		thread: TelegramProcessThread,
		result: { ok: boolean; message?: string | null; error?: string | null },
		successText: string,
		fallbackError: string,
	): Promise<void> {
		await this.sendHtml(
			thread,
			result.ok ? successText : `⚠️ ${escapeHtml(result.error ?? result.message ?? fallbackError)}`,
		);
	}

	private isAllowed(from: { id: number } | null | undefined): boolean {
		return typeof from?.id === "number" && this.input.config.allowUserIds.includes(from.id);
	}

	private async sendHtml(
		thread: TelegramProcessThread,
		text: string,
		replyMarkup?: TelegramReplyMarkup,
	): Promise<void> {
		await this.sendHtmlToChat(thread.chatId, thread.messageThreadId, text, replyMarkup);
	}

	private async sendResultParts(
		thread: TelegramProcessThread,
		instanceId: string,
		turnRecordId: string,
		parts: readonly TelegramResultPart[],
	): Promise<void> {
		for (const [index, part] of parts.entries()) {
			if (part.kind === "html") {
				await this.sendHtml(thread, part.html);
				continue;
			}
			if (part.kind === "mermaid") {
				try {
					await this.sendPhotoWithDocumentFallback(thread, {
						bytes: await renderMermaidPng(part.source),
						filename: `diagram-${index + 1}.png`,
						caption: "Mermaid diagram",
					});
				} catch (error) {
					this.logError(error, "Telegram Mermaid rendering failed; sending diagram source");
					await this.sendHtml(
						thread,
						`⚠️ <b>Diagram could not be rendered</b>\n<pre><code>${escapeHtml(part.source)}</code></pre>`,
					);
				}
				continue;
			}
			try {
				const bytes = await this.input.deps.resultImages?.get(
					instanceId,
					turnRecordId,
					part.imageId,
				);
				if (!bytes) throw new Error("Managed result image is unavailable");
				await this.sendPhotoWithDocumentFallback(thread, {
					bytes,
					filename: part.imageId,
					...(part.alt.trim() ? { caption: part.alt.trim().slice(0, 900) } : {}),
				});
			} catch (error) {
				this.logError(error, "Telegram result image delivery failed");
				const label = part.alt.trim() || part.imageId;
				await this.sendHtml(thread, `⚠️ Image unavailable: ${escapeHtml(label)}`);
			}
		}
	}

	private async sendPhotoWithDocumentFallback(
		thread: TelegramProcessThread,
		file: { bytes: Uint8Array; filename: string; caption?: string },
	): Promise<void> {
		const input = { ...messageTarget(thread.chatId, thread.messageThreadId), ...file };
		try {
			await this.input.client.sendPhoto(input);
		} catch (error) {
			this.logError(error, "Telegram photo send failed; retrying as a document");
			await this.input.client.sendDocument(input);
		}
	}

	private async sendPlainToChat(
		chatId: string,
		messageThreadId: number | undefined,
		text: string,
		replyMarkup?: TelegramReplyMarkup,
	): Promise<void> {
		const chunks = splitPlainTelegramText(text, this.input.config.markdown.maxChars);
		for (const [index, chunk] of chunks.entries()) {
			const isLast = index === chunks.length - 1;
			await this.input.client.sendMessage({
				...messageTarget(chatId, messageThreadId),
				text: chunk,
				...(isLast && replyMarkup ? { replyMarkup } : {}),
			});
		}
	}

	private async sendHtmlToChat(
		chatId: string,
		messageThreadId: number | undefined,
		text: string,
		replyMarkup?: TelegramReplyMarkup,
	): Promise<void> {
		const chunks = splitTelegramHtml(text, this.input.config.markdown.maxChars);
		for (const [index, chunk] of chunks.entries()) {
			const isLast = index === chunks.length - 1;
			try {
				await this.input.client.sendMessage({
					...messageTarget(chatId, messageThreadId),
					text: chunk,
					parseMode: "HTML",
					...(isLast && replyMarkup ? { replyMarkup } : {}),
				});
			} catch (error) {
				this.logError(error, "Telegram HTML chunk send failed; retrying chunk as plain text");
				await this.sendPlainToChat(
					chatId,
					messageThreadId,
					telegramHtmlToPlainText(chunk),
					isLast ? replyMarkup : undefined,
				);
			}
		}
	}

	private logError(error: unknown, message: string): void {
		this.input.logger?.warn?.(
			{ err: error instanceof Error ? error.message : String(error) },
			message,
		);
	}
}
