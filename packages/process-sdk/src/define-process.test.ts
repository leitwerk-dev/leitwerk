import {
	buildExtensionCatalogFromModules,
	buildServerProcessForTest,
	buildWorkerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	acceptedReviewHandoffAction,
	automaticTurn,
	defineProcess,
	type ExtensionProcessDefinition,
	externalTurn,
	type FormDefinition,
	getProcessGraph,
	humanTurn,
	llmTurn,
	revisionAction,
} from "./index.js";

const emptyParamsCodec = {
	parse: () => ({}),
	serialize: (value: Record<string, never>) => value,
};

function transitionsFor(process: ExtensionProcessDefinition, turnId: string) {
	return getProcessGraph(new Map([[process.id, process]]), process.id).turns.get(turnId)
		?.transitions;
}

const stateCodec = {
	parse: (value: unknown) => {
		const record =
			typeof value === "object" && value !== null ? (value as { branch?: unknown }) : {};
		return {
			branch: typeof record.branch === "string" ? record.branch : "draft",
		};
	},
	serialize: (value: { branch: string }) => value,
};

function basicTurns() {
	return {
		draft: llmTurn({
			availableTools: [],
			description: "Draft",
			branchType: "primary" as const,
			context: "fresh" as const,
			prompt: async () => "draft",
			outcomes: {
				draft_ready: {
					description: "ready",
					parameters: {},
					to: "review",
				},
			},
		}),
		review: humanTurn({
			description: "Review",
			actions: {
				approve: {
					label: "Approve",
					acceptanceState: "accepted" as const,
					to: "finalize",
				},
			},
		}),
		finalize: automaticTurn({
			description: "Finalize",
			run: () => ({ outcome: "done", params: {} }),
			outcomes: {
				done: {
					description: "done",
					parameters: {},
					complete: true,
				},
			},
		}),
	};
}

function createBasicProcess(
	alternateEntries?: readonly string[],
): ExtensionProcessDefinition<Record<string, never>, { branch: string }> {
	return defineProcess({
		id: "defined_process",
		displayName: "Defined Process",
		entry: "draft",
		...(alternateEntries ? { alternateEntries } : {}),
		paramsCodec: emptyParamsCodec,
		stateCodec,
		initialState: () => ({ branch: "draft" }),
		turns: basicTurns(),
	});
}

