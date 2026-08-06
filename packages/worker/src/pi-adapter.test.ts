import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
	PiCustomTool,
	PiEvent,
	PiPromptOptions,
	PiSessionDiagnostic,
	PiTerminalAcknowledgementControl,
	PiTerminalAcknowledgementState,
	PiTreeEntry,
	PiTreeNode,
} from "@leitwerk-dev/process-sdk";
import {
	createStubToolScriptController,
	StubPiTreeHandle,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it, vi } from "vitest";
import {
	SdkPiTreeHandle,
	TERMINAL_ACKNOWLEDGEMENT_INSTRUCTION,
	translateAgentSessionEventEnvelope,
} from "./pi-adapter.js";

function piEventsFromAgentSessionEvent(
	event: AgentSessionEvent,
	state: { currentTurnId: string | null; turnSequence: number },
): PiEvent[] {
	return translateAgentSessionEventEnvelope(event, state).piEvents;
}

function messageEntry(id: string, parentId: string | null): PiTreeEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: id.startsWith("user-") ? "user" : "assistant",
			content: id,
		},
	};
}

function buildTree(entries: readonly PiTreeEntry[]): PiTreeNode[] {
	const childIdsByParent = new Map<string | null, PiTreeEntry[]>();
	for (const entry of entries) {
		const siblings = childIdsByParent.get(entry.parentId) ?? [];
		siblings.push(entry);
		childIdsByParent.set(entry.parentId, siblings);
	}
	const buildNode = (entry: PiTreeEntry): PiTreeNode => ({
		entry,
		children: (childIdsByParent.get(entry.id) ?? []).map(buildNode),
	});
	return (childIdsByParent.get(null) ?? []).map(buildNode);
}

function outcomeTool(name: string, overrides: Partial<PiCustomTool> = {}): PiCustomTool {
	return {
		name,
		description: `${name} description`,
		parameters: {},
		execute: async () => ({ status: "ok", name }),
		...overrides,
	};
}

function createTerminalAcknowledgementControl(timeoutMs = 30_000) {
	let state: PiTerminalAcknowledgementState = "open";
	let operatorAbortRequested = false;
	let failureReason: string | null = null;
	const control: PiTerminalAcknowledgementControl = {
		timeoutMs,
		state: () => state,
		isOperatorAbortRequested: () => operatorAbortRequested,
		markSucceeded() {
			state = "acknowledgement_succeeded";
		},
		markFailed(reason) {
			state = "acknowledgement_failed_ignored";
			failureReason = reason;
		},
	};
	return {
		control,
		acceptOutcome() {
			state = "outcome_accepted";
		},
		requestOperatorAbort() {
			operatorAbortRequested = true;
		},
		state: () => state,
		failureReason: () => failureReason,
	};
}

function createFakeSdkHandle(
	options: {
		entries?: readonly PiTreeEntry[];
		leafId?: string | null;
		activeToolNames?: string[];
		customTools?: Array<{ name: string }>;
		includeTemporaryToolHooks?: boolean;
		isStreaming?: boolean;
		promptImpl?: (text: string) => Promise<void> | void;
		customMessageImpl?: (
			message: Parameters<AgentSession["sendCustomMessage"]>[0],
		) => Promise<void> | void;
		userMessageImpl?: (
			content: Parameters<AgentSession["sendUserMessage"]>[0],
		) => Promise<void> | void;
		continueImpl?: () => Promise<void> | void;
		waitForIdleImpl?: () => Promise<void> | void;
		retrySettings?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
		abortImpl?: () => Promise<void> | void;
		compactImpl?: () => Promise<unknown> | unknown;
	} = {},
) {
	let currentLeafId = options.leafId ?? null;
	let entries = [...(options.entries ?? [])];
	let activeToolNames = [...(options.activeToolNames ?? [])];
	const runtimeState = {
		isStreaming: options.isStreaming ?? false,
		isRetrying: false,
		isCompacting: false,
	};
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const unsubscribeFns: Array<ReturnType<typeof vi.fn>> = [];

	const sessionManager = {
		getLeafId: vi.fn(() => currentLeafId),
		getEntry: vi.fn((id: string) => entries.find((entry) => entry.id === id)),
		getBranch: vi.fn((fromId?: string) => {
			const startId = fromId ?? currentLeafId;
			if (!startId) {
				return [];
			}
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const branch: PiTreeEntry[] = [];
			let cursor: string | null = startId;
			while (cursor) {
				const entry = byId.get(cursor);
				if (!entry) {
					break;
				}
				branch.push(entry);
				cursor = entry.parentId;
			}
			branch.reverse();
			return branch;
		}),
		getChildren: vi.fn((parentId: string) =>
			entries.filter((entry) => entry.parentId === parentId),
		),
		getTree: vi.fn(() => buildTree(entries)),
		branch: vi.fn((entryId: string) => {
			currentLeafId = entryId;
		}),
		resetLeaf: vi.fn(() => {
			currentLeafId = null;
		}),
		appendCompaction: vi.fn(
			(summary: string, _firstKeptEntryId: string, _tokensBefore: number, details?: unknown) => {
				const entryId = `compaction-${
					entries.filter((entry) => entry.type === "compaction").length + 1
				}`;
				entries = [
					...entries,
					{
						id: entryId,
						parentId: currentLeafId,
						type: "compaction",
						timestamp: "2026-01-01T00:00:00.000Z",
						content: summary,
						details,
					},
				];
				currentLeafId = entryId;
				return entryId;
			},
		),
		getEntries: vi.fn(() => [...entries]),
		buildSessionContext: vi.fn(() => ({
			messages: [{ role: "system", content: `leaf:${currentLeafId ?? "root"}` }],
		})),
	};

	const sessionBase = {
		sessionId: "sdk-1",
		sessionManager,
		settingsManager: {
			getRetrySettings: vi.fn(
				() => options.retrySettings ?? { enabled: false, maxRetries: 3, baseDelayMs: 0 },
			),
		},
		agent: {
			state: { messages: [] as unknown[] },
			abort: vi.fn(),
			createLoopConfig: vi.fn(() => ({})),
			continue: vi.fn(async () => {
				await options.continueImpl?.();
			}),
		},
		prompt: vi.fn(async (text: string) => {
			await options.promptImpl?.(text);
		}),
		sendCustomMessage: vi.fn(async (message: Parameters<AgentSession["sendCustomMessage"]>[0]) => {
			await options.customMessageImpl?.(message);
		}),
		sendUserMessage: vi.fn(async (content: string | unknown[]) => {
			await options.userMessageImpl?.(content);
		}),
		compact: vi.fn(async () => await options.compactImpl?.()),
		steer: vi.fn(async (_text: string) => {}),
		abort: vi.fn(async () => {
			await options.abortImpl?.();
		}),
		waitForIdle: vi.fn(async () => {
			await options.waitForIdleImpl?.();
		}),
		subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			const unsubscribe = vi.fn(() => {
				listeners.delete(listener);
			});
			unsubscribeFns.push(unsubscribe);
			return unsubscribe;
		}),
		dispose: vi.fn(() => {}),
		getActiveToolNames: vi.fn(() => [...activeToolNames]),
		get isStreaming() {
			return runtimeState.isStreaming;
		},
		get isRetrying() {
			return runtimeState.isRetrying;
		},
		get isCompacting() {
			return runtimeState.isCompacting;
		},
	};

	const refreshToolRegistry = vi.fn((args?: { activeToolNames?: string[] }) => {
		if (args?.activeToolNames) {
			activeToolNames = [...args.activeToolNames];
		}
	});
	const sessionValue =
		options.includeTemporaryToolHooks === false
			? sessionBase
			: {
					...sessionBase,
					_customTools: [...(options.customTools ?? [{ name: "read" }])],
					_refreshToolRegistry: refreshToolRegistry,
				};

	const availableToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	return {
		handle: new SdkPiTreeHandle(sessionValue as unknown as AgentSession, {
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
			availableToolNames,
			runDetails: {
				loadedAgentsFiles: [],
				loadedSkills: [],
				availableToolNames,
			},
		}),
		session: sessionValue,
		sessionManager,
		unsubscribeFns,
		emitSessionEvent(event: AgentSessionEvent) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
		setRuntimeState(nextState: Partial<typeof runtimeState>) {
			Object.assign(runtimeState, nextState);
		},
		setEntries(nextEntries: readonly PiTreeEntry[]) {
			entries = [...nextEntries];
		},
		setLeafId(nextLeafId: string | null) {
			currentLeafId = nextLeafId;
		},
		getActiveToolNames() {
			return [...activeToolNames];
		},
	};
}

function terminalAcknowledgementOptions(
	acknowledgement: ReturnType<typeof createTerminalAcknowledgementControl>,
	overrides: Partial<PiPromptOptions> = {},
): PiPromptOptions {
	return {
		tools: [
			outcomeTool("plan_saved", {
				execute: async () => {
					acknowledgement.acceptOutcome();
					return { status: "ok", outcome: "plan_saved" };
				},
			}),
		],
		terminalAcknowledgement: acknowledgement.control,
		...overrides,
	};
}

