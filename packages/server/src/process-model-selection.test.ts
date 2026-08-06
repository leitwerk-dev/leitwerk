import type { ProcessInstance } from "@leitwerk-dev/domain";
import {
	createEmptyStructuralProcessState,
	defineProcess,
	type ProcessActionDefinition,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { createEmptyParsedInstanceTree } from "./instance-tree.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessModelSelection } from "./process-model-selection.js";
import { createFixtureHumanTurn, createFixtureLlmTurn } from "./test-helpers/process-fixtures.js";
import {
	createModelAvailabilitySnapshot,
	createTestProcessInstance,
	createTestTurnRecord,
	createTestTurnStart,
} from "./test-helpers/process-model-fixtures.js";

const processId = "selection_process";

function action(id: string, definition: Omit<ProcessActionDefinition, "id" | "label">) {
	return { id, label: id, ...definition } satisfies ProcessActionDefinition;
}

function buildProcessDefinition() {
	return defineProcess({
		id: processId,
		displayName: "Selection process",
		entry: "plan_review",
		turns: {
			plan_review: createFixtureHumanTurn({
				actions: {
					approve_route: {
						label: "Approve",
						acceptanceState: "accepted",
						trigger: "approved",
						to: "implement",
					},
					stay_route: {
						label: "Stay",
						acceptanceState: "neutral",
						trigger: "stay",
						to: "plan_review",
					},
					impure_route: {
						label: "Impure",
						acceptanceState: "neutral",
						trigger: "impure",
						to: "plan_review",
					},
					hidden: {
						label: "Hidden",
						acceptanceState: "neutral",
						trigger: "hidden",
						to: "plan_review",
					},
				},
			}),
			other_human: createFixtureHumanTurn({
				description: "Other",
				actions: {
					finish: {
						label: "Finish",
						acceptanceState: "accepted",
						complete: true,
					},
				},
			}),
			implement: createFixtureLlmTurn("Implement", { context: "full" }),
		},
		paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		stateCodec: {
			parse: (value: unknown) => (value ?? {}) as Record<string, unknown>,
			serialize: (value: unknown) => value,
		},
		initialState: () => createEmptyStructuralProcessState(),
		server(api) {
			api.action(
				action("approve", {
					async plan(_input, ctx) {
						await ctx.transition({ turnId: "implement", trigger: "approved" });
					},
				}),
			);
			api.action(
				action("stay", {
					plan: async (_input, ctx) => {
						ctx.queueInput({
							source: "action_prompt",
							kind: "instruction",
							bodyMarkdown: "Stay",
						});
					},
				}),
			);
			api.action(
				action("impure", {
					executionMode: "side_effect",
					execute: async () => {},
				}),
			);
		},
	});
}

function createProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return createTestProcessInstance({
		id: "agt_selection",
		processId,
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		paramsJson: "{}",
		stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		...overrides,
	});
}

const processGraphs = new Map([[processId, buildProcessDefinition()]]);
const generatedRegistry = buildProcessActionRegistry({ processes: processGraphs });
const hiddenAction = action("hidden", { plan: async () => {} });
const processActionRegistry = {
	...generatedRegistry,
	getAction(candidateProcessId: string, actionId: string) {
		return candidateProcessId === processId && actionId === hiddenAction.id
			? hiddenAction
			: generatedRegistry.getAction(candidateProcessId, actionId);
	},
};
const config = getDefaultConfig();
config.pi.model_profiles = [{ id: "fast", provider: "fixture", model_id: "model" }];
config.process_configs = {
	[processId]: {
		default_model_profile: "fast",
		turn_configs: {},
	},
};
const processModelPolicy = createServerProcessModelPolicy({
	config,
	processGraphs,
	processActionRegistry,
});
const record = createTestTurnRecord({
	id: "trn_previous",
	instanceId: "agt_selection",
	turnId: "previous",
	turnStartRecordId: "tsr_previous",
	acceptedWorkerLeaseId: "lease_previous",
	forkPiEntryId: "root",
	resultPiEntryId: "previous-leaf",
	modelProfileId: "fast",
	startedAt: new Date(Date.now() - 120_000).toISOString(),
	endedAt: new Date(Date.now() - 60_000).toISOString(),
});
const turnStart = createTestTurnStart({
	id: "tsr_previous",
	instanceId: "agt_selection",
	turnId: "previous",
	proposedTurnRecordId: "trn_previous",
	state: {
		kind: "accepted",
		start: {
			kind: "llm",
			model: {
				profileId: "fast",
				providerId: "fixture",
				modelId: "model",
				thinkingLevel: "off",
			},
			providerOptions: {},
			providerWorkerConfig: null,
			piResourceSnapshotDigest: "digest",
			workerRuntimeProfileId: "default",
			piSettings: {},
		},
		turnRecordId: "trn_previous",
		acceptedWorkerLeaseId: "lease_previous",
	},
});

