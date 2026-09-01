import {
	DEFAULT_CONTINUE_PROMPT,
	type ProcessEvent,
	type ProcessInput,
	type ProcessInstance,
	type ProcessProject,
	type ProcessTurnAnnotation,
	type ProcessTurnRecord,
	type WorkerLease,
} from "@leitwerk-dev/domain";
import {
	createDurableWsFrame,
	type PiSessionEntry,
	type PrimaryPathSnapshot,
} from "@leitwerk-dev/protocol";
import {
	createCompactProcessDetailFixtureFactory,
	createTestQuestionRequest,
} from "@leitwerk-dev/test-support/fixtures";
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessActionModelPreview, ProcessDetailData } from "../lib/api.js";

const {
	mockDeleteFutureExecution,
	mockFetchProcessActionModelPreview,
	mockFetchProcessDetail,
	mockFetchTicketCreationTools,
	mockFetchTurnReasoningDetail,
	mockWs,
	mockPostProcessAction,
	mockPostProcessRetry,
	mockPostProcessTurnContinue,
	mockLaunchTicketCreation,
	mockUpdateScheduledAction,
} = vi.hoisted(() => ({
	mockDeleteFutureExecution: vi.fn(),
	mockFetchProcessActionModelPreview: vi.fn(),
	mockFetchProcessDetail: vi.fn(),
	mockFetchTicketCreationTools: vi.fn(),
	mockFetchTurnReasoningDetail: vi.fn(),
	mockWs: (() => {
		let state = {
			status: "disconnected" as "connecting" | "connected" | "disconnected",
			serverVersion: null as string | null,
			reconnectCount: 0,
		};
		const subscribers = new Set<(value: typeof state) => void>();
		return {
			set(next: typeof state) {
				state = next;
				for (const subscriber of subscribers) {
					subscriber(state);
				}
			},
			subscribe(subscriber: (value: typeof state) => void) {
				subscribers.add(subscriber);
				subscriber(state);
				return () => subscribers.delete(subscriber);
			},
		};
	})(),
	mockPostProcessAction: vi.fn(),
	mockPostProcessRetry: vi.fn(),
	mockPostProcessTurnContinue: vi.fn(),
	mockLaunchTicketCreation: vi.fn(),
	mockUpdateScheduledAction: vi.fn(),
}));

vi.mock("../lib/api", () => ({
	fetchProcessActionModelPreview: mockFetchProcessActionModelPreview,
	fetchProcessDetail: async (...args: unknown[]) =>
		compactTestDetail(await mockFetchProcessDetail(...args)),
	fetchProcessesList: vi.fn().mockResolvedValue({ processes: [], futureExecutions: [] }),
	fetchTicketCreationTools: mockFetchTicketCreationTools,
	fetchTurnReasoningDetail: mockFetchTurnReasoningDetail,
	postProcessAction: mockPostProcessAction,
	postProcessRetry: mockPostProcessRetry,
	postProcessTurnContinue: mockPostProcessTurnContinue,
	launchTicketCreation: mockLaunchTicketCreation,
	updateScheduledAction: mockUpdateScheduledAction,
	deleteFutureExecution: mockDeleteFutureExecution,
}));

vi.mock("../lib/ws.svelte", () => ({
	wsStore: { subscribe: mockWs.subscribe },
}));

import { scrollTopForAnchor } from "../chronicle/lib/scroll-sync.js";
import { formatUsdEstimate } from "../lib/cost-estimates.js";
import {
	clearPendingProcessToastFocus,
	queuePendingProcessToastFocus,
} from "../lib/process-toast-focus.svelte.js";
import { clearDetail, detailState, handleWsEvent } from "../lib/processes.svelte";
import { emptyLaunchConfiguration } from "../lib/test-fixtures.js";
import ProcessDetailPage from "./ProcessDetailPage.svelte";

const mountedApps: Array<ReturnType<typeof mount>> = [];
let scheduledFrameCallbacks = new Map<number, FrameRequestCallback>();

const ticketProcessGraph = {
	id: "ticket_issue_process",
	entryTurnIds: ["generate_plan"],
	reachableTurnIds: [
		"generate_plan",
		"plan_review",
		"implement",
		"run_llm_review",
		"address_review",
		"verify_build",
		"fix_build",
		"commit_and_complete",
		"implementation_review",
	],
	turnTransitions: {
		generate_plan: [{ nextTurnId: "plan_review", outcome: "plan_saved" }],
		plan_review: [
			{ nextTurnId: "generate_plan", trigger: "revision_requested" },
			{ nextTurnId: "implement", trigger: "plan_approved" },
		],
		implement: [{ nextTurnId: "run_llm_review", trigger: "handoff_review" }],
		run_llm_review: [
			{ nextTurnId: "address_review", outcome: "issues_found" },
			{ nextTurnId: "implementation_review", outcome: "no_issues" },
		],
		address_review: [{ nextTurnId: "verify_build" }],
		verify_build: [
			{ nextTurnId: "fix_build", outcome: "build_failing" },
			{ nextTurnId: "commit_and_complete", outcome: "build_passing" },
		],
		fix_build: [{ nextTurnId: "verify_build", outcome: "build_fixed" }],
		commit_and_complete: [
			{ nextTurnId: "implementation_review", trigger: "completion_policy_ready" },
		],
	},
};

const ticketProcessFlow = {
	processId: "ticket_issue_process",
	entryTurnIds: ["generate_plan"],
	spine: ["generate_plan", "plan_review", "implement", "implementation_review"],
	nodes: [
		{
			turnId: "generate_plan",
			description: "Draft plan",
			turnType: "llm" as const,
			role: "spine" as const,
			spineIndex: 0,
			anchorTurnId: null,
			isEntry: true,
		},
		{
			turnId: "plan_review",
			description: "Review plan",
			turnType: "human" as const,
			role: "spine" as const,
			spineIndex: 1,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "implement",
			description: "Implement",
			turnType: "llm" as const,
			role: "spine" as const,
			spineIndex: 2,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "implementation_review",
			description: "Review implementation",
			turnType: "human" as const,
			role: "spine" as const,
			spineIndex: 3,
			anchorTurnId: null,
			isEntry: false,
		},
		{
			turnId: "run_llm_review",
			description: "Run automated review",
			turnType: "llm" as const,
			role: "branch" as const,
			spineIndex: null,
			anchorTurnId: "implement",
			isEntry: false,
		},
		{
			turnId: "address_review",
			description: "Address review",
			turnType: "llm" as const,
			role: "branch" as const,
			spineIndex: null,
			anchorTurnId: "implement",
			isEntry: false,
		},
		{
			turnId: "verify_build",
			description: "Verify build",
			turnType: "automatic" as const,
			role: "branch" as const,
			spineIndex: null,
			anchorTurnId: "implement",
			isEntry: false,
		},
		{
			turnId: "fix_build",
			description: "Fix build",
			turnType: "llm" as const,
			role: "branch" as const,
			spineIndex: null,
			anchorTurnId: "implement",
			isEntry: false,
		},
		{
			turnId: "commit_and_complete",
			description: "Commit and complete",
			turnType: "automatic" as const,
			role: "branch" as const,
			spineIndex: null,
			anchorTurnId: "implement",
			isEntry: false,
		},
	],
	edges: [
		{
			from: "generate_plan",
			to: "plan_review",
			lifecycleStatus: null,
			kind: "forward" as const,
			label: "plan_saved",
		},
		{
			from: "plan_review",
			to: "implement",
			lifecycleStatus: null,
			kind: "forward" as const,
			label: "plan_approved",
		},
		{
			from: "plan_review",
			to: "generate_plan",
			lifecycleStatus: null,
			kind: "loopback" as const,
			label: "revision_requested",
		},
		{
			from: "implement",
			to: "run_llm_review",
			lifecycleStatus: null,
			kind: "branch" as const,
			label: "handoff_review",
		},
	],
	endStates: [{ lifecycleStatus: "aborted" as const, synthetic: true }],
};

class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];

	private readonly observedTargets = new Set<Element>();

	constructor(private readonly callback: ResizeObserverCallback) {
		FakeResizeObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.observedTargets.add(target);
	}

	unobserve(target: Element): void {
		this.observedTargets.delete(target);
	}

	disconnect(): void {
		this.observedTargets.clear();
	}

	trigger(): void {
		this.callback([], this as unknown as ResizeObserver);
	}

	static reset(): void {
		FakeResizeObserver.instances = [];
	}

	static triggerAll(): void {
		for (const instance of FakeResizeObserver.instances) {
			instance.trigger();
		}
	}

	static triggerFor(target: Element): void {
		for (const instance of FakeResizeObserver.instances) {
			if (instance.observedTargets.has(target)) {
				instance.trigger();
			}
		}
	}
}

class FakeMutationObserver {
	static instances: FakeMutationObserver[] = [];

	private readonly observedTargets = new Map<Node, MutationObserverInit | undefined>();

	constructor(private readonly callback: MutationCallback) {
		FakeMutationObserver.instances.push(this);
	}

	observe(target: Node, options?: MutationObserverInit): void {
		this.observedTargets.set(target, options);
	}

	disconnect(): void {
		this.observedTargets.clear();
	}

	takeRecords(): MutationRecord[] {
		return [];
	}

	trigger(): void {
		this.callback([], this as unknown as MutationObserver);
	}

	static reset(): void {
		FakeMutationObserver.instances = [];
	}

	static triggerAll(): void {
		for (const instance of FakeMutationObserver.instances) {
			instance.trigger();
		}
	}

	static observedOptions(): MutationObserverInit[] {
		return FakeMutationObserver.instances.flatMap((instance) =>
			[...instance.observedTargets.values()].filter(
				(options): options is MutationObserverInit => options !== undefined,
			),
		);
	}
}

function createPrimaryPathSnapshot(): PrimaryPathSnapshot {
	return {
		instanceId: "agt_1",
		rebuiltAt: "2026-01-01T00:03:00Z",
		primaryPathEntries: [
			{
				id: "root-user",
				parentId: null,
				type: "message",
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "user",
					content: "Ship the requested change",
				},
			},
			{
				id: "assistant-plan",
				parentId: "root-user",
				type: "message",
				timestamp: "2026-01-01T00:02:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "## Plan\n\n- Inspect the repo\n- Patch the bug" }],
				},
			},
		],
		currentLeaf: { entryId: "assistant-plan", turnRecordId: "trn_1" },
		semanticEntryRefs: {
			rootEntry: { entryId: "root-user", turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: "assistant-plan", turnRecordId: "trn_1" },
			plan: { entryId: "assistant-plan", turnRecordId: "trn_1" },
			review: null,
		},
		labels: {},
		turnAnnotations: [],
		detailRail: {
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		},
		turnState: {
			currentTurnRecordId: null,
			workerState: "busy",
			isStreaming: false,
			activeTurn: null,
		},
	};
}

function createEmptyPrimaryPathSnapshot(): PrimaryPathSnapshot {
	return {
		instanceId: "agt_1",
		rebuiltAt: "2026-01-01T00:00:00Z",
		primaryPathEntries: [],
		currentLeaf: null,
		semanticEntryRefs: {
			rootEntry: null,
			currentPrimaryPathLeaf: null,
			plan: null,
			review: null,
		},
		labels: {},
		turnAnnotations: [],
		detailRail: {
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		},
		turnState: {
			currentTurnRecordId: null,
			workerState: null,
			isStreaming: false,
			activeTurn: null,
		},
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createBasePiSessionEntries() {
	return [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Ship the requested change",
			},
		},
		{
			type: "message",
			id: "assistant-plan",
			parentId: "root-user",
			timestamp: "2026-01-01T00:02:00Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the repo carefully.\n" },
					{ type: "text", text: "## Plan\n\n- Inspect the repo\n- Patch the bug" },
				],
				usage: {
					input: 640,
					output: 180,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 820,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
	];
}

type LegacyProcessDetailTestData = ProcessDetailData & {
	process: ProcessInstance;
	projects: ProcessProject[];
	inputs: ProcessInput[];
	events: ProcessEvent[];
	turnRecords: ProcessTurnRecord[];
	turnAnnotations: ProcessTurnAnnotation[];
	workerLease: WorkerLease | null;
	processGraph: typeof ticketProcessGraph;
	piSessionEntries: PiSessionEntry[];
};

const compactFixtureFactory = createCompactProcessDetailFixtureFactory();

function compactTestDetail(
	input: ProcessDetailData | LegacyProcessDetailTestData,
): ProcessDetailData {
	const compacted = compactFixtureFactory.compact(input);
	return {
		...compacted,
		questionRequests: input.questionRequests ?? compacted.questionRequests,
		recovery: input.recovery ?? compacted.recovery,
		startup: input.startup ?? compacted.startup,
		startupRecovery: input.startupRecovery ?? compacted.startupRecovery,
	};
}

function createFailedTurnRecovery(
	turnRecordId: string,
	overrides: Partial<
		ProcessDetailData["recovery"] extends infer Recovery ? NonNullable<Recovery> : never
	> = {},
) {
	return {
		turnRecordId,
		title: "Implement Fix needs attention",
		summary: "The turn failed and can be retried or continued.",
		defaultContinuePrompt: DEFAULT_CONTINUE_PROMPT,
		canContinue: true,
		supportsModelOverride: true,
		defaultModelProfileId: null,
		providerOptions: {},
		...overrides,
	};
}

function buildMockReasoningResponse(requestInstanceId: string, turnRecordId: string) {
	return compactFixtureFactory.reasoningResponse(requestInstanceId, turnRecordId);
}

function createProcessDetail(): LegacyProcessDetailTestData {
	return {
		process: {
			id: "agt_1",
			processId: "ticket_issue_process",
			selectedTurnId: null,
			lifecycleStatus: "completed",
			currentExecution: null,
			planRevision: 0,
			title: null,
			externalId: "PROJ-1",
			externalUrl: null,
			metadata: null,
			modelProfileId: null,
			paramsJson: null,
			stateJson: null,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:10:00Z",
		},
		projects: [],
		inputs: [],
		events: [],
		leafOutcomeSnapshots: [],
		turnRecords: [
			{
				id: "trn_1",
				instanceId: "agt_1",
				turnId: "generate_plan",
				turnType: "llm",
				status: "succeeded",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: "assistant-plan",
				turnResultMarkdown: "## Plan\n\n- Inspect the repo\n- Patch the bug",
				errorSummary: null,
				errorClass: null,
				startedAt: "2026-01-01T00:01:00Z",
				endedAt: "2026-01-01T00:02:00Z",
			},
		],
		turnAnnotations: [],
		workerLease: null,
		processDisplayName: "PROJ-1",
		processGraph: ticketProcessGraph,
		processFlow: ticketProcessFlow,
		piSessionEntries: createBasePiSessionEntries(),
		definesLeafOutcome: false,
		actions: [],
		toolRenderers: [],
		modelConfiguration: {
			availableProfiles: [],
			effectiveSelectedTurn: null,
			defaultModel: {
				processConfigModelProfileId: null,
				instanceModelProfileId: null,
				effectiveModelProfileId: null,
				source: "none",
			},
			turns: [],
		},
		runDetails: {
			systemPrompt: "You are a careful coding assistant.",
			appendSystemPrompt: "Always explain your work briefly.",
			availablePiToolNames: ["read", "bash", "edit", "write"],
			turns: [
				{
					turnId: "generate_plan",
					description: "Generate plan",
					activePiToolNames: ["read", "bash"],
					outcomeActions: [
						{
							name: "plan_saved",
							description: "Save the generated plan",
							parameters: [
								{
									name: "summary",
									type: "string",
									description: "Short summary of the plan",
									required: true,
								},
							],
						},
					],
				},
				{
					turnId: "implement_fix",
					description: "Implement fix",
					activePiToolNames: ["read", "bash", "edit"],
					outcomeActions: [],
				},
			],
		},
		launchConfiguration: emptyLaunchConfiguration(),
		primaryPath: createPrimaryPathSnapshot(),
	};
}

const firstReasoningFullPrompt = [
	"Process context for the planning turn.",
	"",
	"Operator request:",
	"First prompt input",
	"",
	"Return a concise plan.",
].join("\n");
const secondReasoningFullPrompt = [
	"Process context for the implementation turn.",
	"",
	"Operator request:",
	"Second prompt input",
	"",
	"Patch the implementation and report the result.",
].join("\n");

function createReasoningOverlayDetail(): ProcessDetailData {
	const detail = createProcessDetail();
	detail.turnRecords = [
		{
			id: "trn_1",
			instanceId: "agt_1",
			turnId: "generate_plan",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: "tool-result-1",
			modelProfileId: "claude-sonnet-4",
			turnResultMarkdown: "## Plan\n\n- Inspect the repo\n- Patch the bug",
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:01:00Z",
			endedAt: "2026-01-01T00:02:00Z",
		},
		{
			id: "trn_2",
			instanceId: "agt_1",
			turnId: "implement_fix",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: "trn_1",
			pathType: "primary",
			forkPiEntryId: "tool-result-1",
			resultPiEntryId: "assistant-fix",
			modelProfileId: "gpt-5-mini",
			turnResultMarkdown: "## Fix\n\n- Applied the patch",
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:03:00Z",
			endedAt: "2026-01-01T00:04:00Z",
		},
	];
	detail.inputs = [
		{
			id: "inp_1",
			instanceId: "agt_1",
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			target: null,
			bodyMarkdown: "First prompt input",
			receivedAt: "2026-01-01T00:00:55Z",
			consumedAt: "2026-01-01T00:00:58Z",
		},
		{
			id: "inp_2",
			instanceId: "agt_1",
			sequence: 2,
			source: "app_steer",
			kind: "instruction",
			target: null,
			bodyMarkdown: "Second prompt input",
			receivedAt: "2026-01-01T00:02:55Z",
			consumedAt: "2026-01-01T00:02:58Z",
		},
	];
	detail.events = [];
	detail.piSessionEntries = [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:01:00Z",
			message: {
				role: "user",
				content: firstReasoningFullPrompt,
			},
		},
		{
			type: "message",
			id: "assistant-plan",
			parentId: "root-user",
			timestamp: "2026-01-01T00:01:05Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Need to inspect the repo.\n" },
					{ type: "toolCall", id: "tool_1", name: "read", arguments: { path: "README.md" } },
				],
				usage: {
					input: 1200,
					output: 340,
					cacheRead: 12,
					cacheWrite: 0,
					totalTokens: 1552,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
		{
			type: "message",
			id: "tool-result-1",
			parentId: "assistant-plan",
			timestamp: "2026-01-01T00:01:09Z",
			message: {
				role: "toolResult",
				toolCallId: "tool_1",
				toolName: "read",
				content: [{ type: "text", text: "README contents" }],
				details: { ok: true },
				isError: false,
			},
		},
		{
			type: "message",
			id: "user-fix-prompt",
			parentId: "tool-result-1",
			timestamp: "2026-01-01T00:03:00Z",
			message: {
				role: "user",
				content: secondReasoningFullPrompt,
			},
		},
		{
			type: "message",
			id: "assistant-fix",
			parentId: "user-fix-prompt",
			timestamp: "2026-01-01T00:03:05Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "Need to patch the implementation.\n" }],
				usage: {
					input: 980,
					output: 210,
					cacheRead: 0,
					cacheWrite: 14,
					totalTokens: 1204,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
	];
	detail.primaryPath.primaryPathEntries = [
		detail.piSessionEntries[0] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[1] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[2] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[3] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[4] as PrimaryPathSnapshot["primaryPathEntries"][number],
	];
	detail.primaryPath.currentLeaf = { entryId: "assistant-fix", turnRecordId: "trn_2" };
	detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "assistant-fix",
		turnRecordId: "trn_2",
	};
	detail.primaryPath.semanticEntryRefs.plan = {
		entryId: "tool-result-1",
		turnRecordId: "trn_1",
	};
	return detail;
}