async function acceptTerminalOutcome(
	harness: ReturnType<typeof createFakeSdkHandle>,
	toolName = "plan_saved",
): Promise<{
	toolResult: { content?: unknown; details?: unknown };
	stopDecision: unknown;
}> {
	const mutableSession = harness.session as typeof harness.session & {
		_customTools: Array<{
			name: string;
			execute: (
				toolCallId: string,
				args: Record<string, unknown>,
			) => Promise<{ content?: unknown; details?: unknown }>;
		}>;
	};
	const toolResult =
		(await mutableSession._customTools
			.find((tool) => tool.name === toolName)
			?.execute("call-1", {})) ?? {};
	const parentId = harness.handle.getLeafId();
	const outcomeAssistant = {
		...messageEntry("turn-outcome", parentId),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: {} }],
			stopReason: "toolUse",
		},
	} as PiTreeEntry;
	const outcomeResult = {
		...messageEntry("result-outcome", "turn-outcome"),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName,
			content: toolResult.content ?? [],
			details: toolResult.details,
			isError: false,
		},
	} as PiTreeEntry;
	harness.setEntries([
		...(harness.sessionManager.getEntries() as PiTreeEntry[]),
		outcomeAssistant,
		outcomeResult,
	]);
	harness.setLeafId("result-outcome");
	const stopDecision = await harness.session.agent.createLoopConfig().shouldStopAfterTurn?.({
		message: outcomeAssistant.message,
	});
	return { toolResult, stopDecision };
}

async function runAcknowledgementScenario(input: {
	text?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}) {
	const acknowledgement = createTerminalAcknowledgementControl();
	let accepted!: Awaited<ReturnType<typeof acceptTerminalOutcome>>;
	let acknowledgementStopDecision: unknown;
	let harness!: ReturnType<typeof createFakeSdkHandle>;
	harness = createFakeSdkHandle({
		entries: [messageEntry("user-1", null), messageEntry("user-2", "user-1")],
		leafId: "user-2",
		continueImpl: async () => {
			accepted = await acceptTerminalOutcome(harness);
			const response = {
				...messageEntry("turn-ack", "result-outcome"),
				message: {
					role: "assistant",
					content: input.content ?? (input.text ? [{ type: "text", text: input.text }] : []),
					stopReason: input.stopReason ?? "stop",
					...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
				},
			} as PiTreeEntry;
			harness.setEntries([...(harness.sessionManager.getEntries() as PiTreeEntry[]), response]);
			harness.setLeafId("turn-ack");
			acknowledgementStopDecision = await harness.session.agent
				.createLoopConfig()
				.shouldStopAfterTurn?.({ message: response.message });
		},
	});
	const result = await harness.handle.continueTurn(terminalAcknowledgementOptions(acknowledgement));
	return { acknowledgement, acknowledgementStopDecision, accepted, result };
}

function createScriptedPromptAcknowledgement(input: {
	timeoutMs?: number;
	afterOutcome(
		harness: ReturnType<typeof createFakeSdkHandle>,
		acknowledgement: ReturnType<typeof createTerminalAcknowledgementControl>,
	): Promise<void> | void;
	onAbort?(harness: ReturnType<typeof createFakeSdkHandle>): Promise<void> | void;
	promptOptions?: Partial<PiPromptOptions>;
}) {
	const acknowledgement = createTerminalAcknowledgementControl(input.timeoutMs);
	let harness!: ReturnType<typeof createFakeSdkHandle>;
	harness = createFakeSdkHandle({
		entries: [messageEntry("user-1", null)],
		leafId: "user-1",
		promptImpl: async () => {
			await acceptTerminalOutcome(harness);
			await input.afterOutcome(harness, acknowledgement);
		},
		abortImpl: async () => await input.onAbort?.(harness),
	});
	return {
		acknowledgement,
		harness,
		run: () =>
			harness.handle.prompt(
				"Plan this",
				terminalAcknowledgementOptions(acknowledgement, input.promptOptions),
			),
	};
}

function createRetryingContinuationHarness(options: {
	errorMessages: readonly string[];
	baseDelayMs?: number;
	activeToolNames?: string[];
	customTools?: Array<{ name: string }>;
	beforeProviderCall?: (call: number) => Promise<void> | void;
	afterSuccessfulCall?: (entry: PiTreeEntry) => Promise<void> | void;
}) {
	const initialEntries = [messageEntry("user-1", null)];
	const modelInputs: unknown[][] = [];
	const activeToolsByCall: string[][] = [];
	let providerCalls = 0;
	let harness!: ReturnType<typeof createFakeSdkHandle>;
	harness = createFakeSdkHandle({
		entries: initialEntries,
		leafId: "user-1",
		activeToolNames: options.activeToolNames,
		customTools: options.customTools,
		retrySettings: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: options.baseDelayMs ?? 0,
		},
		continueImpl: async () => {
			providerCalls += 1;
			await options.beforeProviderCall?.(providerCalls);
			modelInputs.push([...harness.session.agent.state.messages]);
			activeToolsByCall.push(harness.getActiveToolNames());
			const errorMessage = options.errorMessages[providerCalls - 1];
			const succeeded = errorMessage === undefined;
			const id = `turn-${providerCalls}`;
			const entry = {
				...messageEntry(id, harness.handle.getLeafId()),
				message: {
					role: "assistant",
					content: succeeded ? [{ type: "text", text: "success" }] : [],
					stopReason: succeeded ? "end_turn" : "error",
					...(!succeeded
						? {
								errorMessage: errorMessage ?? options.errorMessages.at(-1) ?? "WebSocket error",
							}
						: {}),
				},
			} as PiTreeEntry;
			harness.setEntries([...(harness.sessionManager.getEntries() as PiTreeEntry[]), entry]);
			harness.setLeafId(id);
			harness.session.agent.state.messages.push(entry.message);
			if (succeeded) await options.afterSuccessfulCall?.(entry);
		},
	});
	return {
		harness,
		modelInputs,
		activeToolsByCall,
		providerCalls: () => providerCalls,
	};
}