describe("defineProcess", () => {
	function defineWithActionForm(form: FormDefinition) {
		return defineProcess({
			id: "primary_prompt_validation",
			displayName: "Primary Prompt Validation",
			entry: "review",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				...basicTurns(),
				review: humanTurn({
					description: "Review",
					actions: {
						revise: {
							label: "Revise",
							acceptanceState: "requires_changes",
							form,
							to: "draft",
						},
					},
				}),
			},
		});
	}

	it("requires one textual primary prompt on action forms with textual fields", () => {
		expect(() =>
			defineWithActionForm({
				id: "missing_primary_prompt",
				title: "Missing primary prompt",
				fields: [{ id: "message", label: "Message", kind: "textarea" }],
			}),
		).toThrow("with textual fields must declare a primary prompt");

		expect(() =>
			defineWithActionForm({
				id: "multiple_primary_prompts",
				title: "Multiple primary prompts",
				fields: [
					{ id: "summary", label: "Summary", kind: "text", primaryPrompt: true },
					{ id: "message", label: "Message", kind: "textarea", primaryPrompt: true },
				],
			}),
		).toThrow("must declare at most one primary prompt");

		expect(() =>
			defineWithActionForm({
				id: "non_textual_primary_prompt",
				title: "Non-textual primary prompt",
				fields: [{ id: "count", label: "Count", kind: "number", primaryPrompt: true }],
			}),
		).toThrow("primary prompt must be a text or textarea field");
	});

	it("compiles process-owned turns, the graph, and worker handlers", () => {
		const process = createBasicProcess();

		expect(process.entryTurnId).toBe("draft");
		expect(process.alternateEntryTurnIds).toEqual([]);
		expect(transitionsFor(process, "draft")).toEqual([
			{ nextTurnId: "review", outcome: "draft_ready" },
		]);
		expect(transitionsFor(process, "review")).toEqual([
			{ nextTurnId: "finalize", trigger: "approve" },
		]);
		expect(transitionsFor(process, "finalize")).toEqual([
			{ lifecycleStatus: "completed", outcome: "done" },
		]);
		expect([...process.turns.keys()]).toEqual(["draft", "review", "finalize"]);

		const worker = buildWorkerProcessForTest(process);
		expect(worker?.startTurnId).toBe("draft");
		expect(worker?.turns.has("draft")).toBe(true);
		expect(worker?.turns.has("finalize")).toBe(true);
		expect(worker?.turns.has("review")).toBe(false);
		expect(Object.hasOwn(process, "contract")).toBe(false);
		expect(Object.hasOwn(process, "ownedTurns")).toBe(false);
	});

	it("compiles and validates alternate entry turns", () => {
		expect(createBasicProcess(["finalize"]).alternateEntryTurnIds).toEqual(["finalize"]);
		for (const entries of [["draft"], ["finalize", "finalize"]]) {
			expect(() => createBasicProcess(entries)).toThrow(/duplicate entry turn/);
		}
		expect(() => createBasicProcess(["missing"])).toThrow("entry turn 'missing' is not declared");
	});

	it("retains a declared happy path on the compiled definition", () => {
		const process = defineProcess({
			id: "happy_path_process",
			displayName: "Happy Path Process",
			entry: "draft",
			happyPath: ["draft", "review", "finalize"],
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: basicTurns(),
		});

		expect(process.happyPath).toEqual(["draft", "review", "finalize"]);
	});

	it("allows a happy path segment connected through an omitted operator decision", () => {
		const process = defineProcess({
			id: "happy_path_through_operator",
			displayName: "Happy Path Through Operator",
			entry: "draft",
			happyPath: ["draft", "finalize"],
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: basicTurns(),
		});

		expect(process.happyPath).toEqual(["draft", "finalize"]);
	});

	it("rejects a happy path segment that is not connected by declared transitions", () => {
		expect(() =>
			defineProcess({
				id: "disconnected_happy_path",
				displayName: "Disconnected Happy Path",
				entry: "draft",
				happyPath: ["draft", "finalize"],
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: {
					...basicTurns(),
					review: humanTurn({
						description: "Review",
						actions: {
							revise: {
								label: "Revise",
								acceptanceState: "rejected" as const,
								to: "draft",
							},
						},
					}),
				},
			}),
		).toThrow(/happy path segment 'draft' -> 'finalize' is not connected/);
	});

	it("rejects a happy path that does not start at the entry turn", () => {
		expect(() =>
			defineProcess({
				id: "bad_happy_path",
				displayName: "Bad Happy Path",
				entry: "draft",
				happyPath: ["review", "draft"],
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: basicTurns(),
			}),
		).toThrow(/happy path must start at the entry turn/);
	});

	it("rejects a happy path referencing an undeclared turn", () => {
		expect(() =>
			defineProcess({
				id: "unknown_happy_turn",
				displayName: "Unknown Happy Turn",
				entry: "draft",
				happyPath: ["draft", "ghost"],
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: basicTurns(),
			}),
		).toThrow(/happy path references undeclared turn 'ghost'/);
	});

	it("rejects a happy path that repeats a turn", () => {
		expect(() =>
			defineProcess({
				id: "repeated_happy_turn",
				displayName: "Repeated Happy Turn",
				entry: "draft",
				happyPath: ["draft", "review", "draft"],
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: basicTurns(),
			}),
		).toThrow(/happy path repeats turn 'draft'/);
	});

	it("allows generic operator-waiting human turns without review metadata", () => {
		const process = defineProcess({
			id: "generic_waiting_process",
			displayName: "Generic Waiting Process",
			entry: "console",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "idle" }),
			turns: {
				console: humanTurn({
					description: "Console",
					actions: {
						close: {
							label: "Close",
							acceptanceState: "accepted",
							complete: true,
						},
					},
				}),
			},
		});

		expect(process.turns.get("console")?.definition).toMatchObject({ kind: "human" });
		expect(
			getProcessGraph(new Map([[process.id, process]]), process.id).turns.get("console"),
		).toEqual(
			expect.objectContaining({
				turnType: "human",
				transitions: [{ lifecycleStatus: "completed", trigger: "close" }],
			}),
		);
		expect(buildServerProcessForTest(process)?.actions.has("close")).toBe(true);
	});

	it("keeps the selected turn when an outcome omits a graph target", () => {
		const process = defineProcess({
			id: "missing_outcome_route_process",
			displayName: "Missing Outcome Route",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					outcomes: {
						ready: { description: "ready", parameters: {} },
					},
				}),
			},
		});

		expect(transitionsFor(process, "draft")).toEqual([{ nextTurnId: "draft", outcome: "ready" }]);
	});

	it("keeps the selected turn when turnEnd omits a graph target", () => {
		const process = defineProcess({
			id: "missing_turn_end_route_process",
			displayName: "Missing Turn End Route",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					completionMode: "turn_end",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {} },
				}),
			},
		});

		expect(transitionsFor(process, "draft")).toEqual([{ nextTurnId: "draft", outcome: "ready" }]);
	});

	it("routes one LLM outcome deterministically from process state", async () => {
		const process = defineProcess({
			id: "state_routed_outcome_process",
			displayName: "State Routed Outcome",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "manual" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					outcomes: {
						ready: {
							description: "ready",
							parameters: {},
							branches: {
								manual: { to: "decision" },
								automatic: { to: "deliver" },
							},
							choose: ({ ctx }) => ctx.state.branch,
						},
					},
				}),
				decision: humanTurn({
					description: "Decision",
					actions: {
						abort: { label: "Abort", acceptanceState: "neutral", lifecycleStatus: "aborted" },
					},
				}),
				deliver: automaticTurn({
					description: "Deliver",
					run: () => ({ outcome: "done", params: {} }),
					outcomes: { done: { description: "done", parameters: {}, complete: true } },
				}),
			},
		});

		expect(transitionsFor(process, "draft")).toEqual([
			{ nextTurnId: "decision", outcome: "ready", trigger: "manual" },
			{ nextTurnId: "deliver", outcome: "ready", trigger: "automatic" },
		]);

		const handler = buildServerProcessForTest(process)?.turnOutcomeHandlers.get("draft")?.[0];
		expect(handler).toBeDefined();
		const transitions: Array<Record<string, unknown>> = [];
		await handler?.(
			{ turnRecordId: "trn_1", turnId: "draft", outcome: "ready", params: {} },
			createTestServerProcessContext({
				process: createTestProcessInstance({ processId: process.id, selectedTurnId: "draft" }),
				state: { branch: "automatic" },
				transition: async (next) => transitions.push(next as Record<string, unknown>),
			}),
		);
		expect(transitions).toEqual([{ turnId: "deliver", trigger: "automatic" }]);
	});

	it("allows custom worker overrides for compiled turns", () => {
		const process = defineProcess({
			id: "worker_override_process",
			displayName: "Worker Override",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "finalize" },
				}),
				finalize: automaticTurn({
					description: "Finalize",
					run: () => ({ outcome: "done", params: {} }),
					outcomes: {
						done: { description: "done", parameters: {}, complete: true },
					},
				}),
			},
			worker(api) {
				api.turn("draft", async () => {});
			},
		});

		const worker = buildWorkerProcessForTest(process);
		expect(worker?.turns.has("draft")).toBe(true);
		expect(worker?.turns.has("finalize")).toBe(true);
		expect(worker?.turns.size).toBe(2);
	});

	it("auto-registers owned turns when the process is registered", async () => {
		const process = createBasicProcess();
		const catalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "defined-process-extension", version: "0.1.0" },
				setupCatalog(api) {
					api.registerProcess(process);
				},
			},
		]);

		const registered = catalog.processes.get(process.id);
		expect(registered?.turns.has("draft")).toBe(true);
		expect(registered?.turns.has("review")).toBe(true);
		expect(registered?.turns.has("finalize")).toBe(true);
	});

	it("dispatches a shared action id according to the selected human turn", async () => {
		const process = defineProcess({
			id: "shared_action_process",
			displayName: "Shared Action Process",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "one" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "start" },
				}),
				start: humanTurn({
					description: "Start",
					actions: {
						retry: {
							label: "Retry",
							acceptanceState: "accepted",
							to: "done",
							effect: ({ ctx }) => ({ state: { ...ctx.state, branch: "from-start" } }),
						},
					},
				}),
				alternate: humanTurn({
					description: "Alternate",
					actions: {
						retry: {
							label: "Retry",
							acceptanceState: "accepted",
							to: "done",
							effect: ({ ctx }) => ({ state: { ...ctx.state, branch: "from-alternate" } }),
						},
					},
				}),
				done: automaticTurn({
					description: "Done",
					run: () => ({ outcome: "completed", params: {} }),
					outcomes: {
						completed: {
							description: "completed",
							parameters: {},
							complete: true,
						},
					},
				}),
			},
		});

		const server = buildServerProcessForTest(process);
		const action = server?.actions.get("retry");
		expect(action).toBeDefined();
		if (!action?.plan) return;

		const transitions: Array<Record<string, unknown>> = [];
		await action.plan(
			{},
			{
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "alternate",
					lifecycleStatus: "waiting",
				}),
				projects: [],
				params: {},
				state: { branch: "initial" },
				async transition(next) {
					transitions.push(next as Record<string, unknown>);
				},
				emitEvent() {},
				readSemanticTurnResultMarkdown() {
					return null;
				},
				readProductTurnResultMarkdown() {
					return null;
				},
				queueInput() {},
			},
		);

		expect(transitions).toEqual([
			{ turnId: "done", trigger: "retry", state: { branch: "from-alternate" } },
		]);
	});

	it("queues trimmed revision input through revisionAction", async () => {
		const process = defineProcess({
			id: "revision_action_process",
			displayName: "Revision Action",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "review" },
				}),
				review: humanTurn({
					description: "Review",
					actions: {
						revise: revisionAction({
							label: "Revise",
							acceptanceState: "requires_changes",
							to: "draft",
							queueTarget: { semanticRef: "currentPrimaryPathLeaf" },
							effect: ({ ctx }) => ({ state: { ...ctx.state, branch: "revised" } }),
						}),
					},
				}),
			},
		});

		const action = buildServerProcessForTest(process)?.actions.get("revise");
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}

		const transitions: Array<Record<string, unknown>> = [];
		const queuedInputs: Array<Record<string, unknown>> = [];
		await action.plan(
			{ message: "  tighten the ending  " },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "review",
					lifecycleStatus: "waiting",
				}),
				state: { branch: "draft" },
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
				queueInput(input) {
					queuedInputs.push(input as Record<string, unknown>);
				},
			}),
		);

		expect(transitions).toEqual([
			{ turnId: "draft", trigger: "revise", state: { branch: "revised" } },
		]);
		expect(queuedInputs).toEqual([
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "currentPrimaryPathLeaf" },
				bodyMarkdown: "tighten the ending",
			},
		]);
	});

	it("validates queued revision input before running the action effect", async () => {
		let effectCalls = 0;
		const process = defineProcess({
			id: "revision_action_validation_process",
			displayName: "Revision Action Validation",
			entry: "review",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				review: humanTurn({
					description: "Review",
					actions: {
						revise: revisionAction({
							label: "Revise",
							acceptanceState: "requires_changes",
							to: "review",
							queueTarget: { semanticRef: "currentPrimaryPathLeaf" },
							effect: () => {
								effectCalls += 1;
								return { state: { branch: "revised" } };
							},
						}),
					},
				}),
			},
		});

		const action = buildServerProcessForTest(process)?.actions.get("revise");
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}

		await expect(
			action.plan(
				{ message: "   " },
				createTestServerProcessContext({
					process: createTestProcessInstance({
						processId: process.id,
						selectedTurnId: "review",
						lifecycleStatus: "waiting",
					}),
					state: { branch: "draft" },
				}),
			),
		).rejects.toThrow("message is required");
		expect(effectCalls).toBe(0);
	});

	it("applies declarative form state fields before transitioning", async () => {
		const form: FormDefinition = {
			id: "settings",
			title: "Settings",
			fields: [
				{
					id: "tone",
					label: "Tone",
					kind: "text",
					primaryPrompt: true,
					state: { path: "preferences.tone" },
				},
			],
		};
		const process = defineProcess({
			id: "form_state_process",
			displayName: "Form State Process",
			entry: "decision",
			paramsCodec: emptyParamsCodec,
			stateCodec: {
				parse: (value: unknown) =>
					(typeof value === "object" && value !== null ? value : {}) as {
						preferences?: { tone?: string };
					},
				serialize: (value) => value,
			},
			initialState: () => ({}),
			turns: {
				decision: humanTurn({
					description: "Decision",
					actions: {
						continue: {
							label: "Continue",
							acceptanceState: "neutral",
							form,
							complete: true,
						},
					},
				}),
			},
		});
		const action = buildServerProcessForTest(process)?.actions.get("continue");
		const transitions: Array<Record<string, unknown>> = [];
		await action?.plan?.(
			{ tone: "calm" },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "decision",
					lifecycleStatus: "waiting",
				}),
				state: {},
				transition: async (next) => transitions.push(next as Record<string, unknown>),
			}),
		);

		expect(transitions).toEqual([
			{
				turnId: null,
				lifecycleStatus: "completed",
				trigger: "continue",
				state: { preferences: { tone: "calm" } },
			},
		]);
	});

	it("supports conditional accepted-review handoffs and uses the chosen branch trigger", async () => {
		const process = defineProcess({
			id: "accepted_review_handoff_process",
			displayName: "Accepted Review Handoff",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "review" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "decision" },
				}),
				decision: humanTurn({
					description: "Decision",
					actions: {
						accept_review: acceptedReviewHandoffAction({
							label: "Accept review",
							acceptanceState: "accepted",
							branches: {
								return_without_handoff: { to: "decision" },
								handoff_review: { to: "draft" },
							},
							choose: ({ ctx }) =>
								ctx.state.branch === "skip" ? "return_without_handoff" : "handoff_review",
							resolveBodyMarkdown: ({ ctx }) =>
								ctx.state.branch === "skip" ? null : "Apply the accepted review.",
							effect: ({ ctx }) => ({
								state: {
									...ctx.state,
									branch: ctx.state.branch === "skip" ? "skip" : "applied",
								},
							}),
						}),
					},
				}),
			},
		});

		const action = buildServerProcessForTest(process)?.actions.get("accept_review");
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}

		const skipTransitions: Array<Record<string, unknown>> = [];
		const skipQueuedInputs: Array<Record<string, unknown>> = [];
		await action.plan(
			{},
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "decision",
					lifecycleStatus: "waiting",
				}),
				state: { branch: "skip" },
				transition: async (next) => {
					skipTransitions.push(next as Record<string, unknown>);
				},
				queueInput(input) {
					skipQueuedInputs.push(input as Record<string, unknown>);
				},
			}),
		);
		expect(skipTransitions).toEqual([
			{
				turnId: "decision",
				trigger: "return_without_handoff",
				state: { branch: "skip" },
			},
		]);
		expect(skipQueuedInputs).toEqual([]);

		const applyTransitions: Array<Record<string, unknown>> = [];
		const applyQueuedInputs: Array<Record<string, unknown>> = [];
		await action.plan(
			{},
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "decision",
					lifecycleStatus: "waiting",
				}),
				state: { branch: "apply" },
				transition: async (next) => {
					applyTransitions.push(next as Record<string, unknown>);
				},
				queueInput(input) {
					applyQueuedInputs.push(input as Record<string, unknown>);
				},
			}),
		);
		expect(applyTransitions).toEqual([
			{ turnId: "draft", trigger: "handoff_review", state: { branch: "applied" } },
		]);
		expect(applyQueuedInputs).toEqual([
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "currentPrimaryPathLeaf" },
				bodyMarkdown: "Apply the accepted review.",
			},
		]);
	});

	it("compiles external source transitions without registering visible actions", async () => {
		const process = defineProcess({
			id: "external_turn_process",
			displayName: "External Turn Process",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "completed", params: {}, to: "await_completion" },
				}),
				await_completion: externalTurn({
					description: "Wait for completion",
					transitions: [
						{
							source: {
								kind: "example.file.presence",
								label: "Configured completion file",
								description: "Write to the configured file to complete the process.",
								config: { path: "/tmp/complete" },
							},
							complete: true,
						},
					],
				}),
			},
		});

		expect(transitionsFor(process, "draft")).toEqual([
			{ nextTurnId: "await_completion", outcome: "completed" },
		]);
		expect(process.turns.get("await_completion")?.definition.kind).toBe("external");

		const worker = buildWorkerProcessForTest(process);
		expect(worker?.turns.has("draft")).toBe(true);
		expect(worker?.turns.has("await_completion")).toBe(false);

		expect(buildServerProcessForTest(process)?.actions.size).toBe(0);
		expect(transitionsFor(process, "await_completion")).toEqual([
			{
				lifecycleStatus: "completed",
				trigger: "await_completion:example.file.presence:0",
			},
		]);
	});

	it("rejects schedulable branch actions without an explicit preview", () => {
		expect(() =>
			defineProcess({
				id: "ambiguous_schedule_process",
				displayName: "Ambiguous Schedule",
				entry: "draft",
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: {
					draft: llmTurn({
						availableTools: [],
						description: "Draft",
						branchType: "primary",
						context: "fresh",
						prompt: async () => "draft",
						turnEnd: { outcome: "ready", params: {}, to: "source" },
					}),
					source: humanTurn({
						description: "Source",
						actions: {
							branch: {
								label: "Branch",
								acceptanceState: "neutral",
								schedulable: true,
								branches: {
									first: { to: "first" },
									second: { to: "second" },
								},
								choose: async () => "first",
							},
						},
					}),
					first: humanTurn({
						description: "First",
						actions: {
							ack: {
								label: "Ack",
								acceptanceState: "accepted",
								complete: true,
							},
						},
					}),
					second: humanTurn({
						description: "Second",
						actions: {
							ack: {
								label: "Ack second",
								acceptanceState: "accepted",
								complete: true,
							},
						},
					}),
				},
			}),
		).toThrow(/schedulable/);
	});

	it("rejects explicit trigger previews that do not match compiled routes", () => {
		expect(() =>
			defineProcess({
				id: "mismatched_preview_process",
				displayName: "Mismatched Preview",
				entry: "draft",
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: {
					draft: llmTurn({
						availableTools: [],
						description: "Draft",
						branchType: "primary",
						context: "fresh",
						prompt: async () => "draft",
						turnEnd: { outcome: "ready", params: {}, to: "review" },
					}),
					review: humanTurn({
						description: "Review",
						actions: {
							approve: {
								label: "Approve",
								acceptanceState: "accepted",
								to: "done",
								preview: { kind: "trigger", trigger: "wrong_trigger" },
							},
						},
					}),
					done: automaticTurn({
						description: "Done",
						run: () => ({ outcome: "completed", params: {} }),
						outcomes: {
							completed: { description: "Completed", parameters: {}, complete: true },
						},
					}),
				},
			}),
		).toThrow(/does not match a compiled transition/);
	});

	it("rejects explicit fixed-turn previews that disagree with branching routes", () => {
		expect(() =>
			defineProcess({
				id: "mismatched_branch_preview_process",
				displayName: "Mismatched Branch Preview",
				entry: "draft",
				paramsCodec: emptyParamsCodec,
				stateCodec,
				initialState: () => ({ branch: "draft" }),
				turns: {
					draft: llmTurn({
						availableTools: [],
						description: "Draft",
						branchType: "primary",
						context: "fresh",
						prompt: async () => "draft",
						turnEnd: { outcome: "ready", params: {}, to: "review" },
					}),
					review: humanTurn({
						description: "Review",
						actions: {
							branch: {
								label: "Branch",
								acceptanceState: "neutral",
								preview: { kind: "fixed_turn", turnId: "missing_target" },
								branches: {
									first: { to: "first" },
									second: { to: "second" },
								},
								choose: async () => "first",
							},
						},
					}),
					first: humanTurn({
						description: "First",
						actions: {
							ack: { label: "Ack", acceptanceState: "accepted", complete: true },
						},
					}),
					second: humanTurn({
						description: "Second",
						actions: {
							ack: { label: "Ack", acceptanceState: "accepted", complete: true },
						},
					}),
				},
			}),
		).toThrow(/does not match a compiled transition/);
	});

	it("allows human entry turns", () => {
		const process = defineProcess({
			id: "human_entry_process",
			displayName: "Human Entry",
			entry: "review",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				review: humanTurn({
					description: "Review",
					actions: {
						approve: {
							label: "Approve",
							acceptanceState: "accepted",
							complete: true,
						},
					},
				}),
			},
		});

		expect(process.entryTurnId).toBe("review");
		expect(process.turns.get("review")?.definition.kind).toBe("human");
	});

	it("does not parse params or initial state during compilation", () => {
		const throwingCodec = {
			parse(value: unknown) {
				if (value === undefined) {
					throw new Error("parse(undefined) should not be called");
				}
				return value as { prompt: string };
			},
			serialize(value: { prompt: string }) {
				return value;
			},
		};

		expect(() =>
			defineProcess({
				id: "no_template_params_process",
				displayName: "No Template Params",
				entry: "draft",
				paramsCodec: throwingCodec,
				stateCodec,
				initialState() {
					throw new Error("initialState should not be called during compilation");
				},
				turns: {
					draft: llmTurn({
						availableTools: [],
						description: "Draft",
						branchType: "primary",
						context: "fresh",
						prompt: async () => "draft",
						turnEnd: { outcome: "done", params: {}, complete: true },
					}),
				},
			}),
		).not.toThrow();
	});

	it("supports lifecycle-status-only action routes", async () => {
		const process = defineProcess({
			id: "abort_action_process",
			displayName: "Abort Action",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "review" },
				}),
				review: humanTurn({
					description: "Review",
					actions: {
						abort_process: {
							label: "Abort",
							acceptanceState: "neutral",
							lifecycleStatus: "aborted",
						},
					},
				}),
			},
		});

		expect(transitionsFor(process, "review")).toEqual([
			{ lifecycleStatus: "aborted", trigger: "abort_process" },
		]);

		const action = buildServerProcessForTest(process)?.actions.get("abort_process");
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}
		const transitions: Array<Record<string, unknown>> = [];
		await action.plan(
			{},
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: "review",
					lifecycleStatus: "waiting",
				}),
				state: { branch: "draft" },
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
			}),
		);
		expect(transitions).toEqual([
			{ turnId: null, lifecycleStatus: "aborted", trigger: "abort_process" },
		]);
	});

	it("rejects shared action ids that declare inconsistent forms", () => {
		const firstForm: FormDefinition = {
			id: "first",
			title: "First",
			fields: [{ id: "message", label: "Message", kind: "textarea", primaryPrompt: true }],
		};
		const secondForm: FormDefinition = {
			id: "second",
			title: "Second",
			fields: [{ id: "count", label: "Count", kind: "number" }],
		};
		const process = defineProcess({
			id: "inconsistent_form_process",
			displayName: "Inconsistent Form",
			entry: "draft",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ branch: "draft" }),
			turns: {
				draft: llmTurn({
					availableTools: [],
					description: "Draft",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "draft",
					turnEnd: { outcome: "ready", params: {}, to: "start" },
				}),
				start: humanTurn({
					description: "Start",
					actions: {
						retry: {
							label: "Retry",
							acceptanceState: "neutral",
							form: firstForm,
							to: "done",
						},
					},
				}),
				alternate: humanTurn({
					description: "Alternate",
					actions: {
						retry: {
							label: "Retry",
							acceptanceState: "neutral",
							form: secondForm,
							to: "done",
						},
					},
				}),
				done: automaticTurn({
					description: "Done",
					run: () => ({ outcome: "completed", params: {} }),
					outcomes: {
						completed: {
							description: "completed",
							parameters: {},
							complete: true,
						},
					},
				}),
			},
		});

		expect(() => buildServerProcessForTest(process)).toThrow(/same form/);
	});
});
