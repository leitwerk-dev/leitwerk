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
	emptyParamsCodec,
	type FormDefinition,
	getProcessGraph,
	humanTurn,
	type LlmTurnDefinition,
	llmTurn,
	revisionAction,
} from "./index.js";

function draftTurn(
	overrides: Partial<LlmTurnDefinition<string, Record<string, never>, { branch: string }>>,
) {
	return llmTurn({
		availableTools: [],
		description: "Draft",
		branchType: "primary",
		context: "fresh",
		prompt: async () => "draft",
		...overrides,
	});
}

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
		draft: draftTurn({
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

async function executeAction<TState>(
	process: ExtensionProcessDefinition<Record<string, never>, TState>,
	actionId: string,
	selectedTurnId: string,
	state: TState,
	input: Record<string, unknown> = {},
) {
	const plan = buildServerProcessForTest(process)?.actions.get(actionId)?.plan;
	if (!plan) throw new Error(`Missing action plan '${actionId}'`);
	const transitions: unknown[] = [];
	const queuedInputs: unknown[] = [];
	await plan(
		input,
		createTestServerProcessContext({
			process: createTestProcessInstance({
				processId: process.id,
				selectedTurnId,
				lifecycleStatus: "waiting",
			}),
			params: {},
			state,
			transition: async (next) => {
				transitions.push(next);
			},
			queueInput: (queued) => {
				queuedInputs.push(queued);
			},
		}),
	);
	return { transitions, queuedInputs };
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
				draft: draftTurn({
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
				draft: draftTurn({
					completionMode: "turn_end",
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
				draft: draftTurn({
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
				draft: draftTurn({
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
				draft: draftTurn({
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

		const { transitions } = await executeAction(process, "retry", "alternate", {
			branch: "initial",
		});

		expect(transitions).toEqual([
			{ turnId: "done", trigger: "retry", state: { branch: "from-alternate" } },
		]);
	});

	it("queues trimmed revision input through revisionAction", async () => {
		const process = defineTestProcess({
			id: "revision_action_process",
			turns: {
				draft: draftTurn({
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

		const { transitions, queuedInputs } = await executeAction(
			process,
			"revise",
			"review",
			{ branch: "draft" },
			{ message: "  tighten the ending  " },
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

		await expect(
			executeAction(process, "revise", "review", { branch: "draft" }, { message: "   " }),
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
		const { transitions } = await executeAction(
			process,
			"continue",
			"decision",
			{},
			{ tone: "calm" },
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

	it.each([
		{
			branch: "skip",
			transition: {
				turnId: "decision",
				trigger: "return_without_handoff",
				state: { branch: "skip" },
			},
			queuedInputs: [],
		},
		{
			branch: "apply",
			transition: { turnId: "draft", trigger: "handoff_review", state: { branch: "applied" } },
			queuedInputs: [
				{
					source: "action_prompt",
					kind: "instruction",
					target: { semanticRef: "currentPrimaryPathLeaf" },
					bodyMarkdown: "Apply the accepted review.",
				},
			],
		},
	])("uses the chosen branch trigger for accepted-review handoff: $branch", async ({
		branch,
		transition,
		queuedInputs,
	}) => {
		const process = defineTestProcess({
			id: "accepted_review_handoff_process",
			initialState: () => ({ branch: "review" }),
			turns: {
				draft: draftTurn({
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

		const result = await executeAction(process, "accept_review", "decision", { branch });
		expect(result.transitions).toEqual([transition]);
		expect(result.queuedInputs).toEqual(queuedInputs);
	});

	it("compiles external source transitions without registering visible actions", async () => {
		const process = defineTestProcess({
			id: "external_turn_process",
			turns: {
				draft: draftTurn({
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

	it.each([
		{
			name: "schedulable branches without a preview",
			routing: {
				schedulable: true,
				branches: { first: { to: "draft" }, second: { to: "finalize" } },
				choose: async () => "first",
			},
			error: /schedulable/,
		},
		{
			name: "a trigger preview that disagrees with its route",
			routing: { to: "finalize", preview: { kind: "trigger", trigger: "wrong_trigger" } },
			error: /does not match a compiled transition/,
		},
		{
			name: "a fixed-turn preview that disagrees with its branches",
			routing: {
				preview: { kind: "fixed_turn", turnId: "missing_target" },
				branches: { first: { to: "draft" }, second: { to: "finalize" } },
				choose: async () => "first",
			},
			error: /does not match a compiled transition/,
		},
	] as const)("rejects $name", ({ routing, error }) => {
		expect(() =>
			defineTestProcess({
				turns: {
					...basicTurns(),
					review: humanTurn({
						description: "Review",
						actions: { decide: { label: "Decide", acceptanceState: "neutral", ...routing } },
					}),
				},
			}),
		).toThrow(error);
	});

	it("supports lifecycle-status-only action routes", async () => {
		const process = defineTestProcess({
			id: "abort_action_process",
			turns: {
				draft: draftTurn({
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

		const { transitions } = await executeAction(process, "abort_process", "review", {
			branch: "draft",
		});
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
				entry: "start",
				turns: {
					start: humanTurn({
						description: "Start",
						actions: {
							retry: {
								label: "Retry",
								acceptanceState: "neutral",
								form: firstForm,
								complete: true,
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
								complete: true,
							},
						},
					}),
				},
			}),
		).toThrow(/same form/);
	});
});