describe("translateAgentSessionEvent", () => {
	it("increments the turn sequence when turn_start omits turnIndex", () => {
		const state = { currentTurnId: null as string | null, turnSequence: 0 };

		const events = piEventsFromAgentSessionEvent(
			{
				type: "turn_start",
				timestamp: 1_700_000_000_000,
			} as AgentSessionEvent,
			state,
		);

		expect(events).toEqual([
			{
				type: "turn.start",
				turnId: "turn-1",
				data: {},
				timestamp: new Date(1_700_000_000_000).toISOString(),
			},
		]);
		expect(state).toEqual({ currentTurnId: "turn-1", turnSequence: 1 });
	});

	it("uses the sequence fallback when turn_end arrives without a preceding turn_start", () => {
		const state = { currentTurnId: null as string | null, turnSequence: 3 };

		const events = piEventsFromAgentSessionEvent(
			{
				type: "turn_end",
				message: { timestamp: "2026-01-01T00:00:03.000Z" },
			} as AgentSessionEvent,
			state,
		);

		expect(events).toEqual([
			{
				type: "turn.end",
				turnId: "turn-3",
				data: {},
				timestamp: "2026-01-01T00:00:03.000Z",
			},
		]);
		expect(state.currentTurnId).toBeNull();
	});

	it("drops message updates when there is no active turn", () => {
		const state = { currentTurnId: null as string | null, turnSequence: 0 };

		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "message_update",
					message: { timestamp: "2026-01-01T00:00:01.000Z" },
					assistantMessageEvent: { type: "text_delta", delta: "hello" },
				} as AgentSessionEvent,
				state,
			),
		).toEqual([]);
	});

	it("maps thinking deltas to thinking stream events", () => {
		const state = { currentTurnId: "turn-2", turnSequence: 2 };

		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "message_update",
					message: { timestamp: "2026-01-01T00:00:02.000Z" },
					assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
				} as AgentSessionEvent,
				state,
			),
		).toEqual([
			{
				type: "stream.delta",
				turnId: "turn-2",
				data: {
					text: "thinking...",
					streamType: "thinking",
				},
				timestamp: "2026-01-01T00:00:02.000Z",
			},
		]);
	});

	it("emits usage events from assistant message_end usage data", () => {
		const state = { currentTurnId: "turn-4", turnSequence: 4 };

		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "message_end",
					message: {
						role: "assistant",
						usage: {
							input: 100,
							output: 20,
							reasoning: 12,
							cacheRead: 300,
							cacheWrite: 40,
							totalTokens: 460,
							cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 },
						},
						timestamp: "2026-01-01T00:00:04.000Z",
					},
				} as AgentSessionEvent,
				state,
			),
		).toEqual([
			{
				type: "usage",
				turnId: "turn-4",
				data: {
					input: 100,
					output: 20,
					reasoning: 12,
					cacheRead: 300,
					cacheWrite: 40,
					totalTokens: 460,
					cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 },
					cacheHitRate: 0.75,
				},
				timestamp: "2026-01-01T00:00:04.000Z",
			},
		]);
	});

	it("maps assistant message_end errors to pi.error events", () => {
		const state = { currentTurnId: "turn-4", turnSequence: 4 };

		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "connection refused",
						provider: "ollama",
						model: "qwen2.5-coder:14b",
						timestamp: "2026-01-01T00:00:04.000Z",
					},
				} as AgentSessionEvent,
				state,
			),
		).toEqual([
			{
				type: "error",
				turnId: "turn-4",
				data: {
					message: "connection refused",
					errorMessage: "connection refused",
					stopReason: "error",
					source: "assistant",
					provider: "ollama",
					model: "qwen2.5-coder:14b",
				},
				timestamp: "2026-01-01T00:00:04.000Z",
			},
		]);
	});

	it("maps auto-retry lifecycle events to pi retry events", () => {
		const state = { currentTurnId: "turn-5", turnSequence: 5 };

		const retryStartEvents = piEventsFromAgentSessionEvent(
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 2_000,
				errorMessage: "connection refused",
			} as AgentSessionEvent,
			state,
		);
		expect(retryStartEvents).toEqual([
			expect.objectContaining({
				type: "retry.start",
				turnId: "turn-5",
				data: expect.objectContaining({
					attempt: 1,
					maxAttempts: 3,
					delayMs: 2_000,
					errorMessage: "connection refused",
					message: "Retry 1/3 scheduled in 2000ms: connection refused",
				}),
			}),
		]);

		const retryEndEvents = piEventsFromAgentSessionEvent(
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "connection refused",
			} as AgentSessionEvent,
			state,
		);
		expect(retryEndEvents).toEqual([
			expect.objectContaining({
				type: "retry.end",
				turnId: "turn-5",
				data: expect.objectContaining({
					success: false,
					attempt: 3,
					finalError: "connection refused",
					message: "Retry sequence failed after 3 retries: connection refused",
				}),
			}),
		]);
	});

	it("emits both tool.result and error when a tool execution ends in error", () => {
		const state = { currentTurnId: null as string | null, turnSequence: 0 };

		const events = piEventsFromAgentSessionEvent(
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "plan_saved",
				result: "tool exploded",
				isError: true,
			} as AgentSessionEvent,
			state,
		);

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			type: "tool.result",
			turnId: "turn-tool-tool-1",
			data: {
				toolCallId: "tool-1",
				name: "plan_saved",
				result: "tool exploded",
				isError: true,
			},
		});
		expect(events[1]).toMatchObject({
			type: "error",
			turnId: "turn-tool-tool-1",
			data: {
				message: "tool exploded",
				toolName: "plan_saved",
			},
		});
	});

	it("preserves tool execution partial updates", () => {
		const state = { currentTurnId: "turn-6", turnSequence: 6 };

		const events = piEventsFromAgentSessionEvent(
			{
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "ls -la" },
				partialResult: {
					content: [{ type: "text", text: "partial output so far..." }],
					details: { truncation: null, fullOutputPath: null },
				},
				timestamp: "2026-01-01T00:00:06.000Z",
			} as AgentSessionEvent,
			state,
		);

		expect(events).toEqual([
			{
				type: "tool.update",
				turnId: "turn-6",
				data: {
					toolCallId: "tool-1",
					name: "bash",
					arguments: { command: "ls -la" },
					partialResult: {
						content: [{ type: "text", text: "partial output so far..." }],
						details: { truncation: null, fullOutputPath: null },
					},
					timestamp: "2026-01-01T00:00:06.000Z",
				},
				timestamp: "2026-01-01T00:00:06.000Z",
			},
		]);
	});

	it("extracts assistant toolcall streaming events from partial toolcall blocks", () => {
		const state = { currentTurnId: "turn-7", turnSequence: 7 };

		const startEvents = piEventsFromAgentSessionEvent(
			{
				type: "message_update",
				message: { timestamp: "2026-01-01T00:00:07.000Z" },
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						content: [
							{
								type: "toolCall",
								id: "call-1",
								name: "bash",
								arguments: {},
							},
						],
					},
				},
			} as AgentSessionEvent,
			state,
		);
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({
			type: "toolcall.start",
			turnId: "turn-7",
			data: {
				contentIndex: 0,
				toolCallId: "call-1",
				name: "bash",
				arguments: {},
			},
			timestamp: "2026-01-01T00:00:07.000Z",
		});
		expect(startEvents[0].data).not.toHaveProperty("partial");

		const deltaEvents = piEventsFromAgentSessionEvent(
			{
				type: "message_update",
				message: { timestamp: "2026-01-01T00:00:07.100Z" },
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"command":"ls',
					partial: {
						content: [
							{
								type: "toolCall",
								id: "call-1",
								name: "bash",
								arguments: { command: "ls" },
							},
						],
					},
				},
			} as AgentSessionEvent,
			state,
		);
		expect(deltaEvents).toHaveLength(1);
		expect(deltaEvents[0]).toMatchObject({
			type: "toolcall.delta",
			turnId: "turn-7",
			data: {
				contentIndex: 0,
				toolCallId: "call-1",
				name: "bash",
				arguments: { command: "ls" },
				delta: '{"command":"ls',
			},
			timestamp: "2026-01-01T00:00:07.100Z",
		});
		expect(deltaEvents[0].data).not.toHaveProperty("partial");

		const endEvents = piEventsFromAgentSessionEvent(
			{
				type: "message_update",
				message: { timestamp: "2026-01-01T00:00:07.300Z" },
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: {
						type: "toolCall",
						id: "call-2",
						name: "bash",
						arguments: { command: "pwd" },
					},
					partial: {
						content: [
							{
								type: "toolCall",
								id: "call-2",
								name: "bash",
								arguments: { command: "pwd" },
							},
						],
					},
				},
			} as AgentSessionEvent,
			state,
		);
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "toolcall.end",
			turnId: "turn-7",
			data: {
				contentIndex: 0,
				toolCallId: "call-2",
				name: "bash",
				arguments: { command: "pwd" },
			},
			timestamp: "2026-01-01T00:00:07.300Z",
		});
		expect(endEvents[0].data).not.toHaveProperty("partial");
	});

	it("preserves compaction lifecycle events", () => {
		const state = { currentTurnId: "turn-8", turnSequence: 8 };

		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "compaction_start",
					reason: "threshold",
					timestamp: "2026-01-01T00:00:08.000Z",
				} as AgentSessionEvent,
				state,
			),
		).toEqual([
			{
				type: "compaction.start",
				turnId: "turn-8",
				data: {
					reason: "threshold",
					timestamp: "2026-01-01T00:00:08.000Z",
				},
				timestamp: "2026-01-01T00:00:08.000Z",
			},
		]);
		expect(
			piEventsFromAgentSessionEvent(
				{
					type: "compaction_end",
					reason: "threshold",
					result: {
						summary: "Summary of conversation...",
						firstKeptEntryId: "abc123",
						tokensBefore: 150000,
						details: {},
					},
					aborted: false,
					willRetry: false,
					timestamp: "2026-01-01T00:00:08.500Z",
				} as AgentSessionEvent,
				state,
			),
		).toEqual([
			{
				type: "compaction.end",
				turnId: "turn-8",
				data: {
					reason: "threshold",
					result: {
						summary: "Summary of conversation...",
						firstKeptEntryId: "abc123",
						tokensBefore: 150000,
						details: {},
					},
					aborted: false,
					willRetry: false,
					timestamp: "2026-01-01T00:00:08.500Z",
				},
				timestamp: "2026-01-01T00:00:08.500Z",
			},
		]);
	});

	it("persists supplied compaction details through the SDK compaction append", async () => {
		const details = { kind: "leitwerk_turn_compaction", turnRecordId: "turn-record-1" };
		const { handle, sessionManager } = createFakeSdkHandle({
			compactImpl: () => {
				sessionManager.appendCompaction("summary", "kept-1", 42, { sdk: "details" });
			},
		});

		await handle.compact(undefined, details);

		expect(sessionManager.getEntry("compaction-1")).toMatchObject({
			type: "compaction",
			content: "summary",
			details,
		});
	});

	it("restores the SDK compaction append method when compaction fails", async () => {
		const failure = new Error("compaction failed");
		const { handle, sessionManager } = createFakeSdkHandle({
			compactImpl: () => {
				throw failure;
			},
		});
		const appendCompaction = sessionManager.appendCompaction;

		await expect(handle.compact(undefined, { kind: "leitwerk_turn_compaction" })).rejects.toBe(
			failure,
		);

		expect(sessionManager.appendCompaction).toBe(appendCompaction);
	});

	it("rejects a detailed compaction when Pi does not append exactly one entry", async () => {
		const { handle } = createFakeSdkHandle({ compactImpl: () => undefined });

		await expect(handle.compact(undefined, { kind: "leitwerk_turn_compaction" })).rejects.toThrow(
			"expected one append, received 0",
		);
	});

	it("summarizes session-global diagnostics without persisting raw queue or message content", () => {
		const state = { currentTurnId: null as string | null, turnSequence: 0 };
		const queueUpdate = {
			type: "queue_update",
			steering: ["Focus on secret token abc123"],
			followUp: ["Summarize hidden branch name"],
			timestamp: "2026-01-01T00:00:09.000Z",
		} as AgentSessionEvent;

		expect(piEventsFromAgentSessionEvent(queueUpdate, state)).toEqual([]);
		const queueEnvelope = translateAgentSessionEventEnvelope(queueUpdate, state);
		expect(queueEnvelope).toEqual({
			piEvents: [],
			diagnostics: [
				expect.objectContaining({
					level: "info",
					code: "pi.queue_update",
					timestamp: "2026-01-01T00:00:09.000Z",
					details: expect.objectContaining({
						category: "session_global",
						eventType: "queue_update",
						steeringCount: 1,
						followUpCount: 1,
					}),
				}),
			],
		});
		expect(queueEnvelope.diagnostics[0]?.details).not.toHaveProperty("event");
		expect(JSON.stringify(queueEnvelope.diagnostics[0])).not.toContain("secret token abc123");
		expect(JSON.stringify(queueEnvelope.diagnostics[0])).not.toContain("hidden branch name");

		const agentEnd = translateAgentSessionEventEnvelope(
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "private answer" }] },
					{ role: "toolResult", content: [{ type: "text", text: "private tool output" }] },
				],
				timestamp: "2026-01-01T00:00:09.100Z",
			} as AgentSessionEvent,
			state,
		);
		expect(agentEnd.piEvents).toEqual([]);
		expect(agentEnd.diagnostics).toEqual([
			expect.objectContaining({
				code: "pi.agent_end",
				details: expect.objectContaining({
					category: "session_global",
					eventType: "agent_end",
					messageCount: 2,
					roles: ["assistant", "toolResult"],
				}),
			}),
		]);
		expect(agentEnd.diagnostics[0]?.details).not.toHaveProperty("event");
		expect(JSON.stringify(agentEnd.diagnostics[0])).not.toContain("private answer");
		expect(JSON.stringify(agentEnd.diagnostics[0])).not.toContain("private tool output");

		const agentSettled = translateAgentSessionEventEnvelope(
			{ type: "agent_settled" } as AgentSessionEvent,
			state,
		);
		expect(agentSettled.piEvents).toEqual([]);
		expect(agentSettled.diagnostics).toEqual([
			expect.objectContaining({
				level: "info",
				code: "pi.agent_settled",
				details: expect.objectContaining({
					category: "session_global",
					eventType: "agent_settled",
				}),
			}),
		]);
	});

	it("emits unknown-event diagnostics instead of silently dropping them", () => {
		const state = { currentTurnId: "turn-9", turnSequence: 9 };
		const topLevel = translateAgentSessionEventEnvelope(
			{
				type: "agent_sidecar_ping",
				payload: { foo: "bar", secret: "should-not-leak" },
				timestamp: "2026-01-01T00:00:10.000Z",
			} as AgentSessionEvent,
			state,
		);
		expect(topLevel.piEvents).toEqual([]);
		expect(topLevel.diagnostics).toEqual([
			expect.objectContaining({
				level: "warn",
				code: "pi.session.event_unknown",
				turnId: "turn-9",
				timestamp: "2026-01-01T00:00:10.000Z",
				details: expect.objectContaining({
					kind: "session.event.unknown",
					scope: "agent_session_event",
					eventType: "agent_sidecar_ping",
					keys: expect.arrayContaining(["payload", "timestamp"]),
				}),
			}),
		]);
		expect(topLevel.diagnostics[0]?.details).not.toHaveProperty("event");
		expect(JSON.stringify(topLevel.diagnostics[0])).not.toContain("should-not-leak");

		const nested = translateAgentSessionEventEnvelope(
			{
				type: "message_update",
				message: { timestamp: "2026-01-01T00:00:10.100Z" },
				assistantMessageEvent: {
					type: "toolcall_chunk_boundary",
					contentIndex: 0,
					partial: {
						content: [
							{ type: "toolCall", id: "call-9", name: "bash", arguments: { command: "pwd" } },
						],
					},
				},
			} as AgentSessionEvent,
			state,
		);
		expect(nested.piEvents).toEqual([]);
		expect(nested.diagnostics).toEqual([
			expect.objectContaining({
				level: "warn",
				code: "pi.session.event_unknown",
				turnId: "turn-9",
				timestamp: "2026-01-01T00:00:10.100Z",
				details: expect.objectContaining({
					kind: "session.event.unknown",
					scope: "assistant_message_event",
					assistantEventType: "toolcall_chunk_boundary",
					contentIndex: 0,
					keys: expect.arrayContaining(["contentIndex", "partial"]),
				}),
			}),
		]);
		expect(nested.diagnostics[0]?.details).not.toHaveProperty("event");
		expect(JSON.stringify(nested.diagnostics[0])).not.toContain('"command":"pwd"');
	});
});