function createOperatorDecisionTraceIsolationDetail(): ProcessDetailData {
	const detail = createProcessDetail();
	detail.turnRecords = [
		{
			id: "trn_plan",
			instanceId: "agt_1",
			turnId: "generate_plan",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: "assistant-plan",
			modelProfileId: "claude-sonnet-4",
			turnResultMarkdown: "## Plan\n\n- Draft the implementation",
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:01:00Z",
			endedAt: "2026-01-01T00:02:00Z",
		},
		{
			id: "trn_decision",
			instanceId: "agt_1",
			turnId: "implementation_decision",
			turnType: "human",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			modelProfileId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:03:00Z",
			endedAt: "2026-01-01T00:03:00Z",
		},
		{
			id: "trn_impl",
			instanceId: "agt_1",
			turnId: "implement_fix",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			resultPiEntryId: "assistant-fix",
			modelProfileId: "gpt-5-mini",
			turnResultMarkdown: "## Fix\n\n- Applied the patch",
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:04:00Z",
			endedAt: "2026-01-01T00:05:00Z",
		},
	];
	detail.turnAnnotations = [
		{
			id: "tan_decision",
			instanceId: "agt_1",
			annotationType: "acceptance_state",
			annotationKey: "acceptance_state:trn_decision",
			references: [{ kind: "turn_record", turnRecordId: "trn_decision", role: "subject" }],
			payload: {
				actionId: "request_revision",
				actionLabel: "Request revision",
				acceptanceState: "requires_changes",
				submittedFields: [
					{
						fieldId: "message",
						label: "Revision notes",
						value: "Tighten the implementation.",
					},
				],
			},
			createdAt: "2026-01-01T00:03:00Z",
			updatedAt: "2026-01-01T00:03:00Z",
		},
	];
	detail.inputs = [
		{
			id: "inp_decision",
			instanceId: "agt_1",
			sequence: 1,
			source: "action_prompt",
			kind: "instruction",
			target: { semanticRef: "currentPrimaryPathLeaf" },
			bodyMarkdown: "Tighten the implementation.",
			receivedAt: "2026-01-01T00:03:30Z",
			consumedAt: "2026-01-01T00:03:55Z",
		},
	];
	detail.piSessionEntries = [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Ship the requested change",
			},
		},
		{
			type: "message",
			id: "assistant-plan",
			parentId: "root-user",
			timestamp: "2026-01-01T00:01:05Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "Plan the implementation.\n" }],
				usage: {
					input: 420,
					output: 120,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 540,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
		{
			type: "message",
			id: "assistant-fix",
			parentId: "assistant-plan",
			timestamp: "2026-01-01T00:04:05Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Patch the code carefully.\n" },
					{ type: "text", text: "Applied the patch" },
				],
				usage: {
					input: 210,
					output: 64,
					cacheRead: 8,
					cacheWrite: 0,
					totalTokens: 282,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
	];
	detail.primaryPath.primaryPathEntries = [
		detail.piSessionEntries[0] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[1] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[2] as PrimaryPathSnapshot["primaryPathEntries"][number],
	];
	detail.primaryPath.currentLeaf = { entryId: "assistant-fix", turnRecordId: "trn_impl" };
	detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "assistant-fix",
		turnRecordId: "trn_impl",
	};
	detail.primaryPath.semanticEntryRefs.plan = {
		entryId: "assistant-plan",
		turnRecordId: "trn_plan",
	};
	return detail;
}

function setSingleTextareaActionForm(
	action: ProcessDetailData["actions"][number],
	label: string,
	options: { formId?: string; primaryPrompt?: boolean; required?: boolean } = {},
) {
	action.form = {
		id: options.formId ?? action.id,
		fields: [
			{
				id: "message",
				label,
				kind: "textarea",
				...(options.primaryPrompt ? { primaryPrompt: true } : {}),
				...(options.required ? { required: true } : {}),
			},
		],
	};
}

function createActionRequiredDetail(): ProcessDetailData {
	const detail = createReasoningOverlayDetail();
	detail.actions = [
		{
			id: "approve_patch",
			label: "Approve patch",
			description: "Approve the implementation and continue.",
			preview: {
				kind: "turn",
				turnId: "implement_fix",
				turnKind: "llm",
				description: "Implement the next revision",
			},
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
		},
	];
	detail.process.selectedTurnId = "implementation_review";
	detail.process.lifecycleStatus = "waiting";
	detail.selectedTurn = {
		turnId: "implementation_review",
		kind: "human",
		description: "Review implementation",
		commentary: "Choose what should happen after reviewing the implementation.",
		externalTriggers: [],
	};
	detail.modelConfiguration = {
		availableProfiles: [
			{
				id: "claude-sonnet-4",
				label: "claude-sonnet-4 — anthropic/claude-sonnet-4",
				description: "High quality.",
				availability: "available",
			},
			{
				id: "gpt-5-mini",
				label: "gpt-5-mini — openai/gpt-5-mini",
				description: "Fast.",
				availability: "available",
			},
		],
		effectiveSelectedTurn: null,
		defaultModel: {
			processConfigModelProfileId: null,
			instanceModelProfileId: "claude-sonnet-4",
			effectiveModelProfileId: "claude-sonnet-4",
			source: "instance",
		},
		turns: [
			{
				turnId: "implement_fix",
				description: "Implement the next revision",
				processConfigModelProfileId: null,
				instanceModelProfileId: null,
				effectiveConfiguredModelProfileId: null,
				source: "default",
			},
		],
	};
	return detail;
}

function createActionRequiredDetailWithMultipleActions(): ProcessDetailData {
	const detail = createActionRequiredDetail();
	const primaryAction = detail.actions[0];
	if (!primaryAction) {
		throw new Error("expected base action");
	}
	detail.actions = [
		primaryAction,
		{
			id: "request_revision",
			label: "Request revision",
			description: "Ask for another pass.",
			preview: {
				kind: "turn",
				turnId: "review_from_fallback",
				turnKind: "llm",
				description: "Review from fallback",
			},
			supportsScheduling: false,
			supportsNextTurnModelOverride: true,
		},
	];
	return detail;
}

function createActionRequiredDetailWithPromptForms(): ProcessDetailData {
	const detail = createActionRequiredDetailWithMultipleActions();
	const approve = detail.actions[0];
	const revise = detail.actions[1];
	if (!approve || !revise) throw new Error("expected two actions");
	approve.form = {
		id: "approve_patch",
		title: "Approve patch",
		fields: [
			{
				id: "approvalPrompt",
				label: "Approval prompt",
				kind: "textarea",
				primaryPrompt: true,
			},
			{ id: "approvalNote", label: "Approval note", kind: "text" },
		],
	};
	revise.form = {
		id: "request_revision",
		title: "Request revision",
		fields: [
			{
				id: "revisionPrompt",
				label: "Revision prompt",
				kind: "textarea",
				primaryPrompt: true,
			},
			{ id: "revisionNote", label: "Revision note", kind: "text" },
		],
	};
	return detail;
}

function createScheduledActionRailDetail(): ProcessDetailData {
	const detail = createActionRequiredDetail();
	detail.actions = [];
	detail.scheduledAction = {
		id: "fut_1",
		nextRunAt: "2026-01-01T01:00:00Z",
		actionId: "approve_patch",
		actionLabel: "Approve patch",
		input: {},
		nextTurnModelProfileId: "gpt-5-mini",
		action: {
			id: "approve_patch",
			label: "Approve patch",
			description: "Approve the implementation and continue.",
			preview: {
				kind: "turn",
				turnId: "implement_fix",
				turnKind: "llm",
				description: "Implement the next revision",
			},
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
		},
	};
	return detail;
}

function createBlockedScheduledActionRailDetail(): ProcessDetailData {
	const detail = createScheduledActionRailDetail();
	if (!detail.scheduledAction) throw new Error("expected scheduled action");
	detail.scheduledAction.status = "blocked";
	detail.scheduledAction.blockedReason = {
		code: "model_unavailable",
		selection: {
			modelProfileId: "gpt-5-mini",
			provenance: { kind: "explicit", source: "action_override" },
		},
		summary: "The selected model is unavailable",
		detectedAt: "2026-01-01T00:00:00Z",
		availabilityRevision: 2,
	};
	return detail;
}

function createExternalTriggerRailDetail(): ProcessDetailData {
	const detail = createReasoningOverlayDetail();
	detail.process.selectedTurnId = "await_review_file";
	detail.process.lifecycleStatus = "waiting";
	detail.selectedTurn = {
		turnId: "await_review_file",
		kind: "external",
		description: "Watch the configured review file for the next revision request",
		commentary: "The process is paused until an outside system triggers the next step.",
		externalTriggers: [
			{
				id: "review_file",
				kind: "human_action_external_trigger",
				label: "Configured review file",
				description: "Write revision notes to the watched file.",
			},
		],
	};
	return detail;
}

function createActionRequiredDetailWithLeafOutcome(): ProcessDetailData {
	const detail = createActionRequiredDetail();
	detail.definesLeafOutcome = true;
	detail.leafOutcomeSnapshots = [
		{
			id: "los_patch",
			instanceId: detail.process.id,
			leafEntryId: "assistant-fix",
			turnRecordId: "trn_2",
			rendererId: null,
			schemaVersion: null,
			props: {},
			fallbackMarkdown: "## Patch summary\n\nReady for review.",
			status: "ready",
			warningCode: null,
			warningMessage: null,
			anchoredAt: "2026-01-01T00:04:30Z",
			createdAt: "2026-01-01T00:04:31Z",
		},
	];
	return detail;
}

function createAbortedDetail(): ProcessDetailData {
	const detail = createActionRequiredDetail();
	detail.process.lifecycleStatus = "aborted";
	detail.process.updatedAt = "2026-01-01T00:10:00Z";
	return detail;
}

function createContinuableFailedDetail(): ProcessDetailData {
	const detail = createReasoningOverlayDetail();
	detail.process.selectedTurnId = "implement_fix";
	detail.process.lifecycleStatus = "error";
	detail.process.currentExecution = { kind: "worker_start", id: "tsr_2" };
	detail.recovery = createFailedTurnRecovery("trn_2");
	detail.turnRecords[1] = {
		...detail.turnRecords[1],
		status: "failed",
		resultPiEntryId: null,
		errorSummary: "Turn 'implement_fix' prompt failed: exceeded inactivity timeout after 300000ms",
		errorClass: "llm_error",
		endedAt: "2026-01-01T00:04:30Z",
	};
	detail.actions = [];
	detail.selectedTurn = null;
	return detail;
}

function createContinuableFailedDetailWithHistoricalLeafOutcome(): ProcessDetailData {
	const detail = createReasoningOverlayDetail();
	detail.process.selectedTurnId = "implement_fix";
	detail.process.lifecycleStatus = "error";
	detail.process.currentExecution = { kind: "worker_start", id: "tsr_3" };
	detail.recovery = createFailedTurnRecovery("trn_3");
	detail.actions = [];
	detail.definesLeafOutcome = true;
	detail.selectedTurn = {
		turnId: "implement_fix",
		kind: "llm",
		description: "Implement change",
		commentary: null,
		externalTriggers: [],
	};
	detail.turnRecords = [
		detail.turnRecords[0],
		detail.turnRecords[1],
		{
			id: "trn_review",
			instanceId: "agt_1",
			turnId: "implementation_decision",
			turnType: "human",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			modelProfileId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:04:35Z",
			endedAt: "2026-01-01T00:04:35Z",
		},
		{
			...detail.turnRecords[1],
			id: "trn_3",
			parentTurnRecordId: null,
			attemptNumber: 1,
			status: "failed",
			resultPiEntryId: null,
			errorSummary:
				"Turn 'implement_fix' prompt failed: exceeded inactivity timeout after 300000ms",
			errorClass: "llm_error",
			startedAt: "2026-01-01T00:05:00Z",
			endedAt: "2026-01-01T00:06:30Z",
		},
	];
	detail.leafOutcomeSnapshots = [
		{
			id: "los_patch",
			instanceId: detail.process.id,
			leafEntryId: "assistant-fix",
			turnRecordId: "trn_2",
			rendererId: null,
			schemaVersion: null,
			props: {},
			fallbackMarkdown: "## Patch summary\n\nReady for review.",
			status: "ready",
			warningCode: null,
			warningMessage: null,
			anchoredAt: "2026-01-01T00:04:30Z",
			createdAt: "2026-01-01T00:04:31Z",
		},
	];
	return detail;
}

function createWorkerFailedDetail(): ProcessDetailData {
	const detail = createReasoningOverlayDetail();
	detail.process.selectedTurnId = "generate_plan";
	detail.process.lifecycleStatus = "error";
	detail.process.currentExecution = null;
	detail.actions = [];
	detail.selectedTurn = {
		turnId: "generate_plan",
		kind: "llm",
		description: "Generate plan",
		commentary: null,
		externalTriggers: [],
	};
	detail.events = [
		{
			id: "evt_worker_failed",
			instanceId: detail.process.id,
			eventType: "worker_failed",
			data: {
				message: "Worker timed out during startup",
				errorCode: "startup_timeout",
				errorClass: "infrastructure",
				selectedTurnId: "generate_plan",
			},
			createdAt: "2026-01-01T00:04:45Z",
		},
	];
	return detail;
}

function createContinuableFailedDetailWithUserContinuationLeaf(): ProcessDetailData {
	const detail = createContinuableFailedDetail();
	detail.turnRecords[1] = {
		...detail.turnRecords[1],
		resultPiEntryId: "user-continue-2",
		endedAt: "2026-01-01T00:04:32Z",
	};
	detail.piSessionEntries = [
		...detail.piSessionEntries,
		{
			type: "message",
			id: "user-continue-2",
			parentId: "assistant-fix",
			timestamp: "2026-01-01T00:04:31Z",
			message: {
				role: "user",
				content: "Continue from this exact branch and keep the previous tool choice.",
			},
		},
	];
	return detail;
}

function createContinuableFailedDetailWithPostFailureUserContinuationLeaf(): ProcessDetailData {
	const detail = createContinuableFailedDetail();
	detail.turnRecords[1] = {
		...detail.turnRecords[1],
		resultPiEntryId: "assistant-fix",
		endedAt: "2026-01-01T00:04:30Z",
	};
	detail.piSessionEntries = [
		...detail.piSessionEntries,
		{
			type: "message",
			id: "user-continue-after-failure",
			parentId: "assistant-fix",
			timestamp: "2026-01-01T00:04:31Z",
			message: {
				role: "user",
				content: "This later retry instruction should not be reused.",
			},
		},
	];
	return detail;
}

function createPreStreamingActiveDetail(): ProcessDetailData {
	const detail = createProcessDetail();
	detail.process.lifecycleStatus = "active";
	detail.process.selectedTurnId = "generate_plan";
	detail.process.currentExecution = null;
	detail.turnRecords = [];
	detail.piSessionEntries = [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Ship the requested change",
			},
		},
	];
	detail.primaryPath.primaryPathEntries = [
		detail.piSessionEntries[0] as PrimaryPathSnapshot["primaryPathEntries"][number],
	];
	detail.primaryPath.currentLeaf = { entryId: "root-user", turnRecordId: null };
	detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "root-user",
		turnRecordId: null,
	};
	detail.primaryPath.turnState = {
		currentTurnRecordId: null,
		workerState: "busy",
		isStreaming: false,
		activeTurn: null,
	};
	return detail;
}

function createLiveReasoningTransitionDetail(): ProcessDetailData {
	const detail = createProcessDetail();
	detail.process.lifecycleStatus = "active";
	detail.process.currentExecution = { kind: "worker_start", id: "tsr_live" };
	detail.turnRecords = [
		{
			id: "trn_live",
			instanceId: "agt_1",
			turnId: "generate_plan",
			turnType: "llm",
			status: "running",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: null,
			modelProfileId: "claude-sonnet-4",
			turnResultMarkdown: null,
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:01:00Z",
			endedAt: null,
		},
	];
	detail.piSessionEntries = [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Ship the requested change",
			},
		},
	];
	detail.primaryPath.primaryPathEntries = [
		detail.piSessionEntries[0] as PrimaryPathSnapshot["primaryPathEntries"][number],
	];
	detail.primaryPath.currentLeaf = { entryId: "root-user", turnRecordId: null };
	detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "root-user",
		turnRecordId: null,
	};
	detail.primaryPath.turnState = {
		currentTurnRecordId: "trn_live",
		workerState: "busy",
		isStreaming: true,
		activeTurn: {
			turnRecordId: "trn_live",
			turnId: "generate_plan",
			turnType: "llm",
			pathType: "primary",
			startedAt: "2026-01-01T00:01:00Z",
			assistant: {
				text: "",
				thinking: "Keep this live reasoning intact.\nNothing should disappear after commit.",
				lastUpdatedAt: "2026-01-01T00:01:10Z",
			},
			toolCalls: [],
			traceItems: [
				{
					kind: "thinking",
					text: "Keep this live reasoning intact.\nNothing should disappear after commit.",
				},
			],
			usage: {
				input: 220,
				output: 80,
				cacheRead: 400,
				cacheWrite: 40,
				totalTokens: 740,
				cost: {
					input: 0.0044,
					output: 0.0048,
					cacheRead: 0.004,
					cacheWrite: 0.0016,
					total: 0.0148,
				},
			},
			eventWindowTruncated: false,
		},
	};
	return detail;
}