function createHarness(input: {
	process?: ProcessInstance | null;
	scheduledActionId?: string | null;
	treeEntryIds?: readonly string[];
	treeError?: Error;
}) {
	const process = input.process === undefined ? createProcess() : input.process;
	const projects = { listByInstance: vi.fn(() => []) };
	const instanceTrees = {
		readInstanceTree: vi.fn(async () => {
			if (input.treeError) throw input.treeError;
			const tree = createEmptyParsedInstanceTree();
			for (const entryId of input.treeEntryIds ?? []) {
				tree.entriesById.set(entryId, { id: entryId, type: "message", role: "user" });
			}
			return tree;
		}),
	};
	const service = createProcessModelSelection({
		processGraphs,
		processActionRegistry,
		processes: { getById: () => process },
		projects,
		scheduledActions: {
			getScheduledActionByInstance: () =>
				input.scheduledActionId ? { actionId: input.scheduledActionId } : null,
		},
		turnRecords: {
			getById: (id) => (id === record.id ? record : null),
			listByInstance: () => [record],
		},
		turnStarts: { getById: () => turnStart },
		instanceTrees,
		processModelPolicy,
		modelStatusCache: {
			snapshot: () =>
				createModelAvailabilitySnapshot([
					{ profileId: "fast", providerId: "fixture", modelId: "model" },
				]),
		},
	});
	return { service, projects, instanceTrees };
}

describe("process model selection", () => {
	it("returns process_not_found without reading projects or the tree", async () => {
		const harness = createHarness({ process: null });

		await expect(harness.service.preview("missing", "approve", {})).resolves.toEqual({
			kind: "operational_failure",
			code: "process_not_found",
		});
		expect(harness.projects.listByInstance).not.toHaveBeenCalled();
		expect(harness.instanceTrees.readInstanceTree).not.toHaveBeenCalled();
	});

	it("projects available profiles from current policy and availability", () => {
		const { service } = createHarness({});

		expect(service.listAvailableProfiles("agt_selection")).toEqual([
			expect.objectContaining({ id: "fast", availability: "available" }),
		]);
	});

	it("returns llm_turn, not_applicable, and unavailable semantic previews", async () => {
		const { service } = createHarness({});

		await expect(service.preview("agt_selection", "approve", {})).resolves.toMatchObject({
			kind: "llm_turn",
			turnId: "implement",
			resolvedModel: { status: "resolved", modelProfileId: "fast" },
		});
		await expect(service.preview("agt_selection", "stay", {})).resolves.toMatchObject({
			kind: "not_applicable",
			turnId: "plan_review",
		});
		await expect(service.preview("agt_selection", "impure", {})).resolves.toMatchObject({
			kind: "unavailable",
			unavailableReason: "action_failed",
		});
	});

	it("allows a hidden turn action only when it matches the scheduled action", async () => {
		const hiddenProcess = createProcess({ selectedTurnId: "other_human" });
		const scheduled = createHarness({
			process: hiddenProcess,
			scheduledActionId: "hidden",
		});
		const unscheduled = createHarness({ process: hiddenProcess });

		await expect(scheduled.service.preview(hiddenProcess.id, "hidden", {})).resolves.toMatchObject({
			kind: "not_applicable",
			turnId: "other_human",
		});
		await expect(
			unscheduled.service.preview(hiddenProcess.id, "hidden", {}),
		).resolves.toMatchObject({
			kind: "unavailable",
			unavailableReason: "action_not_visible",
		});
	});

	it("uses current tree entry existence for warm-cache projection", async () => {
		const state = createEmptyStructuralProcessState();
		state.semanticEntryRefs.rootEntry = { entryId: "root", turnRecordId: null };
		state.semanticEntryRefs.currentPrimaryPathLeaf = {
			entryId: "previous-leaf",
			turnRecordId: "trn_previous",
		};
		const process = createProcess({ stateJson: JSON.stringify(state) });
		const present = createHarness({
			process,
			treeEntryIds: ["root", "previous-leaf"],
		});
		const missing = createHarness({ process, treeEntryIds: ["root"] });

		await expect(present.service.preview(process.id, "approve", {})).resolves.toMatchObject({
			kind: "llm_turn",
			warmPromptCache: {
				previousModelProfileId: "fast",
				compatibleModelProfileIds: ["fast"],
			},
		});
		const missingResult = await missing.service.preview(process.id, "approve", {});
		expect(missingResult.kind === "llm_turn" && missingResult.warmPromptCache).toBeUndefined();
	});

	it("classifies an instance-tree read failure as operational", async () => {
		const { service } = createHarness({ treeError: new Error("sensitive storage detail") });

		await expect(service.preview("agt_selection", "approve", {})).resolves.toEqual({
			kind: "operational_failure",
			code: "instance_tree_unavailable",
		});
	});
});