describe("SdkPiTreeHandle", () => {
	it("delegates getLeafId to the session manager", () => {
		const { handle, sessionManager } = createFakeSdkHandle({ leafId: "leaf-42" });

		expect(handle.getLeafId()).toBe("leaf-42");
		expect(sessionManager.getLeafId).toHaveBeenCalledOnce();
	});

	it("delegates getEntry, getChildren, and getTree to the session manager", () => {
		const entries = [messageEntry("root-1", null), messageEntry("child-1", "root-1")];
		const { handle, sessionManager } = createFakeSdkHandle({
			entries,
			leafId: "child-1",
		});

		expect(handle.getEntry("child-1")).toEqual(entries[1]);
		expect(handle.getChildren("root-1")).toEqual([entries[1]]);
		expect(handle.getTree()).toEqual(buildTree(entries));
		expect(sessionManager.getEntry).toHaveBeenCalledWith("child-1");
		expect(sessionManager.getChildren).toHaveBeenCalledWith("root-1");
		expect(sessionManager.getTree).toHaveBeenCalledOnce();
	});

	it("branches to an entry id and refreshes agent messages", async () => {
		const { handle, session, sessionManager } = createFakeSdkHandle({
			entries: [messageEntry("root", null), messageEntry("child-1", "root")],
			leafId: "child-1",
		});

		await handle.branch("root");

		expect(sessionManager.branch).toHaveBeenCalledWith("root");
		expect(sessionManager.resetLeaf).not.toHaveBeenCalled();
		expect(session.agent.state.messages).toEqual([{ role: "system", content: "leaf:root" }]);
	});

	it("branches from root without overloading a magic entry id", async () => {
		const { handle, session, sessionManager } = createFakeSdkHandle({
			entries: [messageEntry("root", null), messageEntry("child-1", "root")],
			leafId: "child-1",
		});

		await handle.branchFromRoot();

		expect(sessionManager.resetLeaf).toHaveBeenCalledOnce();
		expect(sessionManager.branch).not.toHaveBeenCalled();
		expect(session.agent.state.messages).toEqual([{ role: "system", content: "leaf:root" }]);
	});

	it("computes createdEntryIds by diffing entries before and after prompt", async () => {
		const initialEntries = [messageEntry("user-1", null), messageEntry("turn-1", "user-1")];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "turn-1",
			promptImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("user-2", "turn-1"),
					messageEntry("turn-2", "user-2"),
				]);
				harness.setLeafId("turn-2");
			},
		});

		const promptResult = await harness.handle.prompt("Continue the work");

		expect(promptResult).toEqual({
			startLeafId: "turn-1",
			endLeafId: "turn-2",
			createdEntryIds: ["user-2", "turn-2"],
			resultEntryId: "turn-2",
			assistantMarkdown: "turn-2",
		});
		expect(harness.session.prompt).toHaveBeenCalledWith("Continue the work");
	});

	it.each([
		[
			"rejects prompt results that finish on a sibling branch",
			false,
			{ errorClass: "infrastructure" },
		],
		["rejects prompt failures that move the leaf to a sibling branch", true, {}],
	] as const)("%s", async (_name, throwAfterDrift, expected) => {
		const initialEntries = [messageEntry("user-plan", null), messageEntry("plan", "user-plan")];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "plan",
			promptImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("user-implementation", "plan"),
					messageEntry("turn-implementation", "user-implementation"),
					messageEntry("user-continue", "plan"),
					messageEntry("turn-final", "user-continue"),
				]);
				harness.setLeafId("turn-final");
				if (throwAfterDrift) {
					throw new Error("provider failed after writing a stale leaf");
				}
			},
		});

		await expect(harness.handle.prompt("Implement the approved plan")).rejects.toMatchObject({
			name: "PiBranchDriftError",
			anchorEntryId: "user-implementation",
			rejectedResultEntryId: "turn-final",
			...expected,
		});
	});

	it("reads prompt results only from the selected result branch", async () => {
		const initialEntries = [messageEntry("user-1", null), messageEntry("turn-1", "user-1")];
		const staleSiblingAssistant: PiTreeEntry = {
			...messageEntry("turn-stale", "user-stale"),
			message: {
				role: "assistant",
				content: "Stale sibling markdown",
				stopReason: "error",
				errorMessage: "stale branch provider error",
			} as PiTreeEntry["message"],
		};
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "turn-1",
			promptImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("user-2", "turn-1"),
					{
						...messageEntry("turn-success", "user-2"),
						message: { role: "assistant", content: "Result branch markdown" },
					},
					messageEntry("user-stale", "user-2"),
					staleSiblingAssistant,
				]);
				harness.setLeafId("turn-success");
			},
		});

		const result = await harness.handle.prompt("Continue safely");

		expect(result.resultEntryId).toBe("turn-success");
		expect(result.assistantMarkdown).toBe("Result branch markdown");
	});

	it("continues from the current leaf without appending another user prompt", async () => {
		const initialEntries = [
			messageEntry("user-1", null),
			messageEntry("turn-1", "user-1"),
			messageEntry("user-2", "turn-1"),
		];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "user-2",
			continueImpl: async () => {
				harness.setEntries([...initialEntries, messageEntry("turn-2", "user-2")]);
				harness.setLeafId("turn-2");
			},
		});

		const result = await harness.handle.continueTurn({ tools: [outcomeTool("done")] });

		expect(result).toEqual({
			startLeafId: "user-2",
			endLeafId: "turn-2",
			createdEntryIds: ["turn-2"],
			resultEntryId: "turn-2",
			assistantMarkdown: "turn-2",
		});
		expect(harness.session.agent.continue).toHaveBeenCalledOnce();
		expect(harness.session.prompt).not.toHaveBeenCalled();
	});

	it.each([
		"done",
		"Acknowledged.",
	])("accepts one non-empty terminal outcome acknowledgement: %s", async (acknowledgementText) => {
		const scenario = await runAcknowledgementScenario({ text: acknowledgementText });

		expect(scenario.accepted.stopDecision).toBe(false);
		expect(scenario.acknowledgementStopDecision).toBe(true);
		expect(scenario.acknowledgement.state()).toBe("acknowledgement_succeeded");
		expect(scenario.accepted.toolResult).toMatchObject({
			content: [{ type: "text", text: TERMINAL_ACKNOWLEDGEMENT_INSTRUCTION }],
			details: { status: "ok", outcome: "plan_saved" },
		});
		expect(scenario.result.resultEntryId).toBe("turn-ack");
		expect(scenario.result.assistantMarkdown).toBe(acknowledgementText);
	});

	it("keeps provider retries active inside the acknowledgement budget", async () => {
		const acknowledgement = createTerminalAcknowledgementControl();
		let state!: ReturnType<typeof createRetryingContinuationHarness>;
		state = createRetryingContinuationHarness({
			errorMessages: ["WebSocket error"],
			beforeProviderCall: async (call) => {
				if (call === 1) await acceptTerminalOutcome(state.harness);
			},
			afterSuccessfulCall: async (entry) => {
				await state.harness.session.agent
					.createLoopConfig()
					.shouldStopAfterTurn?.({ message: entry.message });
			},
		});
		const retryEvents: PiEvent[] = [];
		state.harness.handle.subscribe((event) => retryEvents.push(event));

		const result = await state.harness.handle.continueTurn(
			terminalAcknowledgementOptions(acknowledgement),
		);

		expect(state.providerCalls()).toBe(2);
		expect(acknowledgement.state()).toBe("acknowledgement_succeeded");
		expect(result.resultEntryId).toBe("turn-2");
		expect(retryEvents.map((event) => event.type)).toEqual(["retry.start", "retry.end"]);
	});

	it("shares one acknowledgement timeout across provider retries", async () => {
		vi.useFakeTimers();
		try {
			const acknowledgement = createTerminalAcknowledgementControl(50);
			let state!: ReturnType<typeof createRetryingContinuationHarness>;
			state = createRetryingContinuationHarness({
				errorMessages: ["WebSocket error", "WebSocket error"],
				baseDelayMs: 20,
				beforeProviderCall: async (call) => {
					if (call === 1) await acceptTerminalOutcome(state.harness);
				},
			});

			const run = state.harness.handle.continueTurn(
				terminalAcknowledgementOptions(acknowledgement),
			);
			await vi.advanceTimersByTimeAsync(20);
			expect(state.providerCalls()).toBe(2);
			await vi.advanceTimersByTimeAsync(30);
			await run;

			expect(state.providerCalls()).toBe(2);
			expect(state.harness.session.abort).toHaveBeenCalledOnce();
			expect(acknowledgement.failureReason()).toContain("exceeded 50ms");
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["provider error", [], "error", "provider unavailable", "provider unavailable"],
		["empty output", [], "stop", undefined, "stop"],
		[
			"malformed output",
			[{ type: "unexpected", value: "not assistant text" }],
			"stop",
			undefined,
			"stop",
		],
	] as const)("ignores terminal acknowledgement %s", async (_label, content, stopReason, errorMessage, expectedReason) => {
		const scenario = await runAcknowledgementScenario({
			content,
			stopReason,
			errorMessage,
		});

		expect(scenario.acknowledgement.state()).toBe("acknowledgement_failed_ignored");
		expect(scenario.acknowledgement.failureReason()).toContain(expectedReason);
		expect(scenario.result.resultEntryId).toBe("turn-ack");
	});

	it("aborts and ignores a terminal acknowledgement timeout", async () => {
		let releaseAcknowledgement!: () => void;
		const acknowledgementPending = new Promise<void>((resolve) => {
			releaseAcknowledgement = resolve;
		});
		const scenario = createScriptedPromptAcknowledgement({
			timeoutMs: 10,
			afterOutcome: async () => await acknowledgementPending,
			onAbort: (harness) => {
				const abortedAssistant = {
					...messageEntry("turn-aborted", "result-outcome"),
					message: { role: "assistant", content: [], stopReason: "aborted" },
				} as PiTreeEntry;
				harness.setEntries([
					...(harness.sessionManager.getEntries() as PiTreeEntry[]),
					abortedAssistant,
				]);
				harness.setLeafId("turn-aborted");
				releaseAcknowledgement();
			},
		});

		const result = await scenario.run();

		expect(scenario.harness.session.abort).toHaveBeenCalledOnce();
		expect(scenario.acknowledgement.state()).toBe("acknowledgement_failed_ignored");
		expect(scenario.acknowledgement.failureReason()).toContain("exceeded 10ms");
		expect(result.resultEntryId).toBe("turn-aborted");
	});

	it("fails bounded cleanup when abort does not settle the acknowledgement run", async () => {
		vi.useFakeTimers();
		try {
			const scenario = createScriptedPromptAcknowledgement({
				timeoutMs: 10,
				afterOutcome: async () => await new Promise<void>(() => {}),
			});
			const failure = expect(scenario.run()).rejects.toThrow(
				"Timed-out terminal acknowledgement did not stop within 1000ms",
			);

			await vi.advanceTimersByTimeAsync(1_010);
			await failure;

			expect(scenario.harness.session.abort).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("blocks acknowledgement tools without hiding a later infrastructure failure", async () => {
		let blockDecision: unknown;
		const scenario = createScriptedPromptAcknowledgement({
			afterOutcome: async (harness) => {
				blockDecision = await harness.session.agent.beforeToolCall?.({
					toolCall: { name: "bash" },
				});
				throw new Error("local runtime corruption");
			},
			promptOptions: { shouldBlockToolCall: (toolName) => `blocked ${toolName}` },
		});

		await expect(scenario.run()).rejects.toThrow("local runtime corruption");
		expect(blockDecision).toEqual({ block: true, reason: "blocked bash" });
		expect(scenario.acknowledgement.failureReason()).toContain("attempted blocked tool 'bash'");
	});

	it("does not ignore an operator abort during acknowledgement", async () => {
		const scenario = createScriptedPromptAcknowledgement({
			afterOutcome: (_harness, acknowledgement) => {
				acknowledgement.requestOperatorAbort();
				throw new Error("operator abort");
			},
		});

		await expect(scenario.run()).rejects.toThrow("operator abort");
	});

	it("surfaces failure to abort a timed-out acknowledgement", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scenario = createScriptedPromptAcknowledgement({
			timeoutMs: 10,
			afterOutcome: async () => await pending,
			onAbort: () => {
				release();
				throw new Error("abort transport corrupt");
			},
		});

		await expect(scenario.run()).rejects.toThrow(
			"Failed to abort timed-out terminal acknowledgement",
		);
	});

	it.each([
		["rejects continuations that finish away from the starting leaf", false],
		["rejects continuation failures that move the leaf away from the starting branch", true],
	])("%s", async (_name, throwAfterDrift) => {
		const initialEntries = [
			messageEntry("user-1", null),
			messageEntry("turn-1", "user-1"),
			messageEntry("user-2", "turn-1"),
		];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "user-2",
			continueImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("turn-2", "user-2"),
					messageEntry("turn-final", "turn-1"),
				]);
				harness.setLeafId("turn-final");
				if (throwAfterDrift) {
					throw new Error("provider failed after writing a stale leaf");
				}
			},
		});

		await expect(harness.handle.continueTurn()).rejects.toMatchObject({
			name: "PiBranchDriftError",
			anchorEntryId: "user-2",
			rejectedResultEntryId: "turn-final",
		});
	});

	it("delegates steer to the underlying session", async () => {
		const { handle, session } = createFakeSdkHandle();

		await handle.steer("Follow this guidance");

		expect(session.steer).toHaveBeenCalledWith("Follow this guidance");
	});

	it("delegates abortTurn to the underlying session", async () => {
		const { handle, session } = createFakeSdkHandle();

		await handle.abortTurn();

		expect(session.abort).toHaveBeenCalledOnce();
	});

	it("uses no active built-in tools when prompt options omit activeTools", async () => {
		const initialEntries = [messageEntry("user-1", null), messageEntry("turn-1", "user-1")];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "turn-1",
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("user-2", "turn-1"),
					messageEntry("turn-2", "user-2"),
				]);
				harness.setLeafId("turn-2");
			},
		});
		const mutableSession = harness.session as {
			_refreshToolRegistry: ReturnType<typeof vi.fn>;
		};

		await harness.handle.prompt("Review without tools");

		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(1, {
			activeToolNames: [],
		});
		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(2, {
			activeToolNames: ["read"],
		});
		expect(harness.getActiveToolNames()).toEqual(["read"]);
	});

	it("applies prompt-specific active built-in tools and restores the previous active set afterward", async () => {
		const initialEntries = [messageEntry("user-1", null), messageEntry("turn-1", "user-1")];
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "turn-1",
			activeToolNames: ["read", "bash"],
			customTools: [{ name: "read" }, { name: "bash" }],
			promptImpl: async () => {
				harness.setEntries([
					...initialEntries,
					messageEntry("user-2", "turn-1"),
					messageEntry("turn-2", "user-2"),
				]);
				harness.setLeafId("turn-2");
			},
		});
		const { handle, session, getActiveToolNames } = harness;
		const mutableSession = session as {
			_customTools: Array<{ name: string }>;
			_refreshToolRegistry: ReturnType<typeof vi.fn>;
		};

		await handle.prompt("Review this", {
			activeTools: ["read", "grep"],
			tools: [outcomeTool("done")],
		});

		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(1, {
			activeToolNames: ["read", "grep", "done"],
		});
		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(2, {
			activeToolNames: ["read", "bash"],
		});
		expect(getActiveToolNames()).toEqual(["read", "bash"]);
	});

	it("registers array item schemas for temporary tools", async () => {
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		let registeredParameters: Record<string, unknown> | undefined;
		harness = createFakeSdkHandle({
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				const mutableSession = harness.session as {
					_customTools: Array<{ name: string; parameters?: Record<string, unknown> }>;
				};
				registeredParameters = mutableSession._customTools.find(
					(tool) => tool.name === "plan_saved",
				)?.parameters;
				harness.setEntries([messageEntry("user-1", null), messageEntry("turn-1", "user-1")]);
				harness.setLeafId("turn-1");
			},
		});

		await harness.handle.prompt("Plan this", {
			tools: [
				outcomeTool("plan_saved", {
					parameters: {
						acceptanceCriteria: {
							type: "array",
							description: "Acceptance criteria",
							items: { type: "string" },
							required: true,
							requiredErrorCode: "acceptance_criteria_required",
							minItems: 1,
						},
					},
				}),
			],
		});

		expect(registeredParameters).toMatchObject({
			type: "object",
			properties: {
				acceptanceCriteria: {
					type: "array",
					description: "Acceptance criteria",
					items: { type: "string" },
					minItems: 1,
				},
			},
			required: ["acceptanceCriteria"],
			additionalProperties: false,
		});
		expect(JSON.stringify(registeredParameters)).not.toContain("requiredErrorCode");
	});

	it("preserves temporary tool executionMode", async () => {
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		let registeredTool:
			| {
					name: string;
					executionMode?: string;
					execute: (
						toolCallId: string,
						args: Record<string, unknown>,
					) => Promise<Record<string, unknown>>;
			  }
			| undefined;
		harness = createFakeSdkHandle({
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				const mutableSession = harness.session as {
					_customTools: Array<{
						name: string;
						executionMode?: string;
						execute: (
							toolCallId: string,
							args: Record<string, unknown>,
						) => Promise<Record<string, unknown>>;
					}>;
				};
				registeredTool = mutableSession._customTools.find((tool) => tool.name === "plan_saved");
				await registeredTool?.execute("call-1", {});
				harness.setEntries([messageEntry("user-1", null), messageEntry("turn-1", "user-1")]);
				harness.setLeafId("turn-1");
			},
		});

		await harness.handle.prompt("Plan this", {
			tools: [
				outcomeTool("plan_saved", {
					executionMode: "sequential",
				}),
			],
		});

		expect(registeredTool?.executionMode).toBe("sequential");
		expect(harness.session.agent.abort).not.toHaveBeenCalled();
	});

	it("skips later batched tool calls after a terminal outcome", async () => {
		let terminalAccepted = false;
		const executeLaterBashCall = vi.fn();
		let outcomeResult: { content?: unknown; details?: unknown; terminate?: boolean } | undefined;
		let markdownBlock: unknown;
		let bashBlock: unknown;
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			activeToolNames: ["bash"],
			customTools: [{ name: "bash" }],
			promptImpl: async () => {
				const mutableSession = harness.session as {
					_customTools: Array<{
						name: string;
						execute: (
							toolCallId: string,
							args: Record<string, unknown>,
						) => Promise<{ content?: unknown; details?: unknown; terminate?: boolean }>;
					}>;
				};
				const registeredOutcome = mutableSession._customTools.find(
					(tool) => tool.name === "plan_saved",
				);
				outcomeResult = await registeredOutcome?.execute("call-1", {});
				const agent = harness.session.agent as {
					beforeToolCall?: (context: { toolCall: { name: string } }) => unknown;
				};
				markdownBlock = await agent.beforeToolCall?.({ toolCall: { name: "markdown_result" } });
				bashBlock = await agent.beforeToolCall?.({ toolCall: { name: "bash" } });
				if (!bashBlock) await executeLaterBashCall();
				harness.setEntries([messageEntry("user-1", null), messageEntry("turn-1", "user-1")]);
				harness.setLeafId("turn-1");
			},
		});

		await harness.handle.prompt("Plan this", {
			activeTools: ["bash"],
			tools: [
				outcomeTool("plan_saved", {
					executionMode: "sequential",
					execute: async () => {
						terminalAccepted = true;
						return { status: "ok", name: "plan_saved" };
					},
				}),
			],
			shouldBlockToolCall: (toolName) => (terminalAccepted ? `blocked later ${toolName}` : null),
		});

		expect(outcomeResult?.terminate).toBeUndefined();
		expect(markdownBlock).toEqual({ block: true, reason: "blocked later markdown_result" });
		expect(bashBlock).toEqual({ block: true, reason: "blocked later bash" });
		expect(executeLaterBashCall).not.toHaveBeenCalled();
		expect(harness.session.agent.abort).not.toHaveBeenCalled();
	});

	it("does not reject prompts when Pi auto-retry eventually records a successful assistant entry", async () => {
		const assistantErrorEntry: PiTreeEntry = {
			id: "turn-error",
			parentId: "user-1",
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "Connection refused",
				provider: "openai-codex",
				model: "gpt-5.4",
			} as PiTreeEntry["message"],
		};
		const assistantSuccessEntry: PiTreeEntry = {
			id: "turn-success",
			parentId: "turn-error",
			type: "message",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Recovered after retry" }],
				stopReason: "end_turn",
				provider: "openai-codex",
				model: "gpt-5.4",
			} as PiTreeEntry["message"],
		};
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				harness.setEntries([
					messageEntry("user-1", null),
					assistantErrorEntry,
					assistantSuccessEntry,
				]);
				harness.setLeafId("turn-success");
			},
		});

		const result = await harness.handle.prompt("Plan this");

		expect(result.resultEntryId).toBe("turn-success");
		expect(result.createdEntryIds).toEqual(["user-1", "turn-error", "turn-success"]);
	});

	it("sends an identified kickoff through Pi's retry-aware custom-message API", async () => {
		const identity = { kind: "turn_prompt", startRecordId: "start-1", purpose: "kickoff" };
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			customMessageImpl: async (message) => {
				const customEntry: PiTreeEntry = {
					id: "kickoff",
					parentId: null,
					type: "custom_message",
					timestamp: "2026-01-01T00:00:00.000Z",
					customType: message.customType,
					content: message.content as string,
					details: message.details,
				};
				const errorEntry = {
					...messageEntry("turn-error", "kickoff"),
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "WebSocket error",
					},
				} as PiTreeEntry;
				const successEntry = messageEntry("turn-success", "turn-error");
				harness.setEntries([customEntry, errorEntry, successEntry]);
				harness.setLeafId("turn-success");
			},
		});

		const result = await harness.handle.promptCustom({
			content: "Implement the issue",
			details: identity,
		});

		expect(harness.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "leitwerk", details: identity }),
			{ triggerTurn: true },
		);
		expect(result.createdEntryIds).toEqual(["kickoff", "turn-error", "turn-success"]);
	});

	it("retries a retained prompt leaf, preserves failed history, and keeps tools active", async () => {
		const state = createRetryingContinuationHarness({
			errorMessages: ["WebSocket error"],
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
		});
		const retryEvents: PiEvent[] = [];
		state.harness.handle.subscribe((event) => retryEvents.push(event));

		const result = await state.harness.handle.continueTurn({
			activeTools: ["read"],
			tools: [outcomeTool("done")],
		});

		expect(state.providerCalls()).toBe(2);
		expect(result.createdEntryIds).toEqual(["turn-1", "turn-2"]);
		expect(state.modelInputs[1]).not.toContainEqual(
			expect.objectContaining({ stopReason: "error", errorMessage: "WebSocket error" }),
		);
		expect(state.activeToolsByCall).toEqual([
			["read", "done"],
			["read", "done"],
		]);
		expect(state.harness.getActiveToolNames()).toEqual(["read"]);
		expect(retryEvents.map((event) => event.type)).toEqual(["retry.start", "retry.end"]);
	});

	it("cancels retained-leaf retries when aborted during backoff", async () => {
		const state = createRetryingContinuationHarness({
			errorMessages: ["WebSocket error"],
			baseDelayMs: 60_000,
		});
		let retryStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			retryStarted = resolve;
		});
		const events: PiEvent[] = [];
		state.harness.handle.subscribe((event) => {
			events.push(event);
			if (event.type === "retry.start") retryStarted();
		});

		const continuation = state.harness.handle.continueTurn();
		await started;
		await state.harness.handle.abortTurn();
		await expect(continuation).rejects.toThrow("WebSocket error");
		expect(state.harness.session.agent.continue).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(["retry.start", "retry.end"]);
		expect(events[1]?.data.finalError).toBe("Retry cancelled");
	});

	it("waits for Pi overflow compaction auto-continue before evaluating the final assistant entry", async () => {
		const initialEntries = [messageEntry("user-1", null)];
		const assistantOverflowEntry: PiTreeEntry = {
			id: "turn-overflow",
			parentId: "user-1",
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				provider: "openai-codex",
				model: "gpt-5.4",
			} as PiTreeEntry["message"],
		};
		const assistantSuccessEntry: PiTreeEntry = {
			id: "turn-success",
			parentId: "turn-overflow",
			type: "message",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Continued after compaction" }],
				stopReason: "end_turn",
				provider: "openai-codex",
				model: "gpt-5.4",
			} as PiTreeEntry["message"],
		};
		let activeToolsDuringCompactionContinue: string[] = [];
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			entries: initialEntries,
			leafId: "user-1",
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			waitForIdleImpl: async () => settled,
			continueImpl: async () => {
				harness.setEntries([...initialEntries, assistantOverflowEntry]);
				harness.setLeafId("turn-overflow");
				harness.setRuntimeState({ isCompacting: true });
				harness.emitSessionEvent({
					type: "compaction_start",
					reason: "overflow",
				} as AgentSessionEvent);
				setTimeout(() => {
					harness.setRuntimeState({ isCompacting: false });
					harness.emitSessionEvent({
						type: "compaction_end",
						reason: "overflow",
						result: {
							summary: "Compacted context",
							firstKeptEntryId: "user-1",
							tokensBefore: 120_000,
						},
						aborted: false,
						willRetry: true,
					} as AgentSessionEvent);
					setTimeout(() => {
						activeToolsDuringCompactionContinue = harness.getActiveToolNames();
						harness.setRuntimeState({ isStreaming: true });
						harness.emitSessionEvent({ type: "agent_start", messages: [] } as AgentSessionEvent);
						harness.setEntries([...initialEntries, assistantOverflowEntry, assistantSuccessEntry]);
						harness.setLeafId("turn-success");
						harness.setRuntimeState({ isStreaming: false });
						harness.emitSessionEvent({
							type: "agent_end",
							messages: [],
						} as AgentSessionEvent);
						resolveSettled();
					}, 0);
				}, 0);
			},
		});

		const result = await harness.handle.continueTurn({
			activeTools: ["read"],
			tools: [outcomeTool("done")],
		});

		expect(result.resultEntryId).toBe("turn-success");
		expect(result.createdEntryIds).toEqual(["turn-overflow", "turn-success"]);
		expect(activeToolsDuringCompactionContinue).toEqual(["read", "done"]);
		expect(harness.getActiveToolNames()).toEqual(["read"]);
		expect(harness.session.waitForIdle).toHaveBeenCalledOnce();
	});

	it("rejects prompts when Pi records an assistant stopReason error", async () => {
		const assistantErrorEntry: PiTreeEntry = {
			id: "turn-error",
			parentId: "user-1",
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "Invalid schema for function 'plan_saved'",
				provider: "openai-codex",
				model: "gpt-5.4",
			} as PiTreeEntry["message"],
		};
		let harness!: ReturnType<typeof createFakeSdkHandle>;
		harness = createFakeSdkHandle({
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				harness.setEntries([messageEntry("user-1", null), assistantErrorEntry]);
				harness.setLeafId("turn-error");
			},
		});

		await expect(
			harness.handle.prompt("Plan this", { tools: [outcomeTool("plan_saved")] }),
		).rejects.toMatchObject({
			message: "Invalid schema for function 'plan_saved'",
			provider: "openai-codex",
			model: "gpt-5.4",
			stopReason: "error",
		});
	});

	it("restores temporary tools even when prompt throws", async () => {
		const { handle, session, getActiveToolNames } = createFakeSdkHandle({
			activeToolNames: ["read"],
			customTools: [{ name: "read" }],
			promptImpl: async () => {
				throw new Error("prompt failed");
			},
		});
		const mutableSession = session as {
			_customTools: Array<{ name: string }>;
			_refreshToolRegistry: ReturnType<typeof vi.fn>;
		};

		await expect(
			handle.prompt("Plan this", { tools: [outcomeTool("plan_saved")] }),
		).rejects.toThrow("prompt failed");
		expect(mutableSession._customTools.map((tool) => tool.name)).toEqual(["read"]);
		expect(mutableSession._refreshToolRegistry).toHaveBeenCalledTimes(2);
		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(1, {
			activeToolNames: ["plan_saved"],
		});
		expect(mutableSession._refreshToolRegistry).toHaveBeenNthCalledWith(2, {
			activeToolNames: ["read"],
		});
		expect(getActiveToolNames()).toEqual(["read"]);
	});

	it("rejects prompt-specific active tools that are not part of the process tool set", async () => {
		const { handle } = createFakeSdkHandle({ activeToolNames: ["read"] });

		await expect(handle.prompt("Plan this", { activeTools: ["unknown"] })).rejects.toThrow(
			"Requested active Pi tool 'unknown' is not available for this process",
		);
	});

	it("wraps incompatible temporary tool registration errors with context", async () => {
		const { handle } = createFakeSdkHandle({ includeTemporaryToolHooks: false });

		await expect(
			handle.prompt("Plan this", { tools: [outcomeTool("plan_saved")] }),
		).rejects.toThrow("Pi SDK version incompatible: temporary tool registration unavailable");
	});

	it("shares one underlying session subscription across Pi events and diagnostics", () => {
		const { handle, session, emitSessionEvent, unsubscribeFns } = createFakeSdkHandle();
		const events: PiEvent[] = [];
		const diagnostics: PiSessionDiagnostic[] = [];
		const unsubscribeEvents = handle.subscribe((event) => {
			events.push(event);
		});
		const unsubscribeDiagnostics = handle.subscribeDiagnostics?.((diagnostic) => {
			diagnostics.push(diagnostic);
		});

		expect(session.subscribe).toHaveBeenCalledOnce();
		emitSessionEvent({
			type: "turn_start",
			timestamp: 1_700_000_000_000,
		} as AgentSessionEvent);
		emitSessionEvent({
			type: "message_update",
			message: { timestamp: "2026-01-01T00:00:02.000Z" },
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		} as AgentSessionEvent);
		emitSessionEvent({
			type: "queue_update",
			steering: [],
			followUp: [],
			timestamp: "2026-01-01T00:00:02.500Z",
		} as AgentSessionEvent);
		unsubscribeEvents();
		unsubscribeEvents();
		unsubscribeDiagnostics?.();
		unsubscribeDiagnostics?.();
		emitSessionEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "plan_saved",
			args: {},
		} as AgentSessionEvent);

		expect(events.map((event) => event.type)).toEqual(["turn.start", "stream.delta"]);
		expect(events.map((event) => event.turnId)).toEqual(["turn-1", "turn-1"]);
		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "pi.queue_update",
				message: "Pi session queue updated",
			}),
		]);
		expect(unsubscribeFns).toHaveLength(1);
		expect(unsubscribeFns[0]).toHaveBeenCalledOnce();
	});

	it("isolates failing event and diagnostic subscribers", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handle, emitSessionEvent } = createFakeSdkHandle();
		const receivedEventTypes: string[] = [];
		const receivedDiagnosticCodes: string[] = [];

		handle.subscribe(() => {
			throw new Error("event handler boom");
		});
		handle.subscribe((event) => {
			receivedEventTypes.push(event.type);
		});
		handle.subscribeDiagnostics?.(() => {
			throw new Error("diagnostic handler boom");
		});
		handle.subscribeDiagnostics?.((diagnostic) => {
			receivedDiagnosticCodes.push(diagnostic.code);
		});

		expect(() => {
			emitSessionEvent({
				type: "turn_start",
				timestamp: "2026-01-01T00:00:03.000Z",
			} as AgentSessionEvent);
			emitSessionEvent({
				type: "queue_update",
				steering: [],
				followUp: [],
				timestamp: "2026-01-01T00:00:03.100Z",
			} as AgentSessionEvent);
		}).not.toThrow();

		expect(receivedEventTypes).toEqual(["turn.start"]);
		expect(receivedDiagnosticCodes).toEqual(["pi.queue_update"]);
		expect(warnSpy).toHaveBeenCalledWith("Pi event subscriber failed", expect.any(Error));
		expect(warnSpy).toHaveBeenCalledWith("Pi diagnostic subscriber failed", expect.any(Error));
		warnSpy.mockRestore();
	});

	it("closes by unsubscribing the shared session listener and disposing the session", async () => {
		const { handle, session, unsubscribeFns } = createFakeSdkHandle();

		handle.subscribe(() => {});
		handle.subscribe(() => {});
		handle.subscribeDiagnostics?.(() => {});
		await handle.close();

		expect(unsubscribeFns).toHaveLength(1);
		expect(unsubscribeFns[0]).toHaveBeenCalledOnce();
		expect(session.dispose).toHaveBeenCalledOnce();
	});

	it("logs a warning when aborting a streaming session during close fails", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handle, session } = createFakeSdkHandle({
			isStreaming: true,
			abortImpl: async () => {
				throw new Error("abort failed");
			},
		});

		await handle.close();

		expect(session.abort).toHaveBeenCalledOnce();
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to abort streaming Pi handle 'sdk-1' during close",
			expect.any(Error),
		);
		expect(session.dispose).toHaveBeenCalledOnce();
	});
});

