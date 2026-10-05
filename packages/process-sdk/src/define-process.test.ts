import {
	buildExtensionCatalogFromModules,
	buildServerProcessForTest,
	buildWorkerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { externalTurn } from "./define-process.js";
import {
	acceptedReviewHandoffAction,
	automaticTurn,
	type DefinedProcessInput,
	defineProcess,
	type ExtensionProcessDefinition,
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

type TestProcessInput = DefinedProcessInput<Record<string, never>, { branch: string }>;

function defineTestProcess(input: Pick<TestProcessInput, "turns"> & Partial<TestProcessInput>) {
	return defineProcess({
		id: "defined_process",
		displayName: "Defined Process",
		entry: "draft",
		paramsCodec: emptyParamsCodec,
		stateCodec,
		initialState: () => ({ branch: "draft" }),
		...input,
	});
}

function createBasicProcess(alternateEntries?: readonly string[], happyPath?: readonly string[]) {
	return defineTestProcess({ turns: basicTurns(), alternateEntries, happyPath });
}

describe("defineProcess", () => {
	function defineWithActionForm(form: FormDefinition) {
		return defineTestProcess({
			id: "primary_prompt_validation",
			entry: "review",
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

	it.each([
		{ name: "all turns", happyPath: ["draft", "review", "finalize"] },
		{ name: "an omitted operator decision", happyPath: ["draft", "finalize"] },
	])("retains a connected happy path with $name", ({ happyPath }) => {
		expect(createBasicProcess(undefined, happyPath).happyPath).toEqual(happyPath);
	});

	it("rejects a happy path segment that is not connected by declared transitions", () => {
		expect(() =>
			defineTestProcess({
				id: "disconnected_happy_path",
				happyPath: ["draft", "finalize"],
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

	it.each([
		{ happyPath: ["review", "draft"], error: /happy path must start at the entry turn/ },
		{ happyPath: ["draft", "ghost"], error: /happy path references undeclared turn 'ghost'/ },
		{ happyPath: ["draft", "review", "draft"], error: /happy path repeats turn 'draft'/ },
	])("rejects invalid happy path $happyPath", ({ happyPath, error }) => {
		expect(() => createBasicProcess(undefined, happyPath)).toThrow(error);
	});

	it("allows generic operator-waiting human turns without review metadata", () => {
		const process = defineTestProcess({
			id: "generic_waiting_process",
			entry: "console",
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

		expect(process.entryTurnId).toBe("console");
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
		const process = defineTestProcess({
			id: "missing_outcome_route_process",
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
		const process = defineTestProcess({
			id: "missing_turn_end_route_process",
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

	it.each([
		false,
		true,
	])("routes an LLM outcome from persisted state (effect: %s)", async (withEffect) => {
		const process = defineTestProcess({
			id: "state_routed_outcome_process",
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
							...(withEffect ? { effect: () => ({ state: { branch: "automatic" } }) } : {}),
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
				state: { branch: withEffect ? "manual" : "automatic" },
				transition: async (next) => transitions.push(next as Record<string, unknown>),
			}),
		);
		expect(transitions).toEqual([
			{
				turnId: "deliver",
				trigger: "automatic",
				...(withEffect ? { state: { branch: "automatic" } } : {}),
			},
		]);
	});

	it("allows custom worker overrides for compiled turns", async () => {
		let overrideCalled = false;
		const process = defineTestProcess({
			id: "worker_override_process",
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
				api.turn("draft", async () => {
					overrideCalled = true;
				});
			},
		});

		const worker = buildWorkerProcessForTest(process);
		expect(worker?.turns.has("draft")).toBe(true);
		expect(worker?.turns.has("finalize")).toBe(true);
		expect(worker?.turns.size).toBe(2);
		await worker?.turns.get("draft")?.({} as never);
		expect(overrideCalled).toBe(true);
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
		const process = defineTestProcess({
			id: "shared_action_process",
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
		expect(action?.plan).toBeDefined();
		if (!action?.plan) throw new Error("Expected shared action plan");

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
		const process = defineTestProcess({
			id: "revision_action_process",
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
		const process = defineTestProcess({
			id: "revision_action_validation_process",
			entry: "review",
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
		const process = defineTestProcess({
			id: "accepted_review_handoff_process",
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
		const process = defineTestProcess({
			id: "external_turn_process",
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
			defineTestProcess({
				id: "ambiguous_schedule_process",
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
			defineTestProcess({
				id: "mismatched_preview_process",
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
			defineTestProcess({
				id: "mismatched_branch_preview_process",
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
		const process = defineTestProcess({
			id: "abort_action_process",
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
		expect(() =>
			defineTestProcess({
				id: "inconsistent_form_process",
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
			}),
		).toThrow(/same form/);
	});
});