function createQuestionRequestDetail(): ProcessDetailData {
	const detail = createLiveReasoningTransitionDetail();
	detail.questionRequests = [
		createTestQuestionRequest({ turnRecordId: "trn_live", askedAt: "2026-01-01T00:01:15Z" }),
	];
	return detail;
}

function createCommittedReasoningTransitionDetail(): ProcessDetailData {
	const detail = createProcessDetail();
	detail.turnRecords = [
		{
			id: "trn_live",
			instanceId: "agt_1",
			turnId: "generate_plan",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-final",
			modelProfileId: "claude-sonnet-4",
			turnResultMarkdown: "## Plan\n\nCommitted answer",
			errorSummary: null,
			errorClass: null,
			startedAt: "2026-01-01T00:01:00Z",
			endedAt: "2026-01-01T00:02:00Z",
		},
	];
	detail.piSessionEntries = [
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Ship the requested change",
			},
		},
		{
			type: "message",
			id: "assistant-final",
			parentId: "root-user",
			timestamp: "2026-01-01T00:02:00Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Keep this live reasoning intact.\nNothing should disappear after commit.",
					},
					{ type: "text", text: "Committed answer" },
				],
				usage: {
					input: 400,
					output: 120,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 520,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
	];
	detail.primaryPath.primaryPathEntries = [
		detail.piSessionEntries[0] as PrimaryPathSnapshot["primaryPathEntries"][number],
		detail.piSessionEntries[1] as PrimaryPathSnapshot["primaryPathEntries"][number],
	];
	detail.primaryPath.currentLeaf = { entryId: "assistant-final", turnRecordId: "trn_live" };
	detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "assistant-final",
		turnRecordId: "trn_live",
	};
	detail.primaryPath.semanticEntryRefs.plan = {
		entryId: "assistant-final",
		turnRecordId: "trn_live",
	};
	detail.primaryPath.turnState = {
		currentTurnRecordId: null,
		workerState: null,
		isStreaming: false,
		activeTurn: null,
	};
	return detail;
}

function createCommittedActionRequiredTransitionDetail(): ProcessDetailData {
	const detail = createCommittedReasoningTransitionDetail();
	detail.actions = [
		{
			id: "approve_plan",
			label: "Approve plan",
			description: "Approve the current result and continue.",
			preview: {
				kind: "turn",
				turnId: "implement_fix",
				turnKind: "llm",
				description: "Implement the next revision",
			},
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
		},
	];
	detail.process.lifecycleStatus = "waiting";
	detail.process.selectedTurnId = "implementation_review";
	detail.selectedTurn = {
		turnId: "implementation_review",
		kind: "human",
		description: "Review implementation",
		commentary: "Choose what should happen after reviewing the implementation.",
		externalTriggers: [],
	};
	return detail;
}

function createActionModelPreview(
	overrides: Partial<ProcessActionModelPreview> = {},
): ProcessActionModelPreview {
	return {
		kind: "llm_turn",
		turnId: "implement_fix",
		description: "Implement the next revision",
		resolvedModel: {
			status: "resolved",
			modelProfileId: "claude-sonnet-4",
			source: "instance_default",
			error: null,
		},
		warmPromptCache: {
			previousModelProfileId: "claude-sonnet-4",
			compatibleModelProfileIds: ["claude-sonnet-4"],
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
		...overrides,
	};
}

function installViewportMetrics(
	element: HTMLDivElement,
	initial: { clientHeight: number; scrollHeight: number },
): {
	getScrollTop: () => number;
	setScrollTop: (value: number) => void;
	setScrollHeight: (value: number) => void;
} {
	const clientHeight = initial.clientHeight;
	let scrollHeight = initial.scrollHeight;
	let scrollTop = 0;
	const clampScrollTop = (value: number) =>
		Math.max(0, Math.min(Number(value), Math.max(scrollHeight - clientHeight, 0)));

	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		get: () => clientHeight,
	});
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		get: () => scrollHeight,
	});
	Object.defineProperty(element, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = clampScrollTop(value);
		},
	});
	Object.defineProperty(element, "scrollTo", {
		configurable: true,
		value: ({ top }: { top?: number }) => {
			scrollTop = clampScrollTop(top ?? 0);
		},
	});

	return {
		getScrollTop: () => scrollTop,
		setScrollTop: (value: number) => {
			scrollTop = clampScrollTop(value);
		},
		setScrollHeight: (value: number) => {
			scrollHeight = value;
			scrollTop = clampScrollTop(scrollTop);
		},
	};
}

function installElementLayoutMetrics(
	element: HTMLElement,
	layout: { top: number; height: number; offsetParent?: HTMLElement | null },
) {
	Object.defineProperty(element, "offsetTop", {
		configurable: true,
		get: () => layout.top,
	});
	Object.defineProperty(element, "offsetHeight", {
		configurable: true,
		get: () => layout.height,
	});
	if ("offsetParent" in layout) {
		Object.defineProperty(element, "offsetParent", {
			configurable: true,
			get: () => layout.offsetParent ?? null,
		});
	}
}

function installAnchorLayoutMetrics(
	root: HTMLElement,
	layouts: Record<string, { top: number; height: number }>,
) {
	for (const [anchorId, layout] of Object.entries(layouts)) {
		const element = root.querySelector<HTMLElement>(`[data-anchor-id="${anchorId}"]`);
		if (!element) {
			throw new Error(`Expected anchor layout element for ${anchorId}`);
		}
		installElementLayoutMetrics(element, layout);
	}
}

async function installActionChronicleLayout(
	target: HTMLElement,
	viewport: HTMLDivElement,
	actionHeight: number,
) {
	const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
	await flushUi();
	installAnchorLayoutMetrics(target, {
		"chronicle-prompt": { top: 0, height: 180 },
		"chronicle-turn-trn_1": { top: 500, height: 320 },
		"chronicle-turn-trn_2": { top: 1_500, height: 320 },
		"chronicle-action-section": { top: 2_250, height: actionHeight },
	});
	FakeResizeObserver.triggerAll();
	await flushUi();
	return metrics;
}

async function scrollToCompactActionComposer(
	target: HTMLElement,
	viewport: HTMLDivElement,
	metrics: ReturnType<typeof installViewportMetrics>,
) {
	metrics.setScrollTop(1_000);
	viewport.dispatchEvent(new Event("scroll"));
	await flushUi();
	return target.querySelector('[data-section="compact-action-composer"]');
}

async function flushUi(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	for (let i = 0; i < 5; i += 1) {
		if (vi.getTimerCount() > 0) {
			vi.advanceTimersByTime(0);
			await Promise.resolve();
		}
		const callbacks = [...scheduledFrameCallbacks.entries()];
		if (callbacks.length === 0 && vi.getTimerCount() === 0) {
			break;
		}
		scheduledFrameCallbacks = new Map();
		for (const [, callback] of callbacks) {
			callback(Date.now());
		}
		await Promise.resolve();
	}
	await Promise.resolve();
}

async function mountSubjectWithCurrentMocks() {
	mockPostProcessAction.mockReset();
	mockPostProcessRetry.mockReset();
	mockPostProcessTurnContinue.mockReset();
	mockFetchTicketCreationTools.mockReset();
	mockFetchTicketCreationTools.mockResolvedValue([
		{
			name: "tracker_create_issue",
			displayName: "Issue tracker",
			description: "Create a tracked issue",
			parameters: {},
			requiresDestination: true,
		},
	]);
	mockLaunchTicketCreation.mockReset();
	mockFetchTurnReasoningDetail.mockReset();
	mockFetchTurnReasoningDetail.mockImplementation(
		async (requestInstanceId: string, turnRecordId: string) =>
			buildMockReasoningResponse(requestInstanceId, turnRecordId),
	);

	const target = document.createElement("div");
	document.body.appendChild(target);
	const app = mount(ProcessDetailPage, {
		target,
		props: { instanceId: "agt_1" },
	});
	mountedApps.push(app);

	const viewport = target.querySelector<HTMLDivElement>('[data-role="chronicle-scroll"]');
	if (!viewport) {
		throw new Error("Expected chronicle viewport to be rendered");
	}

	return {
		target,
		viewport,
	};
}

async function mountSubject(
	detail: ProcessDetailData,
	options: { preserveActionModelPreviewMock?: boolean } = {},
) {
	mockFetchProcessDetail.mockReset();
	mockFetchProcessDetail.mockResolvedValue(detail);
	if (!options.preserveActionModelPreviewMock) {
		mockFetchProcessActionModelPreview.mockReset();
		mockFetchProcessActionModelPreview.mockResolvedValue(createActionModelPreview());
	}
	return mountSubjectWithCurrentMocks();
}

function queryRecoveryAction(
	target: HTMLElement,
	action: "continue-failed-turn" | "retry-failed-turn",
	turnRecordId = "trn_2",
) {
	return target.querySelector<HTMLButtonElement>(
		`[data-action="${action}"][data-turn-record-id="${turnRecordId}"]`,
	);
}

function requireRecoveryAction(
	target: HTMLElement,
	action: "continue-failed-turn" | "retry-failed-turn",
	turnRecordId = "trn_2",
) {
	const button = queryRecoveryAction(target, action, turnRecordId);
	if (!button) {
		throw new Error(`expected ${action} button for ${turnRecordId}`);
	}
	return button;
}

function requireContinuePromptField(target: HTMLElement) {
	const field = target.querySelector<HTMLTextAreaElement>('[data-field="continue-prompt"]');
	if (!field) {
		throw new Error("expected continue prompt field");
	}
	return field;
}

function editContinuePrompt(target: HTMLElement, value: string) {
	const field = requireContinuePromptField(target);
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
	return field;
}

async function clickRecoveryAction(
	target: HTMLElement,
	action: "continue-failed-turn" | "retry-failed-turn",
	turnRecordId = "trn_2",
) {
	requireRecoveryAction(target, action, turnRecordId).click();
	await flushUi();
}