describe("StubPiTreeHandle", () => {
	it("exposes tree access methods over prompted entries", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-1",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});

		const promptResult = await handle.prompt("First prompt");

		expect(promptResult).toEqual({
			startLeafId: null,
			endLeafId: "turn-1",
			createdEntryIds: ["user-1", "turn-1"],
			resultEntryId: "turn-1",
			assistantMarkdown: "First prompt",
		});
		expect(handle.getLeafId()).toBe("turn-1");
		expect(handle.getEntry("user-1")).toMatchObject({
			id: "user-1",
			parentId: null,
			type: "message",
		});
		expect(handle.getEntry("turn-1")).toMatchObject({
			id: "turn-1",
			parentId: "user-1",
			type: "message",
		});
		expect(handle.getBranch("turn-1").map((entry) => entry.id)).toEqual(["user-1", "turn-1"]);
		expect(handle.getChildren("user-1").map((entry) => entry.id)).toEqual(["turn-1"]);
		expect(handle.getTree().map((node) => node.entry.id)).toEqual(["user-1"]);
	});

	it("throws when branching to an unknown entry", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-unknown",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});
		await handle.prompt("First prompt");

		await expect(handle.branch("missing-entry")).rejects.toThrow(
			"Unknown Pi entry 'missing-entry'",
		);
	});

	it("throws on prompt, branch, and steer after close", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-closed",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});
		await handle.close();

		await expect(handle.prompt("after close")).rejects.toThrow("Handle is closed");
		await expect(handle.branch("anything")).rejects.toThrow("Handle is closed");
		await expect(handle.steer("after close")).rejects.toThrow("Handle is closed");
	});

	it("requires explicit scripted tool args when prompting with tools", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-tools",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});

		await expect(
			handle.prompt("Plan this change", { tools: [outcomeTool("plan_saved")] }),
		).rejects.toThrow(
			"Stub Pi prompt requires a stub tool-call script when tools are provided (plan_saved)",
		);
	});

	it("supports branching and tree inspection across branches", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-2",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});

		await handle.prompt("First prompt");
		await handle.branch("user-1");
		expect(handle.getLeafId()).toBe("user-1");

		const branchedPrompt = await handle.prompt("Alternate prompt");
		expect(branchedPrompt.startLeafId).toBe("user-1");
		expect(handle.getBranch(branchedPrompt.resultEntryId).map((entry) => entry.id)).toEqual([
			"user-1",
			"user-2",
			"turn-2",
		]);

		expect(handle.getTree()).toMatchObject([
			{
				entry: { id: "user-1" },
				children: [
					{ entry: { id: "turn-1" }, children: [] },
					{
						entry: { id: "user-2" },
						children: [{ entry: { id: "turn-2" }, children: [] }],
					},
				],
			},
		]);
	});

	it("resets to the root before creating a fresh top-level branch", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-reset",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});

		await handle.prompt("First prompt");
		await handle.resetLeaf();
		expect(handle.getLeafId()).toBeNull();

		const promptAfterReset = await handle.prompt("Fresh root prompt");
		expect(promptAfterReset.startLeafId).toBeNull();
		expect(handle.getEntry("user-2")).toMatchObject({ parentId: null });
		expect(handle.getTree().map((node) => node.entry.id)).toEqual(["user-1", "user-2"]);

		await handle.branchFromRoot();
		expect(handle.getLeafId()).toBeNull();
	});

	it("returns an idempotent unsubscribe function", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-unsub",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
		});
		const events: PiEvent[] = [];
		const unsubscribe = handle.subscribe((event) => {
			events.push(event);
		});

		unsubscribe();
		unsubscribe();
		await handle.prompt("No listeners left");

		expect(events).toEqual([]);
	});

	it("returns structured turn results and emits turn/tool events", async () => {
		const script = createStubToolScriptController();
		const handle = new StubPiTreeHandle({
			sessionId: "stub-3",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
			toolCallScriptResolver: script.resolver,
		});
		const events: PiEvent[] = [];
		const unsubscribe = handle.subscribe((event) => {
			events.push(event);
		});
		script.set([{ toolName: "plan_saved", args: { summary: "Generated" } }]);

		const promptResult = await handle.prompt("Plan this change", {
			tools: [
				outcomeTool("plan_saved", {
					execute: async (args) => ({ ok: true, args }),
				}),
			],
		});
		unsubscribe();

		expect(promptResult.resultEntryId).toBe("turn-1");
		expect(promptResult.createdEntryIds).toEqual(["user-1", "turn-1"]);
		expect(events.map((event) => event.type)).toEqual([
			"turn.start",
			"tool.call",
			"tool.result",
			"turn.end",
		]);
		expect(events[1]?.data).toMatchObject({
			toolCallId: "tool-1",
			name: "plan_saved",
			arguments: { summary: "Generated" },
		});
	});

	it("can simulate multiple tool calls within a single prompt", async () => {
		const script = createStubToolScriptController();
		const handle = new StubPiTreeHandle({
			sessionId: "stub-multi-tool-calls",
			treeFile: "/tmp/tree-multi-tool-calls.jsonl",
			isResumed: false,
			toolCallScriptResolver: script.resolver,
		});
		const events: PiEvent[] = [];
		handle.subscribe((event) => {
			events.push(event);
		});
		script.set([
			{
				calls: [
					{ toolName: "markdown_result", args: { markdown: "## Result" } },
					{ toolName: "done", args: {} },
				],
			},
		]);

		await handle.prompt("Publish markdown and finish", {
			tools: [
				outcomeTool("markdown_result", {
					execute: async (args) => ({ ok: true, args }),
				}),
				outcomeTool("done", {
					execute: async () => ({ ok: true }),
				}),
			],
		});

		expect(events.map((event) => event.type)).toEqual([
			"turn.start",
			"tool.call",
			"tool.result",
			"tool.call",
			"tool.result",
			"turn.end",
		]);
		expect(events[1]?.data).toMatchObject({
			toolCallId: "tool-1-1",
			name: "markdown_result",
			arguments: { markdown: "## Result" },
		});
		expect(events[3]?.data).toMatchObject({
			toolCallId: "tool-1-2",
			name: "done",
			arguments: {},
		});
	});

	it("can simulate intermediate entries before the final assistant entry", async () => {
		const script = createStubToolScriptController();
		const handle = new StubPiTreeHandle({
			sessionId: "stub-intermediate-entries",
			treeFile: "/tmp/tree-intermediate-entries.jsonl",
			isResumed: false,
			toolCallScriptResolver: script.resolver,
		});
		script.set([
			{ toolName: "plan_saved", args: { summary: "Generated" }, intermediateEntryCount: 2 },
		]);

		const promptResult = await handle.prompt("Plan this change", {
			tools: [
				outcomeTool("plan_saved", {
					execute: async (args) => ({ ok: true, args }),
				}),
			],
		});

		expect(promptResult.resultEntryId).toBe("turn-1");
		expect(promptResult.createdEntryIds).toEqual([
			"user-1",
			"intermediate-1-1",
			"intermediate-1-2",
			"turn-1",
		]);
		expect(handle.getBranch("turn-1").map((entry) => entry.id)).toEqual([
			"user-1",
			"intermediate-1-1",
			"intermediate-1-2",
			"turn-1",
		]);
	});

	it("propagates tool script errors and emits error events", async () => {
		const script = createStubToolScriptController();
		const handle = new StubPiTreeHandle({
			sessionId: "stub-error",
			treeFile: "/tmp/tree.jsonl",
			isResumed: false,
			toolCallScriptResolver: script.resolver,
		});
		const events: PiEvent[] = [];
		handle.subscribe((event) => {
			events.push(event);
		});
		script.set([{ toolName: "plan_saved", args: { summary: "Generated" } }]);

		await expect(
			handle.prompt("Plan this change", {
				tools: [
					outcomeTool("plan_saved", {
						execute: async () => {
							throw new Error("tool exploded");
						},
					}),
				],
			}),
		).rejects.toThrow("tool exploded");
		expect(events.map((event) => event.type)).toEqual(["turn.start", "tool.call", "error"]);
		expect(events[2]?.data).toMatchObject({
			message: "tool exploded",
			toolName: "plan_saved",
		});
	});
});

describe("StubPiTreeHandleFactory", () => {
	it("forwards toolCallScriptResolver to created handles", async () => {
		const factory = new StubPiTreeHandleFactory({
			toolCallScriptResolver: ({ tools }) => {
				const tool = tools[0];
				return tool ? { toolName: tool.name, args: { summary: "Generated" } } : undefined;
			},
		});
		const handle = (await factory.createPrimaryTreeHandle({
			instanceId: "ag1",
			treeFile: "/tmp/tree.jsonl",
			workspaceRoot: "/tmp/ws",
			resume: false,
		})) as StubPiTreeHandle;

		const result = await handle.prompt("Plan this change", {
			tools: [
				outcomeTool("plan_saved", {
					execute: async (args) => ({ ok: true, args }),
				}),
			],
		});

		expect(result.resultEntryId).toBe("turn-1");
		expect(handle.getEntry("turn-1")).toMatchObject({
			message: {
				content: expect.stringContaining('"summary": "Generated"'),
			},
		});
		expect(factory.sessions).toEqual([handle]);
	});

	it("reopens the same persisted stub tree when a handle is resumed", async () => {
		const treeFile = `/tmp/resume-tree-${Math.random().toString(36).slice(2)}.jsonl`;
		const factory = new StubPiTreeHandleFactory();
		const firstHandle = (await factory.createPrimaryTreeHandle({
			instanceId: "ag1",
			treeFile,
			workspaceRoot: "/tmp/ws",
			resume: false,
		})) as StubPiTreeHandle;

		await firstHandle.prompt("Seed the primary path");
		const appendedLeafId = firstHandle.getLeafId();
		await firstHandle.branch("user-1");
		expect(firstHandle.getLeafId()).toBe("user-1");
		await firstHandle.close();

		const resumedHandle = (await factory.createPrimaryTreeHandle({
			instanceId: "ag1",
			treeFile,
			workspaceRoot: "/tmp/ws",
			resume: true,
		})) as StubPiTreeHandle;

		expect(resumedHandle.getLeafId()).toBe(appendedLeafId);
		expect(resumedHandle.getLeafId()).not.toBe("user-1");
		expect(resumedHandle.getEntry("turn-1")).toMatchObject({
			message: {
				content: "Seed the primary path",
			},
		});
		expect(factory.sessions).toEqual([firstHandle, resumedHandle]);
	});

	it("persists stub tree state across factory instances for fresh-worker resumes", async () => {
		const treeFile = `/tmp/resume-cross-factory-${Math.random().toString(36).slice(2)}.jsonl`;
		const firstFactory = new StubPiTreeHandleFactory();
		const firstHandle = (await firstFactory.createPrimaryTreeHandle({
			instanceId: "ag1",
			treeFile,
			workspaceRoot: "/tmp/ws",
			resume: false,
		})) as StubPiTreeHandle;

		await firstHandle.prompt("Seed the primary path");
		await firstHandle.close();

		const secondFactory = new StubPiTreeHandleFactory();
		const planningSnapshot = await secondFactory.inspectPrimaryTree({
			treeFile,
			sessionCwd: "/tmp/ws",
		});
		expect(planningSnapshot).toEqual({
			currentLeafId: "turn-1",
			entries: [
				{ id: "user-1", parentId: null },
				{ id: "turn-1", parentId: "user-1" },
			],
		});
		const resumedHandle = (await secondFactory.createPrimaryTreeHandle({
			instanceId: "ag1",
			treeFile,
			workspaceRoot: "/tmp/ws",
			resume: true,
		})) as StubPiTreeHandle;

		expect(resumedHandle.isResumed).toBe(true);
		expect(resumedHandle.getEntry("user-1")).toBeDefined();
		expect(resumedHandle.getEntry("turn-1")).toBeDefined();
		expect(resumedHandle.getLeafId()).toBe("turn-1");
	});
});