beforeEach(() => {
	vi.useFakeTimers();
	mockWs.set({ status: "disconnected", serverVersion: null, reconnectCount: 0 });
	window.history.replaceState(null, "", "/processes/agt_1");
	window.dispatchEvent(new PopStateEvent("popstate"));
	clearPendingProcessToastFocus();

	let frameId = 0;
	scheduledFrameCallbacks = new Map();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameId;
		scheduledFrameCallbacks.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => {
		scheduledFrameCallbacks.delete(id);
	});
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	vi.stubGlobal("MutationObserver", FakeMutationObserver);
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	for (const app of mountedApps.splice(0)) {
		unmount(app);
	}
	clearPendingProcessToastFocus();
	clearDetail();
	scheduledFrameCallbacks = new Map();
	FakeResizeObserver.reset();
	FakeMutationObserver.reset();
	document.body.innerHTML = "";
	window.history.replaceState(null, "", "/");
	window.dispatchEvent(new PopStateEvent("popstate"));
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("ProcessDetailPage", () => {
	it("renders authoritative startup history and remediation inside the Chronicle", async () => {
		const recovery = {
			startRecordId: "str_failed",
			kind: "bootstrap_failed" as const,
			action: "retry_startup" as const,
			defaultModelProfileId: null,
			providerOptions: {},
			title: "Worker startup failed",
			summary: "Worker timed out while preparing the workspace",
		};
		const detail = compactTestDetail({
			...createProcessDetail(),
			startup: {
				authoritativeAttemptId: null,
				recovery,
				attempts: [
					{
						startRecordId: "str_failed",
						workerLeaseId: "wls_failed",
						status: "failed",
						startedAt: "2026-01-01T00:00:00.000Z",
						readyAt: null,
						durationMs: null,
						summary: recovery.summary,
						recoveredByStartRecordId: null,
						steps: [
							{
								id: "start_worker",
								label: "Start worker",
								status: "completed",
								occurredAt: "2026-01-01T00:00:00.000Z",
							},
							{
								id: "connect_worker",
								label: "Connect worker",
								status: "completed",
								occurredAt: "2026-01-01T00:00:02.000Z",
							},
							{
								id: "prepare_workspace",
								label: "Prepare workspace",
								status: "failed",
								occurredAt: null,
							},
							{
								id: "start_first_turn",
								label: "Start first turn",
								status: "pending",
								occurredAt: null,
							},
						],
					},
				],
			},
			startupRecovery: recovery,
		});

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.querySelector('[data-section="startup-history"]')?.textContent).toContain(
			"Process startup failed",
		);
		expect(target.querySelector('[data-section="startup-recovery"]')?.textContent).toContain(
			"Retry startup",
		);
		expect(target.querySelector('[aria-label="Process startup"]')).toBeNull();
	});

	it("keeps the chronicle pinned to the bottom while the initial layout is still settling", async () => {
		const { viewport } = await mountSubject(createProcessDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 500, scrollHeight: 1_000 });

		await flushUi();
		expect(mockFetchProcessDetail).toHaveBeenCalledWith("agt_1");
		expect(metrics.getScrollTop()).toBe(500);

		metrics.setScrollHeight(1_500);
		FakeResizeObserver.triggerAll();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(1_000);
	});

	it("keeps a followed live tail pinned when earlier chronicle content mutates", async () => {
		const { target, viewport } = await mountSubject(createLiveReasoningTransitionDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 500, scrollHeight: 1_000 });

		await flushUi();
		expect(metrics.getScrollTop()).toBe(500);
		await flushUi();
		await flushUi();

		const prompt = target.querySelector<HTMLElement>('[data-section="chronicle-prompt"]');
		expect(prompt).toBeTruthy();
		metrics.setScrollHeight(1_500);
		prompt?.appendChild(document.createElement("div"));
		FakeResizeObserver.triggerAll();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(1_000);
	});

	it("forces the chronicle back to the bottom when refresh starts from a restored mid-history scroll position", async () => {
		const { viewport } = await mountSubject(createProcessDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 500, scrollHeight: 1_000 });
		metrics.setScrollTop(180);

		await flushUi();
		expect(metrics.getScrollTop()).toBe(500);
	});

	it("renders the process title with a subdued process-name suffix in the page header", async () => {
		const detail = createProcessDetail();
		detail.process.title = "Generate Poem: Germany April 2026 or Cloud Software";
		detail.processDisplayName = "Poem Creator";

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.querySelector(".page-header h1")?.textContent).toBe(
			"Generate Poem: Germany April 2026 or Cloud Software · Poem Creator",
		);
		expect(target.querySelector(".page-header-process-name")?.textContent).toBe("· Poem Creator");
	});

	it("refreshes the page header when a late title update arrives over websocket", async () => {
		const detail = createProcessDetail();
		detail.process.title = null;
		detail.processDisplayName = "Poem Creator";

		const { target } = await mountSubject(detail);
		await flushUi();
		expect(target.querySelector(".page-header h1")?.textContent ?? "").toContain("PROJ-1");
		const refreshedDetail = structuredClone(detail);
		refreshedDetail.process.title = "Recovered title";
		mockFetchProcessDetail.mockResolvedValue(refreshedDetail);

		handleWsEvent(
			createDurableWsFrame({
				type: "process.updated",
				instanceId: "agt_1",
				payload: {
					process: { title: "Recovered title" },
					changedFields: ["title"],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(121);
		await flushUi();

		const headerText = target.querySelector(".page-header h1")?.textContent ?? "";
		expect(headerText).toContain("Recovered title");
		expect(target.querySelector(".page-header-process-name")?.textContent ?? "").toContain(
			"Poem Creator",
		);
	});

	it("moves mobile process navigation and utilities into a dismissible quick-nav sheet", async () => {
		const { target } = await mountSubject(createProcessDetail());
		await flushUi();

		const trigger = target.querySelector<HTMLButtonElement>(
			'[data-action="open-mobile-quick-nav"]',
		);
		expect(trigger?.textContent).toContain("Quick nav");
		expect(target.querySelector('[data-section="mobile-process-quick-nav"]')).toBeNull();

		trigger?.click();
		await flushUi();

		const sheet = target.querySelector<HTMLElement>('[data-section="mobile-process-quick-nav"]');
		expect(sheet?.getAttribute("role")).toBe("dialog");
		expect(sheet?.querySelector('[data-section="turn-rail-list"]')).toBeTruthy();
		expect(sheet?.textContent).toContain("Process info");
		expect(
			sheet?.querySelector<HTMLButtonElement>('[aria-label^="Open actions for"]'),
		).toBeTruthy();

		const promptButton = sheet?.querySelector<HTMLButtonElement>(
			'[data-rail-anchor-id="chronicle-prompt"]',
		);
		expect(promptButton).toBeTruthy();
		promptButton?.click();
		await flushUi();

		expect(target.querySelector('[data-section="mobile-process-quick-nav"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("does not render a leaf-outcome placeholder for processes without a registered leaf outcome", async () => {
		const { target } = await mountSubject(createProcessDetail());

		await flushUi();
		expect(target.querySelector('[data-section="leaf-outcome-placeholder"]')).toBeNull();
	});

	it("stops pinning to the bottom as soon as the operator nudges upward", async () => {
		const { viewport } = await mountSubject(createProcessDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 500, scrollHeight: 1_000 });

		await flushUi();
		expect(metrics.getScrollTop()).toBe(500);
		await flushUi();
		await flushUi();

		metrics.setScrollTop(480);
		viewport.dispatchEvent(new Event("scroll"));

		metrics.setScrollHeight(1_500);
		FakeResizeObserver.triggerAll();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(480);
	});

	it("renders the prompt first and exposes process info in the header overlay", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
		const detail = createProcessDetail();
		detail.process.processId = "single_prompt_external_complete_process";
		detail.process.selectedTurnId = "await_external_prompt_completion";
		detail.process.lifecycleStatus = "waiting";
		detail.events = [
			{
				id: "evt_armed_1",
				instanceId: detail.process.id,
				eventType: "external_source_armed",
				data: {
					armingId: "await_external_prompt_completion:example.file.presence:0",
					kind: "example.file.presence",
					path: "/tmp/complete-prompt",
					pollInterval: "50ms",
				},
				createdAt: "2026-01-01T00:09:30Z",
			},
		];
		detail.selectedTurn = {
			turnId: "await_external_prompt_completion",
			kind: "external",
			description: "Wait for an external completion trigger",
			commentary: null,
			externalTriggers: [
				{
					id: "await_external_prompt_completion:example.file.presence:0",
					kind: "example.file.presence",
					label: "Configured prompt-complete file",
					description:
						"Write any content to the configured prompt-complete trigger file (default: /tmp/complete-prompt) to complete the process.",
				},
			],
		};
		detail.process.initialDefaultModelProfileId = "gpt-5.5-medium";
		detail.modelConfiguration = {
			...detail.modelConfiguration,
			defaultModel: {
				processConfigModelProfileId: "deepseek-v4-pro-xhigh",
				instanceModelProfileId: null,
				effectiveModelProfileId: "deepseek-v4-pro-xhigh",
				source: "process_config",
			},
			turns: [
				{
					turnId: "generate_plan",
					description: "Generate plan",
					pathType: "primary",
					processConfigModelProfileId: null,
					instanceModelProfileId: null,
					effectiveConfiguredModelProfileId: null,
					source: "default",
				},
			],
		};

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.textContent).toContain("Prompt");
		expect(target.textContent).toContain("Ship the requested change");
		expect(target.textContent).toContain("Wait for an external completion trigger");
		expect(target.textContent).toContain("Configured prompt-complete file");
		expect(target.textContent).toContain("Armed");
		expect(target.textContent).toContain("Listening for this trigger since 30s ago.");
		expect(target.textContent).toContain("Watching /tmp/complete-prompt · polling every 50ms.");
		expect(target.querySelector('[data-section="external-triggers"]')).toBeTruthy();

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		expect(processInfoButton).toBeTruthy();
		processInfoButton?.click();
		await flushUi();

		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();
		const overviewPanel = target.querySelector<HTMLElement>(
			'[data-section="process-info-overview"]',
		);
		expect(overviewPanel?.hidden).toBe(false);

		const turnsTab = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
			(button) => button.textContent?.trim() === "Turns",
		);
		expect(turnsTab).toBeTruthy();
		turnsTab?.click();
		await flushUi();

		const turnsPanel = target.querySelector<HTMLElement>('[data-section="process-info-turns"]');
		expect(turnsPanel?.hidden).toBe(false);
		expect(turnsPanel?.textContent).toContain("Available Pi tools");
		expect(turnsPanel?.textContent).toContain("plan_saved");
		expect(turnsPanel?.textContent).toContain("Short summary of the plan");

		const generatePlanToolHeader = target.querySelector<HTMLElement>(
			'[data-section="process-info-turn-tools"] [data-turn-id="generate_plan"] .turn-tool-header',
		);
		expect(generatePlanToolHeader?.textContent).toContain("deepseek-v4-pro-xhigh");
		expect(generatePlanToolHeader?.textContent).toContain("Configuration file");
		expect(generatePlanToolHeader?.textContent).toContain("Pi: read, bash");
		expect(generatePlanToolHeader?.textContent).toContain("Outcomes: plan_saved");

		const advancedTab = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
			(button) => button.textContent?.trim() === "Advanced",
		);
		expect(advancedTab).toBeTruthy();
		advancedTab?.click();
		await flushUi();

		const advancedPanel = target.querySelector<HTMLElement>(
			'[data-section="process-info-advanced"]',
		);
		expect(advancedPanel?.hidden).toBe(false);
		expect(advancedPanel?.textContent).toContain("System prompt");
		expect(advancedPanel?.textContent).toContain("You are a careful coding assistant.");
		expect(advancedPanel?.textContent).toContain("Launch model");
		expect(advancedPanel?.textContent).toContain("Default at creation");
		expect(advancedPanel?.textContent).toContain("gpt-5.5-medium");
	});

	it("shows launcher config repository settings in the process info overlay", async () => {
		const detail = createProcessDetail();
		detail.process.processId = "local_repo_change_process";
		detail.process.metadata = { launcherId: "local_repo_change_process.ui_launcher" };
		detail.launchConfiguration = {
			launcherId: "local_repo_change_process.ui_launcher",
			launcherLabel: "Local Repo Change",
			launcherSchemaTitle: "Local Repo Change",
			paramsParseError: null,
			parameters: [
				{
					fieldId: "repoLocator",
					label: "Repository path or URL",
					value: "https://git.example.com/team/repo.git",
				},
				{ fieldId: "baseBranch", label: "Base branch", value: "main" },
				{
					fieldId: "workBranch",
					label: "Work branch",
					value: "display-launcher-config-in-process-467-c65d919d0bb3",
				},
			],
			projects: [
				{
					key: "repo",
					repoLocator: "https://git.example.com/team/repo.git",
					repoLocatorKind: "remote_url",
					baseBranch: "main",
					workBranch: "display-launcher-config-in-process-467-c65d919d0bb3",
					externalId: null,
					externalUrl: null,
					pipelineStatus: null,
				},
			],
		};

		const { target } = await mountSubject(detail);
		await flushUi();

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.click();
		await flushUi();

		const launchInputsTab = Array.from(
			target.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
		).find((button) => button.textContent?.trim() === "Launch inputs");
		expect(launchInputsTab).toBeTruthy();
		launchInputsTab?.click();
		await flushUi();

		const launcherConfigSection = target.querySelector<HTMLElement>(
			'[data-section="process-info-launch-config"]',
		);
		expect(launcherConfigSection?.hidden).toBe(false);
		expect(launcherConfigSection?.textContent).toContain("Local Repo Change");
		expect(launcherConfigSection?.textContent).toContain("https://git.example.com/team/repo.git");
		expect(launcherConfigSection?.textContent).toContain("Base branch");
		expect(launcherConfigSection?.textContent).toContain("main");
		expect(launcherConfigSection?.textContent).toContain("Work branch");
		expect(launcherConfigSection?.textContent).toContain(
			"display-launcher-config-in-process-467-c65d919d0bb3",
		);
		expect(launcherConfigSection?.textContent).toContain("Remote URL");
	});

	it("does not warn about blocked saved model configuration on closed processes", async () => {
		const detail = createProcessDetail();
		detail.process.lifecycleStatus = "completed";
		detail.modelConfiguration = {
			...detail.modelConfiguration,
			state: {
				kind: "blocked",
				issues: [{ code: "invalid_turn_configs_json", reason: "invalid_json" }],
			},
		};

		const { target } = await mountSubject(detail);
		await flushUi();
		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.click();
		await flushUi();
		const launchInputsTab = Array.from(
			target.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
		).find((button) => button.textContent?.trim() === "Launch inputs");
		launchInputsTab?.click();
		await flushUi();

		const launcherConfigSection = target.querySelector<HTMLElement>(
			'[data-section="process-info-launch-config"]',
		);
		expect(launcherConfigSection?.textContent).not.toContain(
			"Saved model configuration needs attention",
		);
	});

	it("keeps chronicle current-turn estimates hidden while showing overall process cost in Run info", async () => {
		const detail = createLiveReasoningTransitionDetail();
		detail.turnRecords = [
			{
				id: "trn_done",
				instanceId: "agt_1",
				turnId: "generate_plan",
				turnType: "llm",
				status: "succeeded",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: "assistant-done",
				modelProfileId: "claude-sonnet-4",
				turnResultMarkdown: "## Plan\n\nCommitted answer",
				errorSummary: null,
				errorClass: null,
				startedAt: "2026-01-01T00:00:30Z",
				endedAt: "2026-01-01T00:00:50Z",
			},
			...detail.turnRecords,
		];
		detail.events = [
			{
				id: "evt_usage_done",
				instanceId: detail.process.id,
				eventType: "pi.usage",
				data: {
					turnRecordId: "trn_done",
					input: 500,
					output: 120,
					cacheRead: 100,
					cacheWrite: 0,
					totalTokens: 720,
					cost: {
						input: 0.005,
						output: 0.0024,
						cacheRead: 0.0008,
						cacheWrite: 0,
						total: 0.0082,
					},
				},
				createdAt: "2026-01-01T00:00:50Z",
			},
		];

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.querySelector('[data-section="effective-model-status"]')).toBeNull();
		expect(target.querySelector('[data-section="current-turn-usage-estimate"]')).toBeNull();
		expect(target.textContent).not.toContain("Current turn estimate");
		expect(target.textContent).not.toContain("Estimated spend so far");

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.click();
		await flushUi();

		const usageLine = target.querySelector<HTMLElement>(
			'[data-section="process-info-usage-cost"] .usage-line',
		);
		expect(usageLine?.dataset.completeness).toBe("complete");
		expect(usageLine?.textContent).toContain(formatUsdEstimate(0.023));
		expect(
			target.querySelector<HTMLElement>('[data-field="covered-turn-count"]')?.dataset.value,
		).toBe("2");
	});

	it("builds the overall estimate from committed turn usage when raw diagnostics are sparse", async () => {
		const detail = createReasoningOverlayDetail();
		const planUsage = detail.piSessionEntries.find((entry) => entry.id === "assistant-plan")
			?.message?.usage;
		const implementUsage = detail.piSessionEntries.find((entry) => entry.id === "assistant-fix")
			?.message?.usage;
		if (!planUsage || !implementUsage) {
			throw new Error("Expected committed turn usage in the session tree fixture");
		}
		planUsage.cost = {
			input: 0.5,
			output: 0.25,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.75,
		};
		implementUsage.cost = {
			input: 0.2,
			output: 0.1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.3,
		};
		detail.events = [
			{
				id: "evt_usage_sparse",
				instanceId: detail.process.id,
				eventType: "pi.usage",
				data: {
					turnRecordId: "trn_1",
					input: 5,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 6,
					cost: {
						input: 0.006,
						output: 0.004,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.01,
					},
				},
				createdAt: "2026-01-01T00:01:05Z",
			},
		];

		const { target } = await mountSubject(detail);
		await flushUi();

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.click();
		await flushUi();

		const usageLine = target.querySelector<HTMLElement>(
			'[data-section="process-info-usage-cost"] .usage-line',
		);
		expect(usageLine?.dataset.completeness).toBe("complete");
		expect(usageLine?.textContent).toContain(formatUsdEstimate(1.05));
		expect(usageLine?.textContent).not.toContain(formatUsdEstimate(0.01));
		expect(
			target.querySelector<HTMLElement>('[data-field="covered-turn-count"]')?.dataset.value,
		).toBe("2");
		expect(target.querySelector('[data-field="missing-usage-turn-count"]')).toBeNull();
	});

	it("marks the process total as partial when some llm turns are missing telemetry", async () => {
		const detail = createLiveReasoningTransitionDetail();
		detail.turnRecords = [
			{
				id: "trn_done",
				instanceId: "agt_1",
				turnId: "generate_plan",
				turnType: "llm",
				status: "succeeded",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: "assistant-done",
				modelProfileId: "claude-sonnet-4",
				turnResultMarkdown: "## Plan\n\nCommitted answer",
				errorSummary: null,
				errorClass: null,
				startedAt: "2026-01-01T00:00:30Z",
				endedAt: "2026-01-01T00:00:50Z",
			},
			{
				id: "trn_missing",
				instanceId: "agt_1",
				turnId: "generate_plan",
				turnType: "llm",
				status: "failed",
				attemptNumber: 2,
				parentTurnRecordId: "trn_done",
				pathType: "primary",
				forkPiEntryId: "assistant-done",
				resultPiEntryId: null,
				modelProfileId: "claude-sonnet-4",
				turnResultMarkdown: null,
				errorSummary: "Missing usage",
				errorClass: null,
				startedAt: "2026-01-01T00:01:00Z",
				endedAt: "2026-01-01T00:01:30Z",
			},
		];
		detail.process.currentExecution = null;
		detail.primaryPath.turnState = {
			currentTurnRecordId: null,
			workerState: null,
			isStreaming: false,
			activeTurn: null,
		};
		detail.events = [
			{
				id: "evt_usage_done",
				instanceId: detail.process.id,
				eventType: "pi.usage",
				data: {
					turnRecordId: "trn_done",
					input: 500,
					output: 120,
					cacheRead: 100,
					cacheWrite: 0,
					totalTokens: 720,
					cost: {
						input: 0.005,
						output: 0.0024,
						cacheRead: 0.0008,
						cacheWrite: 0,
						total: 0.0082,
					},
				},
				createdAt: "2026-01-01T00:00:50Z",
			},
		];

		const { target } = await mountSubject(detail);
		await flushUi();

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.click();
		await flushUi();

		const usageLine = target.querySelector<HTMLElement>(
			'[data-section="process-info-usage-cost"] .usage-line',
		);
		expect(usageLine?.dataset.completeness).toBe("partial");
		expect(usageLine?.textContent).toContain(formatUsdEstimate(0.0082));
		expect(
			target.querySelector<HTMLElement>('[data-field="covered-turn-count"]')?.dataset.value,
		).toBe("1");
		expect(
			target.querySelector<HTMLElement>('[data-field="missing-usage-turn-count"]')?.dataset.value,
		).toBe("1");
	});

	it("uses the committed session tree user message for the displayed prompt", async () => {
		const detail = createProcessDetail();
		detail.primaryPath.primaryPathEntries[0] = {
			...detail.primaryPath.primaryPathEntries[0],
			message: {
				role: "user",
				content: "Wrong prompt from primary-path entries",
			},
		};
		detail.piSessionEntries = [
			{
				type: "message",
				id: "root-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "user",
					content: "Correct prompt from the committed session tree",
				},
			},
			{
				type: "message",
				id: "assistant-plan",
				parentId: "root-user",
				timestamp: "2026-01-01T00:02:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Committed answer" }],
				},
			},
		];
		detail.primaryPath.currentLeaf = { entryId: "assistant-plan", turnRecordId: "trn_1" };
		detail.primaryPath.semanticEntryRefs.currentPrimaryPathLeaf = {
			entryId: "assistant-plan",
			turnRecordId: "trn_1",
		};

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.textContent).toContain("Correct prompt from the committed session tree");
		expect(target.textContent).not.toContain("Wrong prompt from primary-path entries");
	});

	it("keeps live reasoning content intact after the turn is committed", async () => {
		const { target } = await mountSubject(createLiveReasoningTransitionDetail());
		await flushUi();

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();
		expect(target.textContent).toContain("Keep this live reasoning intact.");
		expect(target.textContent).toContain("Nothing should disappear after commit.");
		expect(target.querySelector('[data-section="live-tail"]')).toBeTruthy();

		detailState.set({
			data: compactTestDetail(createCommittedReasoningTransitionDetail()),
			loading: false,
			error: null,
			loadedAtMs: Date.now(),
		});
		await flushUi();

		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();
		expect(target.textContent).toContain("Keep this live reasoning intact.");
		expect(target.textContent).toContain("Nothing should disappear after commit.");
		expect(target.querySelector('[data-section="live-tail"]')).toBeNull();
		expect(target.querySelector('[data-section="chronicle-turn"]')).toBeTruthy();
	});

	it("reloads only when the websocket reconnect count changes", async () => {
		await mountSubject(createProcessDetail());
		await flushUi();

		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(1);

		mockWs.set({ status: "connected", serverVersion: null, reconnectCount: 0 });
		await flushUi();
		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(1);

		mockWs.set({ status: "disconnected", serverVersion: null, reconnectCount: 0 });
		await flushUi();
		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(1);

		mockWs.set({ status: "connected", serverVersion: null, reconnectCount: 1 });
		await flushUi();
		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(2);
	});

	it("retries the detail load when live-turn metadata arrives before the first detail response resolves", async () => {
		const pendingInitialDetail = createDeferred<ProcessDetailData>();
		let fetchCallCount = 0;
		mockFetchProcessDetail.mockReset();
		mockFetchProcessDetail.mockImplementation(async () => {
			fetchCallCount += 1;
			if (fetchCallCount === 1) {
				return await pendingInitialDetail.promise;
			}
			return createLiveReasoningTransitionDetail();
		});

		const { target } = await mountSubjectWithCurrentMocks();
		await flushUi();

		handleWsEvent(
			createDurableWsFrame({
				type: "process.updated",
				instanceId: "agt_1",
				payload: {
					process: { currentExecution: { kind: "worker_start", id: "tsr_live" } },
					changedFields: ["currentExecution"],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(121);
		await flushUi();

		pendingInitialDetail.resolve(createPreStreamingActiveDetail());
		await flushUi();
		await flushUi();

		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(2);
		expect(target.querySelector('[data-section="live-tail"]')).toBeTruthy();
	});

	it("keeps the empty chronicle state when no prompt or turns are present", async () => {
		const detail = createProcessDetail();
		detail.turnRecords = [];
		detail.primaryPath = createEmptyPrimaryPathSnapshot();

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.querySelector('[data-section="chronicle-prompt"]')).toBeNull();
		expect(target.querySelector('[data-section="chronicle-empty-state"]')).toBeTruthy();
		expect(target.textContent).toContain("This process has not recorded activity yet.");
		expect(target.textContent).toContain("Completed");
	});

	it("renders recovery controls for the current failed llm turn and reloads after continuing", async () => {
		mockPostProcessTurnContinue.mockResolvedValue(undefined);
		const { target } = await mountSubject(createContinuableFailedDetail());
		await flushUi();

		expect(target.querySelector('[data-section="current-turn-recovery"]')).toBeTruthy();
		expect(queryRecoveryAction(target, "continue-failed-turn")).toBeTruthy();

		await clickRecoveryAction(target, "continue-failed-turn");

		expect(mockPostProcessTurnContinue).toHaveBeenCalledWith(
			"agt_1",
			"trn_2",
			"continue",
			undefined,
			undefined,
		);
		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(2);
	});

	it("pre-fills the continue prompt from the latest failed user continuation leaf when one exists", async () => {
		mockPostProcessTurnContinue.mockResolvedValue(undefined);
		const { target } = await mountSubject(createContinuableFailedDetailWithUserContinuationLeaf());
		await flushUi();

		expect(requireContinuePromptField(target).value).toBe(DEFAULT_CONTINUE_PROMPT);

		await clickRecoveryAction(target, "continue-failed-turn");

		expect(mockPostProcessTurnContinue).toHaveBeenCalledWith(
			"agt_1",
			"trn_2",
			DEFAULT_CONTINUE_PROMPT,
			undefined,
			undefined,
		);
	});

	it("does not pre-fill the continue prompt from user leaves written after the failed turn ended", async () => {
		const { target } = await mountSubject(
			createContinuableFailedDetailWithPostFailureUserContinuationLeaf(),
		);
		await flushUi();

		expect(requireContinuePromptField(target).value).toBe(DEFAULT_CONTINUE_PROMPT);
	});

	it("pre-fills an editable continue prompt from recovery metadata and submits operator edits", async () => {
		mockPostProcessTurnContinue.mockResolvedValue(undefined);
		const detail = createContinuableFailedDetail();
		detail.recovery = createFailedTurnRecovery("trn_2", {
			defaultContinuePrompt: "Call markdown_result now with the final summary.",
		});
		const { target } = await mountSubject(detail);
		await flushUi();

		expect(requireContinuePromptField(target).value).toBe(
			"Call markdown_result now with the final summary.",
		);
		editContinuePrompt(target, "Please call markdown_result with the final summary and stop.");
		await flushUi();

		await clickRecoveryAction(target, "continue-failed-turn");

		expect(mockPostProcessTurnContinue).toHaveBeenCalledWith(
			"agt_1",
			"trn_2",
			"Please call markdown_result with the final summary and stop.",
			undefined,
			undefined,
		);
	});

	it("preserves continue prompt edits when new timeline items arrive", async () => {
		mockPostProcessTurnContinue.mockResolvedValue(undefined);
		const { target } = await mountSubject(createContinuableFailedDetail());
		await flushUi();

		editContinuePrompt(target, "Use the logs from the latest operator note before continuing.");
		await flushUi();

		detailState.update((state) => {
			if (!state.data) {
				return state;
			}
			const operatorInput: ProcessDetailData["timeline"]["inputs"][number] = {
				id: "inp_late_operator_note",
				sequence: 99,
				source: "app_steer",
				kind: "instruction",
				bodyMarkdown: "Extra context arrived while editing the recovery prompt.",
				receivedAt: "2026-01-01T00:05:00Z",
				consumedAt: null,
			};
			return {
				...state,
				data: {
					...state.data,
					timeline: {
						...state.data.timeline,
						inputs: [...state.data.timeline.inputs, operatorInput],
					},
				},
			};
		});
		await flushUi();

		expect(requireContinuePromptField(target).value).toBe(
			"Use the logs from the latest operator note before continuing.",
		);

		await clickRecoveryAction(target, "continue-failed-turn");

		expect(mockPostProcessTurnContinue).toHaveBeenCalledWith(
			"agt_1",
			"trn_2",
			"Use the logs from the latest operator note before continuing.",
			undefined,
			undefined,
		);
	});

	it("pre-fills the continue prompt from a previously scheduled continue", async () => {
		mockPostProcessTurnContinue.mockResolvedValue(undefined);
		const detail = createContinuableFailedDetail();
		detail.recovery = createFailedTurnRecovery("trn_2", {
			defaultContinuePrompt: "Use the operator-approved prompt.",
		});
		const { target } = await mountSubject(detail);
		await flushUi();

		expect(requireContinuePromptField(target).value).toBe("Use the operator-approved prompt.");
		await clickRecoveryAction(target, "continue-failed-turn");

		expect(mockPostProcessTurnContinue).toHaveBeenCalledWith(
			"agt_1",
			"trn_2",
			"Use the operator-approved prompt.",
			undefined,
			undefined,
		);
	});

	it("renders Retry without model controls for a failed automatic turn", async () => {
		mockPostProcessRetry.mockResolvedValue(undefined);
		const detail = createContinuableFailedDetail();
		detail.recovery = createFailedTurnRecovery("trn_2", {
			canContinue: false,
			supportsModelOverride: false,
		});
		const { target } = await mountSubject(detail);
		await flushUi();

		expect(queryRecoveryAction(target, "retry-failed-turn")?.textContent?.trim()).toBe(
			"Retry failed turn",
		);
		expect(target.querySelector('[data-field="recovery-model"]')).toBeNull();

		await clickRecoveryAction(target, "retry-failed-turn");
		expect(mockPostProcessRetry).toHaveBeenCalledWith("agt_1", undefined, undefined);
	});

	it("renders Retry for the current failed llm turn and reloads after retrying", async () => {
		mockPostProcessRetry.mockResolvedValue(undefined);
		const { target } = await mountSubject(createContinuableFailedDetail());
		await flushUi();

		expect(queryRecoveryAction(target, "retry-failed-turn")).toBeTruthy();

		await clickRecoveryAction(target, "retry-failed-turn");

		expect(mockPostProcessRetry).toHaveBeenCalledWith("agt_1", undefined, undefined);
		expect(mockFetchProcessDetail).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			"the failed llm turn has no saved progress",
			(detail: LegacyProcessDetailTestData) => {
				if (!detail.recovery) throw new Error("Expected failed-turn recovery");
				detail.recovery = { ...detail.recovery, canContinue: false };
			},
		],
		[
			"the recovery summary says continuation is unavailable",
			(detail: LegacyProcessDetailTestData) => {
				if (!detail.recovery) throw new Error("Expected failed-turn recovery");
				detail.recovery = { ...detail.recovery, canContinue: false };
			},
		],
	] as const)("does not render Continue when %s", async (_name, mutateDetail) => {
		const detail = createContinuableFailedDetail();
		mutateDetail(detail);

		const { target } = await mountSubject(detail);
		await flushUi();

		expect(target.querySelector('[data-section="current-turn-recovery"]')).toBeTruthy();
		expect(queryRecoveryAction(target, "continue-failed-turn")).toBeNull();
		expect(queryRecoveryAction(target, "retry-failed-turn")).toBeTruthy();
	});

	it("shows both the failed turn and the recovery rail item", async () => {
		const { target } = await mountSubject(createContinuableFailedDetail());
		await flushUi();

		const failedTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-kind="turn"][data-turn-record-id="trn_2"]',
		);
		const recoveryButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"][data-rail-tone="error_recovery"]',
		);
		expect(failedTurnButton).toBeTruthy();
		expect(recoveryButton).toBeTruthy();
		expect(failedTurnButton?.querySelector(".rail-marker")?.textContent?.trim()).toBe("2");
		expect(recoveryButton?.querySelector(".rail-title")?.textContent).toContain("Implement Fix");
	});

	it("renders recovery after the latest failed turn even when an older leaf outcome exists", async () => {
		const { target } = await mountSubject(createContinuableFailedDetailWithHistoricalLeafOutcome());
		await flushUi();

		const leafOutcome = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome"][data-snapshot-id="los_patch"]',
		);
		const failedTurn = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_3"]',
		);
		const recoverySection = target.querySelector<HTMLElement>(
			'[data-section="current-turn-recovery"]',
		);
		expect(leafOutcome).toBeTruthy();
		expect(failedTurn).toBeTruthy();
		expect(recoverySection).toBeTruthy();
		if (!leafOutcome || !failedTurn || !recoverySection) {
			throw new Error("Expected leaf outcome, failed turn, and recovery section");
		}
		expect(leafOutcome.compareDocumentPosition(failedTurn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(failedTurn.compareDocumentPosition(recoverySection)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it("opens the latest failed-turn reasoning from the recovery rail item", async () => {
		const { target, viewport } = await mountSubject(createContinuableFailedDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 2_250, height: 180 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const recoveryButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-tone="error_recovery"]',
		);
		expect(recoveryButton).toBeTruthy();
		recoveryButton?.click();
		await flushUi();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
		await flushUi();

		expect(
			target.querySelector('[role="dialog"][aria-labelledby="reasoning-details-title-trn_2"]'),
		).toBeTruthy();
	});

	it("keeps the failed-turn rail item active while the viewport is focused on the failed turn", async () => {
		const { target, viewport } = await mountSubject(createContinuableFailedDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 4_000 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 3_000, height: 180 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		viewport.scrollTop = 900;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		const failedTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-kind="turn"][data-turn-record-id="trn_2"]',
		);
		const recoveryButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-tone="error_recovery"]',
		);
		const failedTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		const recoverySection = target.querySelector<HTMLElement>(
			'[data-section="current-turn-recovery"]',
		);
		expect(failedTurnButton).toBeTruthy();
		expect(recoveryButton).toBeTruthy();
		expect(failedTurnSection).toBeTruthy();
		expect(recoverySection).toBeTruthy();
		expect(failedTurnButton?.dataset.active).toBe("true");
		expect(recoveryButton?.dataset.active).toBe("false");
		expect(failedTurnSection?.dataset.focused).toBe("true");
		expect(recoverySection?.dataset.focused).toBe("false");
	});

	it("does not steal focus when a question request arrives passively", async () => {
		const { target } = await mountSubject(createQuestionRequestDetail());
		await flushUi();

		const request = target.querySelector<HTMLElement>("[data-question-request-id='qst_1']");
		expect(request).toBeTruthy();
		expect(request?.contains(document.activeElement)).toBe(false);
	});

	it("focuses a question only after the operator opens its toast", async () => {
		const { target, viewport } = await mountSubject(createQuestionRequestDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		const request = target.querySelector<HTMLElement>("[data-question-request-id='qst_1']");
		expect(request).toBeTruthy();
		if (!request) return;
		installElementLayoutMetrics(request, { top: 1_700, height: 500, offsetParent: viewport });

		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "question_request", requestId: "qst_1" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		await flushUi();

		expect(request.contains(document.activeElement)).toBe(true);
	});

	it("focuses the action section when opened from an action-required toast", async () => {
		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "action_required" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		const { target, viewport } = await mountSubject(createActionRequiredDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 2_300, height: 100 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"]',
		);
		const actionSection = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome-actions"]',
		);
		expect(actionButton).toBeTruthy();
		expect(actionSection).toBeTruthy();
		expect(actionButton?.dataset.active).toBe("true");
		expect(actionSection?.dataset.focused).toBe("true");
	});

	it("focuses the failed step when opened from a failure toast", async () => {
		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "turn_failed" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		const { target, viewport } = await mountSubject(createContinuableFailedDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 4_000 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 3_000, height: 180 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const failedTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-kind="turn"][data-turn-record-id="trn_2"]',
		);
		const recoveryButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-tone="error_recovery"]',
		);
		const failedTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		expect(failedTurnButton).toBeTruthy();
		expect(recoveryButton).toBeTruthy();
		expect(failedTurnSection).toBeTruthy();
		expect(failedTurnButton?.dataset.active).toBe("true");
		expect(recoveryButton?.dataset.active).toBe("false");
		expect(failedTurnSection?.dataset.focused).toBe("true");
	});

	it("focuses the process error section when opened from a worker-failure toast", async () => {
		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "worker_failed" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		const { target, viewport } = await mountSubject(createWorkerFailedDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 3_000 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-process-error-section": { top: 2_300, height: 180 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const processErrorButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"][data-rail-tone="error_recovery"]',
		);
		const processErrorSection = target.querySelector<HTMLElement>(
			'[data-section="current-process-error"]',
		);
		expect(processErrorButton).toBeTruthy();
		expect(processErrorSection).toBeTruthy();
		expect(processErrorButton?.dataset.active).toBe("true");
		expect(processErrorSection?.dataset.focused).toBe("true");
	});

	it("closes the process info overlay before applying action-required toast focus", async () => {
		const { target, viewport } = await mountSubject(createActionRequiredDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 2_300, height: 100 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		expect(processInfoButton).toBeTruthy();
		processInfoButton?.click();
		await flushUi();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();

		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "action_required" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		await flushUi();

		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"]',
		);
		const actionSection = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome-actions"]',
		);
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect(actionButton?.dataset.active).toBe("true");
		expect(actionSection?.dataset.focused).toBe("true");
	});

	it("closes the reasoning overlay before applying failed-step toast focus", async () => {
		const { target, viewport } = await mountSubject(createContinuableFailedDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 4_000 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 3_000, height: 180 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		expect(detailButtons.length).toBeGreaterThan(0);
		detailButtons[detailButtons.length - 1]?.click();
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();

		queuePendingProcessToastFocus({
			instanceId: "agt_1",
			target: { kind: "turn_failed" },
			queuedAt: "2026-01-01T00:05:00Z",
		});
		await flushUi();

		const failedTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-rail-kind="turn"][data-turn-record-id="trn_2"]',
		);
		const failedTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
		expect(failedTurnButton?.dataset.active).toBe("true");
		expect(failedTurnSection?.dataset.focused).toBe("true");
	});

	it("lets arrow navigation move between the latest turn and the action-required rail item", async () => {
		const { target, viewport } = await mountSubject(createActionRequiredDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 2_300, height: 100 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"]',
		);
		const actionSection = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome-actions"]',
		);
		const lastTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		expect(lastTurnButton).toBeTruthy();
		expect(actionButton).toBeTruthy();
		expect(actionSection).toBeTruthy();
		expect(lastTurnSection).toBeTruthy();
		expect(actionButton?.dataset.active).toBe("true");
		expect(lastTurnButton?.dataset.active).toBe("false");
		expect(actionSection?.dataset.focused).toBe("true");
		expect(lastTurnSection?.dataset.focused).toBe("false");

		actionButton?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
		);
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("true");
		expect(actionButton?.dataset.active).toBe("false");
		expect(actionSection?.dataset.focused).toBe("false");
		expect(lastTurnSection?.dataset.focused).toBe("true");

		lastTurnButton?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
		);
		await flushUi();
		expect(actionButton?.dataset.active).toBe("true");
		expect(lastTurnButton?.dataset.active).toBe("false");
		expect(actionSection?.dataset.focused).toBe("true");
		expect(lastTurnSection?.dataset.focused).toBe("false");
	});

	it("renders scheduled-action detail in the turn rail", async () => {
		const { target } = await mountSubject(createScheduledActionRailDetail());
		await flushUi();

		const scheduledButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"][data-rail-tone="scheduled_action"]',
		);
		const detail = scheduledButton?.querySelector<HTMLElement>(".rail-detail");
		expect(scheduledButton).toBeTruthy();
		expect(detail).toBeTruthy();
		expect(detail?.textContent).toContain("Approve patch");
		expect(detail?.textContent).toContain("Implement the next revision");
	});

	it("shows the policy block and lock copy for a blocked scheduled action", async () => {
		const { target } = await mountSubject(createBlockedScheduledActionRailDetail());
		await flushUi();

		const section = target.querySelector('[data-section="scheduled-action"]');
		expect(section?.textContent).toContain("Blocked — The selected model is unavailable");
		expect(section?.textContent).toContain(
			"This process remains locked while the scheduled action is blocked or until it is canceled.",
		);
	});

	it("keeps the compact action composer beside the result until the detailed form is in view", async () => {
		const { target, viewport } = await mountSubject(createActionRequiredDetail());
		const metrics = await installActionChronicleLayout(target, viewport, 1_200);

		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();

		const actionForm = target.querySelector<HTMLElement>(
			'form[data-action-form-id="approve_patch"]',
		);
		expect(actionForm).toBeTruthy();
		if (!actionForm) {
			throw new Error("Expected an open action form");
		}
		installElementLayoutMetrics(actionForm, { top: 2_300, height: 1_000, offsetParent: viewport });
		metrics.setScrollHeight(3_600);
		metrics.setScrollTop(1_500);
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		expect(target.querySelector('[data-section="compact-action-composer"]')).toBeNull();

		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();
	});

	it("preserves the canonical compact selection and primary prompt across scroll unmounts", async () => {
		const detail = createActionRequiredDetailWithMultipleActions();
		const approve = detail.actions[0];
		const revise = detail.actions[1];
		if (!approve || !revise) throw new Error("Expected two actions");
		setSingleTextareaActionForm(approve, "Approval notes", {
			formId: "approve",
			primaryPrompt: true,
		});
		setSingleTextareaActionForm(revise, "Revision notes", {
			formId: "revise",
			primaryPrompt: true,
		});

		const { target, viewport } = await mountSubject(detail);
		const metrics = await installActionChronicleLayout(target, viewport, 500);
		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();

		let choice = target.querySelector<HTMLSelectElement>("#compact-action-choice");
		expect(choice?.value).toBe("approve_patch");
		if (!choice) throw new Error("Expected compact action choice");
		choice.value = "request_revision";
		choice.dispatchEvent(new Event("change", { bubbles: true }));
		await flushUi();
		const textarea = target.querySelector<HTMLTextAreaElement>(
			'[data-section="compact-action-composer"] textarea',
		);
		if (!textarea) throw new Error("Expected compact primary prompt");
		textarea.value = "Keep the rollout smaller.";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await flushUi();

		metrics.setScrollTop(1_500);
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();
		expect(target.querySelector('[data-section="compact-action-composer"]')).toBeNull();

		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();
		choice = target.querySelector<HTMLSelectElement>("#compact-action-choice");
		expect(choice?.value).toBe("request_revision");
		expect(
			target.querySelector<HTMLTextAreaElement>('[data-section="compact-action-composer"] textarea')
				?.value,
		).toBe("Keep the rollout smaller.");
	});

	it("clears compact validation when a refresh reconciles to another action", async () => {
		const detail = createActionRequiredDetailWithMultipleActions();
		const approve = detail.actions[0];
		const revise = detail.actions[1];
		if (!approve || !revise) throw new Error("Expected two actions");
		setSingleTextareaActionForm(approve, "Approval notes", {
			formId: "approve",
			required: true,
		});
		setSingleTextareaActionForm(revise, "Revision notes", {
			formId: "revise",
			required: true,
		});

		const { target, viewport } = await mountSubject(detail);
		const metrics = await installActionChronicleLayout(target, viewport, 500);
		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();
		target
			.querySelector<HTMLFormElement>('[data-section="compact-action-composer"] form')
			?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await flushUi();
		expect(
			target.querySelector('[data-section="compact-action-composer"] [role="alert"]')?.textContent,
		).toContain("Approval notes is required.");

		const refreshedDetail = structuredClone(detail);
		refreshedDetail.actions = [structuredClone(revise)];
		refreshedDetail.process.title = "Refreshed action selection";
		mockFetchProcessDetail.mockResolvedValue(refreshedDetail);
		handleWsEvent(
			createDurableWsFrame({
				type: "process.updated",
				instanceId: "agt_1",
				payload: {
					process: { title: "Refreshed action selection" },
					changedFields: ["title"],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(121);
		await flushUi();

		expect(target.querySelector<HTMLSelectElement>("#compact-action-choice")?.value).toBe(
			"request_revision",
		);
		expect(
			target.querySelector('[data-section="compact-action-composer"] [role="alert"]'),
		).toBeNull();
		expect(
			target
				.querySelector<HTMLTextAreaElement>('[data-section="compact-action-composer"] textarea')
				?.getAttribute("aria-invalid"),
		).toBeNull();
	});

	it("uses the shared 24-hour picker when scheduling a live action", async () => {
		vi.setSystemTime(new Date(2026, 3, 24, 18, 45, 0, 0));
		const { target } = await mountSubject(createActionRequiredDetail());
		await flushUi();

		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();
		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="schedule-approve_patch"]',
		);
		scheduleRadios[1]?.click();
		await flushUi();

		const picker = target.querySelector<HTMLElement>(
			'[data-section="action-schedule-once-picker"]',
		);
		const dateInput = target.querySelector<HTMLInputElement>(
			"#process-action-approve_patch-__schedule-run-at",
		);
		const hourSelect = target.querySelector<HTMLSelectElement>(
			"#process-action-approve_patch-__schedule-run-at-hour",
		);
		const minuteSelect = target.querySelector<HTMLSelectElement>(
			"#process-action-approve_patch-__schedule-run-at-minute",
		);

		expect(picker?.dataset.timeFormat).toBe("24-hour");
		expect(target.querySelector('input[type="datetime-local"]')).toBeNull();
		expect(hourSelect?.options[1]?.value).toBe("00");
		expect(hourSelect?.options[24]?.value).toBe("23");
		expect(dateInput?.value).toBe("2026-04-24");
		expect(hourSelect?.value).toBe("18");
		expect(minuteSelect?.value).toBe("45");

		if (!dateInput || !hourSelect || !minuteSelect) {
			throw new Error("Expected scheduled action picker controls");
		}
		dateInput.value = "2026-04-24";
		dateInput.dispatchEvent(new Event("input", { bubbles: true }));
		hourSelect.value = "18";
		hourSelect.dispatchEvent(new Event("change", { bubbles: true }));
		minuteSelect.value = "45";
		minuteSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flushUi();

		target
			.querySelector<HTMLButtonElement>(
				'form[data-action-form-id="approve_patch"] button[type="submit"]',
			)
			?.click();
		await flushUi();

		expect(mockPostProcessAction).toHaveBeenCalledWith(
			"agt_1",
			"approve_patch",
			{},
			expect.objectContaining({
				schedule: {
					mode: "once",
					runAt: new Date(2026, 3, 24, 18, 45, 0, 0).toISOString(),
				},
			}),
		);
	});

	it("prefills and submits the shared 24-hour picker when editing a scheduled action", async () => {
		const existingRunDate = new Date("2026-01-01T01:00:00Z");
		const { target } = await mountSubject(createScheduledActionRailDetail());
		await flushUi();

		const editButton = Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent?.trim() === "Edit",
		);
		expect(editButton).toBeTruthy();
		editButton?.click();
		await flushUi();

		const picker = target.querySelector<HTMLElement>(
			'[data-section="action-schedule-once-picker"]',
		);
		const dateInput = target.querySelector<HTMLInputElement>(
			"#process-action-approve_patch-__schedule-run-at",
		);
		const hourSelect = target.querySelector<HTMLSelectElement>(
			"#process-action-approve_patch-__schedule-run-at-hour",
		);
		const minuteSelect = target.querySelector<HTMLSelectElement>(
			"#process-action-approve_patch-__schedule-run-at-minute",
		);

		expect(picker?.dataset.timeFormat).toBe("24-hour");
		expect(target.querySelector('input[type="datetime-local"]')).toBeNull();
		const expectedExistingRunDate = `${existingRunDate.getFullYear()}-${String(
			existingRunDate.getMonth() + 1,
		).padStart(2, "0")}-${String(existingRunDate.getDate()).padStart(2, "0")}`;
		expect(dateInput?.value).toBe(expectedExistingRunDate);
		expect(hourSelect?.value).toBe(String(existingRunDate.getHours()).padStart(2, "0"));
		expect(minuteSelect?.value).toBe(String(existingRunDate.getMinutes()).padStart(2, "0"));

		if (!dateInput || !hourSelect || !minuteSelect) {
			throw new Error("Expected scheduled action picker controls");
		}
		dateInput.value = "2026-04-24";
		dateInput.dispatchEvent(new Event("input", { bubbles: true }));
		hourSelect.value = "18";
		hourSelect.dispatchEvent(new Event("change", { bubbles: true }));
		minuteSelect.value = "45";
		minuteSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flushUi();

		target
			.querySelector<HTMLButtonElement>(
				'form[data-action-form-id="approve_patch"] button[type="submit"]',
			)
			?.click();
		await flushUi();

		expect(mockUpdateScheduledAction).toHaveBeenCalledWith(
			"fut_1",
			{},
			expect.objectContaining({
				schedule: {
					mode: "once",
					runAt: new Date(2026, 3, 24, 18, 45, 0, 0).toISOString(),
				},
			}),
		);
	});

	it("preserves scheduled editing while collapsing and re-expanding its projection", async () => {
		mockUpdateScheduledAction.mockReset();
		mockUpdateScheduledAction.mockResolvedValue({ kind: "success" });
		const { target } = await mountSubject(createScheduledActionRailDetail());
		await flushUi();

		Array.from(target.querySelectorAll<HTMLButtonElement>("button"))
			.find((button) => button.textContent?.trim() === "Edit")
			?.click();
		await flushUi();
		Array.from(target.querySelectorAll<HTMLButtonElement>("button"))
			.find((button) => button.textContent?.trim() === "Hide form")
			?.click();
		await flushUi();

		expect(target.querySelector('form[data-action-form-id="approve_patch"]')).toBeNull();
		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-action-id="approve_patch"]',
		);
		expect(actionButton).toBeTruthy();
		actionButton?.click();
		await flushUi();
		target
			.querySelector<HTMLButtonElement>(
				'form[data-action-form-id="approve_patch"] button[type="submit"]',
			)
			?.click();
		await flushUi();

		expect(mockUpdateScheduledAction).toHaveBeenCalledWith(
			"fut_1",
			{},
			expect.objectContaining({
				nextTurnModelProfileId: "gpt-5-mini",
				schedule: { mode: "once", runAt: new Date("2026-01-01T01:00:00Z").toISOString() },
			}),
		);
		expect(mockPostProcessAction).not.toHaveBeenCalled();
	});

	it("preserves scheduling and model configuration when compactly submitting an edited scheduled action", async () => {
		const existingRunAt = "2026-01-01T01:00:00Z";
		mockUpdateScheduledAction.mockReset();
		mockUpdateScheduledAction.mockResolvedValue({ kind: "success" });
		const { target, viewport } = await mountSubject(createScheduledActionRailDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();

		const editButton = Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent?.trim() === "Edit",
		);
		expect(editButton).toBeTruthy();
		editButton?.click();
		await flushUi();

		const actionForm = target.querySelector<HTMLElement>(
			'form[data-action-form-id="approve_patch"]',
		);
		if (!actionForm) {
			throw new Error("Expected an open scheduled action form");
		}
		installElementLayoutMetrics(actionForm, {
			top: 2_300,
			height: 1_000,
			offsetParent: viewport,
		});
		metrics.setScrollHeight(3_600);
		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();

		const compactSubmit = target.querySelector<HTMLButtonElement>(
			'[data-section="compact-action-composer"] .submit-button',
		);
		expect(compactSubmit).toBeTruthy();
		compactSubmit?.click();
		await flushUi();

		expect(mockUpdateScheduledAction).toHaveBeenCalledWith(
			"fut_1",
			{},
			{
				nextTurnModelProfileId: "gpt-5-mini",
				schedule: { mode: "once", runAt: new Date(existingRunAt).toISOString() },
			},
		);
	});

	it("omits an override from compact submission when the current preview is not applicable", async () => {
		const detail = createActionRequiredDetail();
		const action = detail.actions[0];
		if (!action) throw new Error("Expected an action");
		setSingleTextareaActionForm(action, "Notes");
		mockFetchProcessActionModelPreview.mockReset();
		mockFetchProcessActionModelPreview.mockImplementation(
			(_instanceId: string, _actionId: string, input: Record<string, unknown>) =>
				Promise.resolve(
					input.message
						? { kind: "not_applicable", turnId: null, description: null }
						: createActionModelPreview(),
				),
		);
		const { target, viewport } = await mountSubject(detail, {
			preserveActionModelPreviewMock: true,
		});
		const metrics = await installActionChronicleLayout(target, viewport, 1_200);
		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();

		const modelSelect = target.querySelector<HTMLSelectElement>(
			'select[id$="__next-turn-model-profile"]',
		);
		if (!modelSelect) throw new Error("Expected model override selector");
		modelSelect.value = "gpt-5-mini";
		modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
		const prompt = target.querySelector<HTMLTextAreaElement>(
			"#process-action-approve_patch-message",
		);
		if (!prompt) throw new Error("Expected quick action prompt");
		prompt.value = "Finish without another turn.";
		prompt.dispatchEvent(new Event("input", { bubbles: true }));
		prompt.dispatchEvent(new Event("blur"));
		await flushUi();
		expect(target.querySelector('select[id$="__next-turn-model-profile"]')).toBeNull();
		const actionForm = target.querySelector<HTMLElement>(
			'form[data-action-form-id="approve_patch"]',
		);
		if (!actionForm) throw new Error("Expected open action form");
		installElementLayoutMetrics(actionForm, {
			top: 2_300,
			height: 1_000,
			offsetParent: viewport,
		});
		metrics.setScrollHeight(3_600);

		expect(await scrollToCompactActionComposer(target, viewport, metrics)).toBeTruthy();
		target
			.querySelector<HTMLButtonElement>('[data-section="compact-action-composer"] .submit-button')
			?.click();
		await flushUi();

		expect(mockPostProcessAction).toHaveBeenCalledWith(
			"agt_1",
			"approve_patch",
			{ message: "Finish without another turn." },
			expect.not.objectContaining({ nextTurnModelProfileId: expect.anything() }),
		);
	});

	it("shows the resolved next-turn model in the live action form", async () => {
		const { target } = await mountSubject(createActionRequiredDetail());
		await flushUi();

		const openButton = target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]');
		expect(openButton).toBeTruthy();

		openButton?.click();
		await flushUi();

		expect(mockFetchProcessActionModelPreview).toHaveBeenCalledWith("agt_1", "approve_patch", {});

		const select = target.querySelector<HTMLSelectElement>(
			'select[id$="__next-turn-model-profile"]',
		);
		const helper = target.querySelector<HTMLElement>('[data-section="action-model-helper"]');
		expect(select?.options[0]?.textContent).toContain("claude-sonnet-4");
		expect(helper?.textContent).toContain("claude-sonnet-4");
	});

	it("shares only the declared primary prompt and retains action-specific drafts", async () => {
		const { target } = await mountSubject(createActionRequiredDetailWithPromptForms());
		await flushUi();

		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();
		const approvalPrompt = target.querySelector<HTMLTextAreaElement>(
			"#process-action-approve_patch-approvalPrompt",
		);
		const approvalNote = target.querySelector<HTMLInputElement>(
			"#process-action-approve_patch-approvalNote",
		);
		if (!approvalPrompt || !approvalNote) throw new Error("expected approval fields");
		approvalPrompt.value = "Use this shared prompt";
		approvalPrompt.dispatchEvent(new Event("input", { bubbles: true }));
		approvalNote.value = "Keep this approval-only note";
		approvalNote.dispatchEvent(new Event("input", { bubbles: true }));

		target.querySelector<HTMLButtonElement>('[data-action-id="request_revision"]')?.click();
		await flushUi();
		expect(
			target.querySelector<HTMLTextAreaElement>("#process-action-request_revision-revisionPrompt")
				?.value,
		).toBe("Use this shared prompt");
		expect(
			target.querySelector<HTMLInputElement>("#process-action-request_revision-revisionNote")
				?.value,
		).toBe("");

		const revisionNote = target.querySelector<HTMLInputElement>(
			"#process-action-request_revision-revisionNote",
		);
		if (!revisionNote) throw new Error("expected revision note");
		revisionNote.value = "Keep this revision-only note";
		revisionNote.dispatchEvent(new Event("input", { bubbles: true }));
		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();

		expect(
			target.querySelector<HTMLInputElement>("#process-action-approve_patch-approvalNote")?.value,
		).toBe("Keep this approval-only note");
	});

	it("defers action-model preview refresh while a text field is being edited", async () => {
		const { target } = await mountSubject(createActionRequiredDetailWithPromptForms());
		await flushUi();
		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();
		expect(mockFetchProcessActionModelPreview).toHaveBeenCalledTimes(1);

		const prompt = target.querySelector<HTMLTextAreaElement>(
			"#process-action-approve_patch-approvalPrompt",
		);
		if (!prompt) throw new Error("expected approval prompt");
		for (const value of ["U", "Us", "Use the latest prompt"]) {
			prompt.value = value;
			prompt.dispatchEvent(new Event("input", { bubbles: true }));
			await flushUi();
		}
		expect(mockFetchProcessActionModelPreview).toHaveBeenCalledTimes(1);

		prompt.dispatchEvent(new Event("blur"));
		await flushUi();
		expect(mockFetchProcessActionModelPreview).toHaveBeenLastCalledWith("agt_1", "approve_patch", {
			approvalPrompt: "Use the latest prompt",
			approvalNote: "",
		});
	});

	it("hides a stale action-model preview while a different preview request is in flight", async () => {
		let resolveSecondPreview: ((value: ProcessActionModelPreview) => void) | null = null;
		mockFetchProcessActionModelPreview.mockReset();
		mockFetchProcessActionModelPreview.mockImplementation((_instanceId, actionId) => {
			if (actionId === "approve_patch") {
				return Promise.resolve(createActionModelPreview());
			}
			return new Promise<ProcessActionModelPreview>((resolve) => {
				resolveSecondPreview = resolve;
			});
		});

		const { target } = await mountSubject(createActionRequiredDetailWithMultipleActions(), {
			preserveActionModelPreviewMock: true,
		});
		await flushUi();

		target.querySelector<HTMLButtonElement>('[data-action-id="approve_patch"]')?.click();
		await flushUi();
		expect(target.querySelector('[data-section="action-model-loading"]')).toBeNull();
		expect(
			target.querySelector<HTMLSelectElement>('select[id$="__next-turn-model-profile"]')?.options[0]
				?.textContent,
		).toContain("claude-sonnet-4");

		target.querySelector<HTMLButtonElement>('[data-action-id="request_revision"]')?.click();
		await flushUi();

		expect(mockFetchProcessActionModelPreview).toHaveBeenCalledWith(
			"agt_1",
			"request_revision",
			{},
		);
		expect(target.querySelector('[data-section="action-model-helper"]')).toBeNull();
		expect(target.querySelector('[data-section="action-model-loading"]')).toBeTruthy();

		resolveSecondPreview?.(
			createActionModelPreview({
				turnId: "review_from_fallback",
				description: "Review from fallback",
				resolvedModel: {
					status: "resolved",
					modelProfileId: "gpt-5-mini",
					source: "catalog_default",
					error: null,
				},
			}),
		);
		await flushUi();

		expect(target.querySelector('[data-section="action-model-loading"]')).toBeNull();
		expect(
			target.querySelector<HTMLSelectElement>('select[id$="__next-turn-model-profile"]')?.options[0]
				?.textContent,
		).toContain("gpt-5-mini");
	});

	it("shows the model-switch cost warning when editing a scheduled action", async () => {
		const { target } = await mountSubject(createScheduledActionRailDetail());
		await flushUi();

		const editButton = Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent?.trim() === "Edit",
		);
		expect(editButton).toBeTruthy();

		editButton?.click();
		await flushUi();

		const warning = target.querySelector<HTMLElement>(
			'[data-section="action-model-switch-warning"]',
		);
		expect(warning).toBeTruthy();
		expect(warning?.textContent).toContain("costs may increase");
	});

	it("renders external-trigger detail in the turn rail", async () => {
		const { target } = await mountSubject(createExternalTriggerRailDetail());
		await flushUi();

		const triggerButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"][data-rail-tone="external_trigger"]',
		);
		const detail = triggerButton?.querySelector<HTMLElement>(".rail-detail");
		expect(triggerButton).toBeTruthy();
		expect(detail).toBeTruthy();
		expect(detail?.textContent).toContain("Watch the configured review file");
	});

	it("keeps committed reasoning and usage on the llm turn instead of the preceding operator decision", async () => {
		const { target } = await mountSubject(createOperatorDecisionTraceIsolationDetail());
		await flushUi();

		const operatorDecision = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_decision"]',
		);
		const latestLlmTurn = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_impl"]',
		);
		expect(operatorDecision).toBeTruthy();
		expect(latestLlmTurn).toBeTruthy();
		if (!operatorDecision || !latestLlmTurn) {
			throw new Error("Expected operator decision and latest LLM turn sections");
		}

		expect(operatorDecision.querySelector('[data-section="operator-decision"]')).toBeTruthy();
		expect(operatorDecision.querySelector(".thinking-section .chronicle-expand-button")).toBeNull();
		expect(operatorDecision.querySelector(".usage-stats")).toBeNull();
		expect(latestLlmTurn.querySelector(".thinking-section .chronicle-expand-button")).toBeTruthy();
		expect(latestLlmTurn.querySelector(".usage-stats")).toBeTruthy();
	});

	it("does not render a duplicate operator-input card for app actions already represented by an operator decision", async () => {
		const { target } = await mountSubject(createOperatorDecisionTraceIsolationDetail());
		await flushUi();

		expect(
			target.querySelector('[data-section="chronicle-turn"][data-turn-record-id="trn_decision"]'),
		).toBeTruthy();
		expect(
			target.querySelectorAll('[data-section="operator-input"][data-input-source="action_prompt"]'),
		).toHaveLength(0);
	});

	it("uses the current scroll anchor for reasoning shortcuts instead of a prior rail click", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
		});

		const firstTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_1"]',
		);
		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		expect(firstTurnButton).toBeTruthy();
		expect(lastTurnButton).toBeTruthy();

		lastTurnButton?.click();
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("true");

		viewport.scrollTop = 100;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		expect(firstTurnButton?.dataset.active).toBe("true");
		expect(lastTurnButton?.dataset.active).toBe("false");

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
		await flushUi();
		const reasoningDialog = target.querySelector<HTMLElement>(
			'[role="dialog"][aria-labelledby="reasoning-details-title-trn_1"]',
		);
		expect(reasoningDialog).toBeTruthy();
	});

	it("jumps immediately to the clicked rail anchor near the top of the chronicle", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
		});

		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		expect(lastTurnButton).toBeTruthy();

		lastTurnButton?.click();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(
			scrollTopForAnchor({ top: 1_500, height: 320 }, 900, {
				align: "start",
				startPaddingPx: 28,
				scrollHeight: 2_200,
			}),
		);
		expect(metrics.getScrollTop()).toBe(1_300);
		expect(lastTurnButton?.dataset.active).toBe("true");
	});

	it("focuses the turn result when clicking a turn rail item", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 3_600 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 1_800 },
		});

		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		const lastTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		const lastTurnResult = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"] [data-section="turn-result"]',
		);
		expect(lastTurnButton).toBeTruthy();
		expect(lastTurnSection).toBeTruthy();
		expect(lastTurnResult).toBeTruthy();
		if (!lastTurnSection || !lastTurnResult) {
			throw new Error("Expected last turn section and result section");
		}
		installElementLayoutMetrics(lastTurnResult, {
			top: 760,
			height: 220,
			offsetParent: lastTurnSection,
		});

		lastTurnButton?.click();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(
			scrollTopForAnchor({ top: 2_260, height: 220 }, 900, {
				align: "start",
				startPaddingPx: 28,
				scrollHeight: 3_600,
			}),
		);
		expect(metrics.getScrollTop()).toBe(2_232);
		expect(lastTurnButton?.dataset.active).toBe("true");
	});

	it("launches ticket creation from a compact issue description dialog", async () => {
		mockLaunchTicketCreation.mockResolvedValue({
			childInstanceId: "agt_ticket",
			relation: { id: "rel_1" },
		});
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		const createIssueButton = target.querySelector<HTMLButtonElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"] .create-issue-button',
		);
		expect(createIssueButton?.textContent).toContain("Create issue");
		createIssueButton?.click();
		await flushUi();

		const dialog = target.querySelector<HTMLElement>('[data-section="ticket-composer"]');
		const description = dialog?.querySelector<HTMLTextAreaElement>("textarea");
		const submit = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent?.trim() === "Create",
		);
		expect(dialog?.querySelector("pre")).toBeNull();
		expect(description?.getAttribute("placeholder")).toContain("Describe the problem");
		expect(submit?.disabled).toBe(true);

		if (!description) throw new Error("Expected issue description field");
		description.value = "Fix the issue creation flow on narrow mobile screens.";
		description.dispatchEvent(new Event("input", { bubbles: true }));
		await flushUi();
		expect(submit?.disabled).toBe(false);
		submit?.click();
		await flushUi();

		expect(mockLaunchTicketCreation).toHaveBeenCalledWith("agt_1", {
			artifact: { kind: "turn_result", turnRecordId: "trn_2" },
			focus: { kind: "whole_result" },
			additionalInstructions: "Fix the issue creation flow on narrow mobile screens.",
			toolName: "tracker_create_issue",
		});
	});

	it("keeps historical turn results compressed until the user explicitly expands them", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
		});

		const firstTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-section="turn-rail-list"] [data-turn-record-id="trn_1"]',
		);
		const firstTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_1"]',
		);
		const firstTurnResult = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_1"] [data-section="turn-result"]',
		);
		expect(firstTurnButton).toBeTruthy();
		expect(firstTurnSection).toBeTruthy();
		expect(firstTurnResult).toBeTruthy();

		firstTurnButton?.click();
		await flushUi();

		expect(firstTurnButton?.dataset.active).toBe("true");
		expect(firstTurnSection?.dataset.focused).toBe("true");
		expect(firstTurnResult?.dataset.compressed).toBe("true");

		viewport.scrollTop = 100;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		expect(firstTurnButton?.dataset.active).toBe("true");
		expect(firstTurnSection?.dataset.focused).toBe("true");
		expect(firstTurnResult?.dataset.compressed).toBe("true");

		const expandButton = firstTurnResult?.querySelector<HTMLButtonElement>(
			".chronicle-expand-button",
		);
		expect(expandButton).toBeTruthy();
		expandButton?.click();
		await flushUi();

		expect(firstTurnResult?.dataset.compressed).toBeUndefined();
		expect(firstTurnResult?.querySelector(".result-summary")).toBeNull();
		expect(firstTurnResult?.textContent).toContain("Inspect the repo");
	});

	it("keeps leaf outcomes out of the rail and highlights the parent turn when a result scrolls into view", async () => {
		const { target, viewport } = await mountSubject(createActionRequiredDetailWithLeafOutcome());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 3_000 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 420, height: 320 },
			"chronicle-turn-trn_2": { top: 1_120, height: 320 },
			"chronicle-leaf-outcome-los_patch": { top: 1_820, height: 300 },
			"chronicle-action-section": { top: 2_520, height: 220 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const parentTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_2"][data-rail-kind="turn"]',
		);
		const leafButton = target.querySelector<HTMLButtonElement>(
			'[data-section="leaf-outcome-indicator"]',
		);
		const leafSection = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome"][data-snapshot-id="los_patch"]',
		);
		// The result still renders in the chronicle, but it is no longer a rail waypoint.
		expect(parentTurnButton).toBeTruthy();
		expect(leafSection).toBeTruthy();
		expect(leafButton).toBeNull();
		expect(target.querySelector('[data-rail-tone="leaf_outcome"]')).toBeNull();

		// Scrolling the result into the focus line highlights its parent turn in the rail.
		viewport.scrollTop = 1_200;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		const parentTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		expect(parentTurnButton?.dataset.active).toBe("true");
		expect(parentTurnSection?.dataset.focused).toBe("true");
	});

	it("keeps the clicked last turn active when the viewport clamps at the bottom", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 1_500 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_300, height: 160 },
		});

		const firstTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_1"]',
		);
		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		const lastTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_2"]',
		);
		expect(firstTurnButton).toBeTruthy();
		expect(lastTurnButton).toBeTruthy();
		expect(lastTurnSection).toBeTruthy();

		lastTurnButton?.click();
		await flushUi();

		expect(metrics.getScrollTop()).toBe(
			scrollTopForAnchor({ top: 1_300, height: 160 }, 900, { scrollHeight: 1_500 }),
		);
		expect(firstTurnButton?.dataset.active).toBe("false");
		expect(lastTurnButton?.dataset.active).toBe("true");
		expect(lastTurnSection?.dataset.focused).toBe("true");
	});

	it("coalesces chronicle mutation and resize layout work into one animation frame", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();
		const layouts = {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-terminal-completed": { top: 2_050, height: 160 },
		};
		installAnchorLayoutMetrics(target, layouts);

		const firstTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_1"]',
		);
		const secondTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_2"]',
		);
		expect(firstTurnButton).toBeTruthy();
		expect(secondTurnButton).toBeTruthy();

		viewport.scrollTop = 500;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();
		expect(firstTurnButton?.dataset.active).toBe("true");
		expect(secondTurnButton?.dataset.active).toBe("false");

		layouts["chronicle-turn-trn_2"].top = 1_000;
		const querySelectorAllSpy = vi.spyOn(viewport, "querySelectorAll");
		querySelectorAllSpy.mockClear();

		FakeMutationObserver.triggerAll();
		FakeMutationObserver.triggerAll();
		FakeResizeObserver.triggerAll();
		FakeResizeObserver.triggerAll();

		expect(FakeMutationObserver.observedOptions().some((options) => options.subtree)).toBe(false);
		expect(querySelectorAllSpy).not.toHaveBeenCalled();

		await flushUi();
		expect(querySelectorAllSpy).toHaveBeenCalledTimes(1);
		expect(firstTurnButton?.dataset.active).toBe("false");
		expect(secondTurnButton?.dataset.active).toBe("true");
	});

	it("updates the active rail state when the chronicle container resizes without another scroll event", async () => {
		const { target, viewport } = await mountSubject(createReasoningOverlayDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();
		const layouts = {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-terminal-completed": { top: 2_050, height: 160 },
		};
		installAnchorLayoutMetrics(target, layouts);

		const firstTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_1"]',
		);
		const secondTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_2"]',
		);
		const chronicleContainer = viewport.parentElement;
		expect(firstTurnButton).toBeTruthy();
		expect(secondTurnButton).toBeTruthy();
		expect(chronicleContainer).toBeInstanceOf(HTMLElement);
		if (!(chronicleContainer instanceof HTMLElement)) {
			throw new Error("Expected chronicle container to be present");
		}

		viewport.scrollTop = 500;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();
		expect(firstTurnButton?.dataset.active).toBe("true");
		expect(secondTurnButton?.dataset.active).toBe("false");

		layouts["chronicle-turn-trn_2"].top = 1_000;
		FakeResizeObserver.triggerFor(chronicleContainer);
		await flushUi();
		await flushUi();
		expect(firstTurnButton?.dataset.active).toBe("false");
		expect(secondTurnButton?.dataset.active).toBe("true");
	});

	it("moves the active rail state to the action section when a followed live tail commits", async () => {
		const { target, viewport } = await mountSubject(createLiveReasoningTransitionDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_200 });
		await flushUi();

		const liveTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_live"]',
		);
		expect(liveTurnButton).toBeTruthy();
		expect(liveTurnButton?.dataset.active).toBe("true");

		detailState.set({
			data: compactTestDetail(createCommittedActionRequiredTransitionDetail()),
			loading: false,
			error: null,
			loadedAtMs: Date.now(),
		});
		await flushUi();

		const committedTurnButton = target.querySelector<HTMLButtonElement>(
			'[data-turn-record-id="trn_live"]',
		);
		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"]',
		);
		const committedTurnSection = target.querySelector<HTMLElement>(
			'[data-section="chronicle-turn"][data-turn-record-id="trn_live"]',
		);
		const actionSection = target.querySelector<HTMLElement>(
			'[data-section="leaf-outcome-actions"]',
		);
		expect(committedTurnButton).toBeTruthy();
		expect(actionButton).toBeTruthy();
		expect(committedTurnSection).toBeTruthy();
		expect(actionSection).toBeTruthy();
		expect(committedTurnButton?.dataset.active).toBe("false");
		expect(actionButton?.dataset.active).toBe("true");
		expect(committedTurnSection?.dataset.focused).toBe("false");
		expect(actionSection?.dataset.focused).toBe("true");
	});

	it("highlights the action rail item at the bottom even when the action section is short", async () => {
		const { target, viewport } = await mountSubject(createActionRequiredDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-action-section": { top: 2_300, height: 100 },
		});

		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		const actionButton = target.querySelector<HTMLButtonElement>(
			'[data-section="action-required-indicator"]',
		);
		expect(lastTurnButton).toBeTruthy();
		expect(actionButton).toBeTruthy();

		lastTurnButton?.click();
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("true");
		expect(actionButton?.dataset.active).toBe("false");

		viewport.scrollTop = 1_500;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();

		expect(lastTurnButton?.dataset.active).toBe("false");
		expect(actionButton?.dataset.active).toBe("true");
	});

	it("shows completed processes as a final Turn Rail stop", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
		const { target, viewport } = await mountSubject(createProcessDetail());
		installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 1_800 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-terminal-completed": { top: 1_500, height: 160 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const turnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_1"]');
		const terminalButton = target.querySelector<HTMLButtonElement>(
			'[data-section="terminal-state-indicator"][data-terminal-status="completed"]',
		);
		const terminalCard = target.querySelector<HTMLElement>(
			'[data-section="chronicle-terminal-state"][data-terminal-status="completed"]',
		);
		const headerStatus = target.querySelector<HTMLElement>(
			'[data-section="process-header-status"][data-process-status="completed"]',
		);
		expect(headerStatus?.textContent).toContain("Completed");
		expect(terminalButton).toBeTruthy();
		expect(terminalButton?.textContent).toContain("Completed");
		expect(terminalCard).toBeTruthy();
		expect(terminalCard?.id).toBe("chronicle-terminal-completed");
		expect(terminalCard?.textContent).toContain("Final state");
		expect(terminalCard?.textContent).toContain("Completed · 1m ago");
		expect(turnButton?.dataset.active).toBe("false");
		expect(terminalButton?.dataset.active).toBe("true");
	});

	it("highlights the aborted terminal node at the bottom and still lets arrow navigation reach it", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
		const { target, viewport } = await mountSubject(createAbortedDetail());
		const metrics = installViewportMetrics(viewport, { clientHeight: 900, scrollHeight: 2_400 });
		await flushUi();
		installAnchorLayoutMetrics(target, {
			"chronicle-prompt": { top: 0, height: 180 },
			"chronicle-turn-trn_1": { top: 500, height: 320 },
			"chronicle-turn-trn_2": { top: 1_500, height: 320 },
			"chronicle-terminal-aborted": { top: 2_300, height: 140 },
		});
		FakeResizeObserver.triggerAll();
		await flushUi();

		const lastTurnButton = target.querySelector<HTMLButtonElement>('[data-turn-record-id="trn_2"]');
		const terminalButton = target.querySelector<HTMLButtonElement>(
			'[data-section="terminal-state-indicator"][data-terminal-status="aborted"]',
		);
		const terminalCard = target.querySelector<HTMLElement>(
			'[data-section="chronicle-terminal-state"][data-terminal-status="aborted"]',
		);
		const headerStatus = target.querySelector<HTMLElement>(
			'[data-section="process-header-status"][data-process-status="aborted"]',
		);
		expect(headerStatus?.textContent).toContain("Aborted");
		expect(terminalButton).toBeTruthy();
		expect(terminalButton?.textContent).toContain("Aborted");
		expect(terminalCard).toBeTruthy();
		expect(terminalCard?.textContent).toContain("Aborted · 1m ago");
		expect(target.querySelector('[data-section="action-required-indicator"]')).toBeNull();
		expect(target.querySelector('[data-section="leaf-outcome-actions"]')).toBeNull();
		expect(metrics.getScrollTop()).toBe(1_500);
		expect(lastTurnButton?.dataset.active).toBe("false");
		expect(terminalButton?.dataset.active).toBe("true");

		viewport.scrollTop = 1_400;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("true");
		expect(terminalButton?.dataset.active).toBe("false");

		viewport.scrollTop = 1_500;
		viewport.dispatchEvent(new Event("scroll"));
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("false");
		expect(terminalButton?.dataset.active).toBe("true");

		terminalButton?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
		);
		await flushUi();
		expect(lastTurnButton?.dataset.active).toBe("true");
		expect(terminalButton?.dataset.active).toBe("false");

		lastTurnButton?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
		);
		await flushUi();
		expect(terminalButton?.dataset.active).toBe("true");
		expect(lastTurnButton?.dataset.active).toBe("false");
	});

	it("supports process detail overlay deep links", async () => {
		window.history.replaceState(null, "", "/processes/agt_1?overlay=process-info");
		window.dispatchEvent(new PopStateEvent("popstate"));
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();
		expect(
			target.querySelector('[data-section="process-detail-overlay-frame"]')?.parentElement,
		).toBe(target.querySelector('[data-page="process-detail"]'));
	});

	it("supports reasoning detail overlay deep links", async () => {
		window.history.replaceState(null, "", "/processes/agt_1?overlay=reasoning&turnRecordId=trn_1");
		window.dispatchEvent(new PopStateEvent("popstate"));
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		const overlay = target.querySelector<HTMLElement>('[data-section="reasoning-details-overlay"]');
		expect(overlay).toBeTruthy();
		expect(overlay?.textContent).toContain("First prompt input");
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
	});

	it("ignores unavailable reasoning detail deep links without clearing the URL", async () => {
		window.history.replaceState(
			null,
			"",
			"/processes/agt_1?overlay=reasoning&turnRecordId=missing-turn",
		);
		window.dispatchEvent(new PopStateEvent("popstate"));
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=missing-turn");
	});

	it("keeps process detail overlay state in the URL", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		const replaceStateSpy = vi.spyOn(window.history, "replaceState");
		const pushStateSpy = vi.spyOn(window.history, "pushState");
		const processInfoButton = Array.from(target.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Process info",
		) as HTMLButtonElement | undefined;
		processInfoButton?.focus();
		processInfoButton?.click();
		await flushUi();
		expect(window.location.search).toBe("?overlay=process-info");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/processes/agt_1?overlay=process-info");
		expect(pushStateSpy).not.toHaveBeenCalled();
		replaceStateSpy.mockClear();
		pushStateSpy.mockClear();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();
		expect((target.querySelector(".page-shell") as HTMLElement | null)?.inert).toBe(true);
		expect(document.activeElement).toBe(
			target.querySelector<HTMLButtonElement>(
				'.process-info-overlay [aria-label="Close process info"]',
			),
		);

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
		expect(window.location.search).toBe("?overlay=process-info");

		target
			.querySelector<HTMLButtonElement>(".process-detail-overlay-backdrop")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await flushUi();
		expect(window.location.search).toBe("");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/processes/agt_1");
		expect(pushStateSpy).not.toHaveBeenCalled();
		replaceStateSpy.mockClear();
		pushStateSpy.mockClear();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect((target.querySelector(".page-shell") as HTMLElement | null)?.inert).not.toBe(true);
		expect(document.activeElement).toBe(processInfoButton);

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=trn_1");
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			"/processes/agt_1?overlay=reasoning&turnRecordId=trn_1",
		);
		expect(pushStateSpy).not.toHaveBeenCalled();
		replaceStateSpy.mockClear();
		pushStateSpy.mockClear();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await flushUi();
		expect(window.location.search).toBe("");
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/processes/agt_1");
		expect(pushStateSpy).not.toHaveBeenCalled();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
		replaceStateSpy.mockRestore();
		pushStateSpy.mockRestore();
	});

	it("replaces a closed deep-linked overlay URL so Back will not reopen it", async () => {
		window.history.replaceState(null, "", "/");
		window.history.pushState(null, "", "/processes/agt_1?overlay=process-info");
		window.dispatchEvent(new PopStateEvent("popstate"));
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();
		const historyLengthWithDeepLink = window.history.length;
		const replaceStateSpy = vi.spyOn(window.history, "replaceState");
		const pushStateSpy = vi.spyOn(window.history, "pushState");

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await flushUi();
		expect(window.location.pathname).toBe("/processes/agt_1");
		expect(window.location.search).toBe("");
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/processes/agt_1");
		expect(pushStateSpy).not.toHaveBeenCalled();
		expect(window.history.length).toBe(historyLengthWithDeepLink);
		replaceStateSpy.mockRestore();
		pushStateSpy.mockRestore();
	});

	it("updates reasoning overlay deep links during turn navigation without stacking overlay history", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		const pushStateSpy = vi.spyOn(window.history, "pushState");
		const replaceStateSpy = vi.spyOn(window.history, "replaceState");
		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		detailButtons[1]?.click();
		await flushUi();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=trn_2");
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			"/processes/agt_1?overlay=reasoning&turnRecordId=trn_2",
		);
		expect(pushStateSpy).not.toHaveBeenCalled();
		pushStateSpy.mockClear();
		replaceStateSpy.mockClear();

		target.querySelector<HTMLButtonElement>('[data-action="reasoning-overlay-prev"]')?.click();
		await flushUi();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=trn_1");
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			"/processes/agt_1?overlay=reasoning&turnRecordId=trn_1",
		);
		expect(pushStateSpy).not.toHaveBeenCalled();
		pushStateSpy.mockClear();
		replaceStateSpy.mockClear();

		target.querySelector<HTMLButtonElement>('[data-action="reasoning-overlay-next"]')?.click();
		await flushUi();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=trn_2");
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			"/processes/agt_1?overlay=reasoning&turnRecordId=trn_2",
		);
		expect(pushStateSpy).not.toHaveBeenCalled();
		pushStateSpy.mockClear();
		replaceStateSpy.mockClear();

		pushStateSpy.mockRestore();
		replaceStateSpy.mockRestore();
	});

	it("restores process detail overlays from browser history events", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		window.history.replaceState(null, "", "/processes/agt_1?overlay=process-info");
		window.dispatchEvent(new PopStateEvent("popstate"));
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();

		window.history.replaceState(null, "", "/processes/agt_1?overlay=reasoning&turnRecordId=trn_1");
		window.dispatchEvent(new PopStateEvent("popstate"));
		await flushUi();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();
	});

	it("supports i and r detail-view shortcuts", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
		await flushUi();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeTruthy();
		expect(window.location.search).toBe("?overlay=process-info");

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await flushUi();
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect(window.location.search).toBe("");

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
		await flushUi();
		const overlay = target.querySelector<HTMLElement>('[data-section="reasoning-details-overlay"]');
		expect(overlay).toBeTruthy();
		expect(overlay?.textContent).toContain("Second prompt input");
		expect(target.querySelector('[data-section="process-info-overlay"]')).toBeNull();
		expect(window.location.search).toBe("?overlay=reasoning&turnRecordId=trn_2");
	});

	it("replaces a synthetic in-progress turn when a live turn starts", async () => {
		const detail = compactTestDetail(createProcessDetail());
		const priorTurn = detail.timeline.turns[0];
		if (!priorTurn) {
			throw new Error("Expected timeline turn fixture");
		}
		detail.process.lifecycleStatus = "active";
		detail.process.selectedTurnId = "implement_fix";
		detail.process.currentExecution = null;
		detail.timeline.turns = [
			{
				...priorTurn,
				id: "current:implement_fix",
				turnId: "implement_fix",
				displayTurn: "implement_fix",
				outcome: "in_progress",
				summary: "Current step: Implement fix",
				output: "",
				turnResultMarkdown: "",
				createdAt: "2026-01-01T00:03:00Z",
				presentation: "llm_turn",
				status: "in_progress",
				startedAt: "2026-01-01T00:03:00Z",
				endedAt: null,
			},
		];
		detail.primaryPath.turnState.activeTurn = null;
		detail.primaryPath.turnState.currentTurnRecordId = null;
		detail.primaryPath.turnState.isStreaming = false;

		const { target } = await mountSubject(detail);
		await flushUi();
		expect(target.querySelector('[data-turn-record-id="current:implement_fix"]')).toBeTruthy();

		handleWsEvent(
			createDurableWsFrame({
				type: "primary_path.turn_started",
				instanceId: "agt_1",
				sentAt: "2026-01-01T00:03:01Z",
				payload: {
					turnRecord: {
						id: "trn_live_2",
						turnId: "implement_fix",
						turnType: "llm",
						pathType: "primary",
						startedAt: "2026-01-01T00:03:01Z",
					},
				},
			}),
		);
		await flushUi();

		const inProgressTurns = [
			...target.querySelectorAll<HTMLElement>('[data-turn-status="in_progress"]'),
		];
		expect(inProgressTurns).toHaveLength(1);
		expect(inProgressTurns[0]?.dataset.turnRecordId).toBe("trn_live_2");
		expect(target.querySelector('[data-turn-record-id="current:implement_fix"]')).toBeNull();
	});

	it("waits for an explicit retry after reasoning detail loading fails", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();
		mockFetchTurnReasoningDetail.mockReset();
		mockFetchTurnReasoningDetail.mockRejectedValue(new Error("Temporary reasoning failure"));

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();
		await flushUi();

		expect(mockFetchTurnReasoningDetail).toHaveBeenCalledTimes(1);
		expect(target.querySelector('[data-section="reasoning-load-error"]')?.textContent).toContain(
			"Temporary reasoning failure",
		);

		mockFetchTurnReasoningDetail.mockImplementation(
			async (requestInstanceId: string, turnRecordId: string) =>
				buildMockReasoningResponse(requestInstanceId, turnRecordId),
		);
		target
			.querySelector<HTMLButtonElement>('[data-section="reasoning-load-error"] button')
			?.click();
		await flushUi();

		expect(mockFetchTurnReasoningDetail).toHaveBeenCalledTimes(2);
		expect(target.querySelector('[data-section="reasoning-load-error"]')).toBeNull();
	});

	it("retries a server-rejected stale reasoning request", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();
		mockFetchTurnReasoningDetail.mockReset();
		mockFetchTurnReasoningDetail.mockRejectedValueOnce(
			new Error("The process changed while reasoning details were loading."),
		);
		mockFetchTurnReasoningDetail.mockImplementation(
			async (requestInstanceId: string, turnRecordId: string) =>
				buildMockReasoningResponse(requestInstanceId, turnRecordId),
		);

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();

		expect(target.querySelector('[data-section="reasoning-load-error"]')?.textContent).toContain(
			"process changed",
		);

		target
			.querySelector<HTMLButtonElement>('[data-section="reasoning-load-error"] button')
			?.click();
		await flushUi();

		expect(mockFetchTurnReasoningDetail).toHaveBeenCalledTimes(2);
		expect(target.querySelector('[data-section="reasoning-load-error"]')).toBeNull();
	});

	it("does not apply a reasoning response from an older session signature", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();
		const staleResponse = buildMockReasoningResponse("agt_1", "trn_1");
		staleResponse.reasoning = {
			...staleResponse.reasoning,
			assistant: {
				...staleResponse.reasoning.assistant,
				thinking: "Stale response must not win.",
			},
			traceItems: [{ kind: "thinking", text: "Stale response must not win." }],
		};
		const pendingStaleResponse = createDeferred<typeof staleResponse>();
		let reasoningCallCount = 0;
		mockFetchTurnReasoningDetail.mockReset();
		mockFetchTurnReasoningDetail.mockImplementation(
			async (requestInstanceId: string, turnRecordId: string) => {
				reasoningCallCount += 1;
				return reasoningCallCount === 1
					? await pendingStaleResponse.promise
					: buildMockReasoningResponse(requestInstanceId, turnRecordId);
			},
		);

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();

		const freshDetail = createReasoningOverlayDetail();
		const freshAssistant = freshDetail.piSessionEntries.find(
			(entry) => entry.id === "assistant-plan",
		);
		if (!freshAssistant?.message) {
			throw new Error("Expected assistant fixture");
		}
		freshAssistant.message.content = [
			{ type: "thinking", thinking: "Fresh session reasoning wins." },
			{ type: "text", text: "Fresh answer" },
		];
		detailState.set({
			data: compactTestDetail(freshDetail),
			loading: false,
			error: null,
			loadedAtMs: Date.now(),
		});
		await flushUi();

		expect(mockFetchTurnReasoningDetail).toHaveBeenCalledTimes(2);
		expect(target.textContent).toContain("Fresh session reasoning wins.");

		pendingStaleResponse.resolve(staleResponse);
		await flushUi();

		expect(target.textContent).toContain("Fresh session reasoning wins.");
		expect(target.textContent).not.toContain("Stale response must not win.");
	});

	it("keeps compact tool-only and truncated reasoning previews inspectable", async () => {
		const detail = compactTestDetail(createReasoningOverlayDetail());
		detail.timeline.tracePreviewsByTurnRecordId = {
			trn_1: {
				turnRecordId: "trn_1",
				assistantTextPreview: "",
				assistantTextTruncated: false,
				thinkingPreview: "",
				thinkingPreviewTruncated: false,
				toolCallCount: 2,
				traceItemCount: 2,
				hasReasoningDetails: true,
				usage: null,
				piInput: null,
			},
			trn_2: {
				turnRecordId: "trn_2",
				assistantTextPreview: "",
				assistantTextTruncated: false,
				thinkingPreview: "… line 18\nline 19\nline 20",
				thinkingPreviewTruncated: true,
				toolCallCount: 0,
				traceItemCount: 20,
				hasReasoningDetails: true,
				usage: null,
				piInput: null,
			},
		};

		const { target } = await mountSubject(detail);
		await flushUi();

		const previews = target.querySelectorAll<HTMLElement>('[data-section="thinking-preview"]');
		expect(previews).toHaveLength(2);
		expect(previews[0]?.querySelector(".thinking-section .chronicle-expand-button")).toBeTruthy();
		expect(
			previews[0]?.querySelector<HTMLElement>(".thinking-preview-copy")?.dataset.traceItemCount,
		).toBe("2");
		expect(
			previews[1]?.querySelector<HTMLElement>(".thinking-preview-copy")?.dataset.truncated,
		).toBe("true");
		expect(
			previews[1]?.querySelector<HTMLElement>(".thinking-preview-copy")?.dataset.traceItemCount,
		).toBe("20");
	});

	it("opens the reasoning details overlay as a flat operational trace with prompt copy and turn navigation", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const detail = createReasoningOverlayDetail();
		detail.runDetails = {
			...detail.runDetails,
			turns: detail.runDetails.turns.map((turn) =>
				turn.turnId === "implement_fix"
					? {
							...turn,
							outcomeActions: [{ name: "finish_work", description: "Finish", parameters: [] }],
						}
					: turn,
			),
		};
		const { target } = await mountSubject(detail);
		await flushUi();

		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		expect(detailButtons).toHaveLength(2);

		detailButtons[1]?.click();
		await flushUi();

		const overlay = target.querySelector<HTMLElement>('[data-section="reasoning-details-overlay"]');
		expect(overlay).toBeTruthy();
		expect(overlay?.querySelector('[data-section="reasoning-overlay-meta"]')).toBeNull();
		expect(overlay?.textContent).not.toContain("Triggering input");
		expect(overlay?.querySelector('[data-section="reasoning-run-summary"]')?.textContent).toContain(
			"gpt-5-mini",
		);
		const turnFactsText = overlay?.querySelector(
			'[data-section="reasoning-turn-facts"]',
		)?.textContent;
		expect(turnFactsText).toContain("read, bash, edit");
		expect(turnFactsText).toContain("finish_work");
		expect(
			overlay?.querySelector('[data-section="reasoning-overlay-pi-input"]')?.textContent,
		).toContain("Second prompt input");
		expect(overlay?.querySelector('[data-highlight="user-input"]')?.textContent).toBe(
			"Second prompt input",
		);
		expect(overlay?.textContent).toContain("Need to patch the implementation.");
		expect(overlay?.textContent).toContain("↑980");
		expect(overlay?.textContent ?? "").toMatch(/(?:💾)?14\s*written/);

		const copyButton = overlay?.querySelector<HTMLButtonElement>('[data-action="copy-pi-input"]');
		copyButton?.click();
		await flushUi();
		const copiedPrompt = writeText.mock.calls[0]?.[0] ?? "";
		expect(copiedPrompt).toBe(secondReasoningFullPrompt);
		expect(copiedPrompt).not.toContain(detail.runDetails.systemPrompt ?? "");
		expect(copiedPrompt).not.toContain(detail.runDetails.appendSystemPrompt ?? "");
		expect(copyButton?.textContent).toContain("Copied");

		const previousButton = overlay?.querySelector<HTMLButtonElement>(
			'[data-action="reasoning-overlay-prev"]',
		);
		previousButton?.click();
		await flushUi();
		expect(overlay?.textContent).toContain("First prompt input");
		expect(overlay?.textContent).toContain("Need to inspect the repo.");
		expect(overlay?.textContent).toContain("claude-sonnet-4");
		expect(overlay?.textContent).toContain("↑1.2k");
		expect(overlay?.textContent).toContain("⚡12");
		expect(overlay?.textContent).toContain("read");

		const nextButton = overlay?.querySelector<HTMLButtonElement>(
			'[data-action="reasoning-overlay-next"]',
		);
		nextButton?.click();
		await flushUi();
		expect(overlay?.textContent).toContain("Second prompt input");

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
	});

	it("expands built-in tool calls with session-tree details and highlights truncated results", async () => {
		const detail = createReasoningOverlayDetail();
		const toolResultEntry = detail.piSessionEntries.find((entry) => entry.id === "tool-result-1");
		if (!toolResultEntry?.message) {
			throw new Error("Expected tool result fixture entry");
		}
		toolResultEntry.message.content = [
			{ type: "text", text: "README contents\n\n[output truncated after 50KB]" },
		];
		toolResultEntry.message.details = {
			ok: true,
			truncation: { reason: "response_too_large" },
			fullOutputPath: "/tmp/leitwerk/read-output.txt",
		};

		const { target } = await mountSubject(detail);
		await flushUi();

		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		detailButtons[0]?.click();
		await flushUi();

		const toolDetails = target.querySelector<HTMLDetailsElement>(
			'[data-section="reasoning-tool-marker"][data-tool-name="read"]',
		);
		expect(toolDetails).toBeTruthy();
		expect(toolDetails?.tagName).toBe("DETAILS");
		expect(toolDetails?.dataset.toolKind).toBe("internal");
		expect(toolDetails?.dataset.toolTruncated).toBe("true");
		expect(toolDetails?.open).toBe(false);

		toolDetails?.querySelector<HTMLElement>("summary")?.click();
		await flushUi();

		expect(toolDetails?.open).toBe(true);
		const warning = toolDetails?.querySelector<HTMLElement>(
			'[data-section="tool-truncation-warning"]',
		);
		expect(warning?.textContent).toContain("Tool result truncated");
		expect(warning?.textContent).not.toContain("/tmp/leitwerk/read-output.txt");
		const runMeta = toolDetails?.querySelector<HTMLElement>('[data-section="tool-run-meta"]');
		expect(runMeta?.textContent).toContain("Completed");
		expect(runMeta?.textContent).toContain("Started 2026-01-01T00:01:05Z");
		expect(runMeta?.textContent).toContain("Duration 4s");
		const sessionDetails = toolDetails?.querySelector<HTMLElement>(
			'[data-section="tool-session-details"]',
		);
		expect(sessionDetails?.textContent).toContain('"path": "README.md"');
		expect(sessionDetails?.textContent).toContain("README contents");
		expect(toolDetails?.textContent).not.toContain("tool_1");
		expect(toolDetails?.textContent).not.toContain("assistant-plan");
		expect(toolDetails?.textContent).not.toContain("tool-result-1");
		expect(toolDetails?.textContent).not.toContain("response_too_large");
	});

	it("opens reasoning details for a turn that has Pi input but no recorded reasoning", async () => {
		const detail = createReasoningOverlayDetail();
		detail.piSessionEntries = detail.piSessionEntries.map((entry) =>
			entry.id === "assistant-fix"
				? {
						...entry,
						message: {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							usage: entry.message?.usage,
						},
					}
				: entry,
		);
		detail.primaryPath.primaryPathEntries =
			detail.piSessionEntries as PrimaryPathSnapshot["primaryPathEntries"];

		const { target } = await mountSubject(detail);
		await flushUi();

		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		expect(detailButtons).toHaveLength(2);
		detailButtons[1]?.click();
		await flushUi();

		const overlay = target.querySelector<HTMLElement>('[data-section="reasoning-details-overlay"]');
		expect(
			overlay?.querySelector('[data-section="reasoning-overlay-pi-input"]')?.textContent,
		).toContain("Second prompt input");
		expect(
			overlay?.querySelector('[data-section="reasoning-overlay-trace"]')?.textContent,
		).toContain("No reasoning details were recorded");
	});

	it("shows quiet reasoning detail empty states for unavailable prompt data and no active tools", async () => {
		const detail = createReasoningOverlayDetail();
		detail.runDetails = {
			...detail.runDetails,
			turns: detail.runDetails.turns.map((turn) =>
				turn.turnId === "implement_fix" ? { ...turn, activePiToolNames: [] } : turn,
			),
		};
		detail.piSessionEntries = detail.piSessionEntries
			.filter((entry) => entry.id !== "user-fix-prompt")
			.map((entry) =>
				entry.id === "assistant-fix" ? { ...entry, parentId: "tool-result-1" } : entry,
			);
		detail.primaryPath.primaryPathEntries =
			detail.piSessionEntries as PrimaryPathSnapshot["primaryPathEntries"];

		const { target } = await mountSubject(detail);
		await flushUi();

		const detailButtons = target.querySelectorAll<HTMLButtonElement>(
			".thinking-section .chronicle-expand-button",
		);
		detailButtons[1]?.click();
		await flushUi();

		const overlay = target.querySelector<HTMLElement>('[data-section="reasoning-details-overlay"]');
		expect(
			overlay?.querySelector('[data-section="reasoning-overlay-pi-input"]')?.textContent,
		).toContain("No Pi input was recorded");
		expect(overlay?.querySelector('[data-section="reasoning-turn-facts"]')?.textContent).toContain(
			"None",
		);
	});

	it("closes the reasoning details overlay when the backdrop is pressed", async () => {
		const { target } = await mountSubject(createReasoningOverlayDetail());
		await flushUi();

		target.querySelector<HTMLButtonElement>(".thinking-section .chronicle-expand-button")?.click();
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeTruthy();

		target
			.querySelector<HTMLButtonElement>(".process-detail-overlay-backdrop")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await flushUi();
		expect(target.querySelector('[data-section="reasoning-details-overlay"]')).toBeNull();
	});
});
