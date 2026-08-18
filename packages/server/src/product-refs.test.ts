import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	automaticTurn,
	createEmptyStructuralProcessState,
	humanTurn,
	llmTurn,
	serverAutomaticTurn,
} from "@leitwerk-dev/process-sdk";
import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import {
	deriveInputConsumedProductRefPatch,
	deriveTurnOutcomeProductRefPatch,
	mergeProductRefPatchIntoStateJson,
} from "./product-ref-state.js";
import { resolveProductTurnResultMarkdown } from "./product-turn-result-markdown.js";
import {
	deriveTurnOutcomeSemanticEntryRefPatch,
	mergeSemanticEntryRefPatchIntoStateJson,
} from "./semantic-entry-ref-state.js";
import { createWorkerStartPayloadBuilder } from "./supervisor/worker-start-payload-builder.js";
import {
	createFixtureLlmTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const tempDirs: string[] = [];

function createTempRoot() {
	const dir = mkdtempSync(path.join(tmpdir(), "leitwerk-product-refs-"));
	tempDirs.push(dir);
	return dir;
}

function prepareProductWorkerStart(
	deps: ReturnType<typeof createTestDeps>,
	processId: string,
	config: ReturnType<typeof getDefaultConfig>,
) {
	const bundle = createCanonicalPiResourceBundle([
		{ path: "generated.json", content: Buffer.from("{}") },
		{ path: "settings.json", content: Buffer.from("{}") },
	]);
	config.pi.model_profiles = [
		{
			id: "fixture-profile",
			provider: "fixture-provider",
			model_id: "fixture-model",
			thinking_level: "off",
		},
	];
	deps.processes.update(processId, {
		defaultModelProfileId: "fixture-profile",
		selectedTurnModelProfileId: "fixture-profile",
		selectedTurnModelSource: "instance_default",
	});
	const current = deps.processes.getById(processId);
	if (!current?.selectedTurnId) throw new Error("Fixture process has no selected turn");
	const start = deps.turnStarts.create({
		id: `tsr_product_${crypto.randomUUID()}`,
		instanceId: processId,
		turnId: current.selectedTurnId,
		turnType: "llm",
		proposedTurnRecordId: `trn_product_${crypto.randomUUID()}`,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: {
					profileId: "fixture-profile",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: bundle.digest,
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
	});
	deps.processes.update(processId, { currentExecution: { kind: "worker_start", id: start.id } });
	deps.leases.create({ instanceId: processId, workerId: "wkr_1", state: "bootstrapping" });
	return bundle;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("product refs", () => {
	it("publishing a custom product updates productRefs", () => {
		const stateJson = JSON.stringify(createEmptyStructuralProcessState());
		const patch = deriveTurnOutcomeProductRefPatch({
			turnRecordId: "trn_impl_1",
			publishedProduct: "implementation-summary",
			resultPiEntryId: "ent_impl_1",
		});

		expect(JSON.parse(mergeProductRefPatchIntoStateJson(stateJson, patch) ?? "{}")).toMatchObject({
			productRefs: {
				"implementation-summary": {
					entryId: "ent_impl_1",
					turnRecordId: "trn_impl_1",
				},
			},
		});
	});

	it("targeted product input acknowledgements move the product branch anchor", () => {
		const stateJson = JSON.stringify(createEmptyStructuralProcessState());
		const patch = deriveInputConsumedProductRefPatch({
			targetProductName: "simplification-plan",
			targetEntryId: "ent_handoff_1",
		});

		expect(JSON.parse(mergeProductRefPatchIntoStateJson(stateJson, patch) ?? "{}")).toMatchObject({
			productRefs: {
				"simplification-plan": {
					entryId: "ent_handoff_1",
					turnRecordId: null,
				},
			},
		});
	});

	it("refuses to derive a product ref patch without a result entry", () => {
		expect(() =>
			deriveTurnOutcomeProductRefPatch({
				turnRecordId: "trn_impl_1",
				publishedProduct: "implementation-summary",
				resultPiEntryId: null,
			}),
		).toThrow(/without a result entry/);
	});

	it("fails fast instead of patching malformed product-ref state", () => {
		const patch = deriveTurnOutcomeProductRefPatch({
			turnRecordId: "trn_impl_1",
			publishedProduct: "implementation-summary",
			resultPiEntryId: "ent_impl_1",
		});

		expect(() => mergeProductRefPatchIntoStateJson("{", patch)).toThrow(/Malformed stateJson/);
		expect(() =>
			mergeProductRefPatchIntoStateJson(JSON.stringify({ productRefs: [] }), patch),
		).toThrow(/Malformed productRefs/);
		expect(() =>
			mergeProductRefPatchIntoStateJson(
				JSON.stringify({ productRefs: { "Bad Product": { entryId: "ent_bad" } } }),
				patch,
			),
		).toThrow(/invalid product name/);
		expect(() =>
			mergeProductRefPatchIntoStateJson(
				JSON.stringify({ productRefs: { plan: { entryId: "" } } }),
				patch,
			),
		).toThrow(/product 'plan' must reference an entry/);
	});

	it("publishing plan and review can update product refs alongside compatibility semantic refs", () => {
		const stateJson = JSON.stringify(createEmptyStructuralProcessState());
		const planSemanticStateJson = mergeSemanticEntryRefPatchIntoStateJson(
			stateJson,
			deriveTurnOutcomeSemanticEntryRefPatch({
				turnRecordId: "trn_plan_1",
				resultSemanticRef: "plan",
				pathType: "primary",
				resultPiEntryId: "ent_plan",
			}),
		);
		const planProductStateJson = mergeProductRefPatchIntoStateJson(
			planSemanticStateJson ?? stateJson,
			deriveTurnOutcomeProductRefPatch({
				turnRecordId: "trn_plan_1",
				publishedProduct: "plan",
				resultPiEntryId: "ent_plan",
			}),
		);
		const reviewSemanticStateJson = mergeSemanticEntryRefPatchIntoStateJson(
			planProductStateJson ?? planSemanticStateJson ?? stateJson,
			deriveTurnOutcomeSemanticEntryRefPatch({
				turnRecordId: "trn_review_1",
				resultSemanticRef: "review",
				pathType: "root_branch",
				resultPiEntryId: "ent_review",
			}),
		);
		const reviewState = JSON.parse(
			mergeProductRefPatchIntoStateJson(
				reviewSemanticStateJson ?? planProductStateJson ?? stateJson,
				deriveTurnOutcomeProductRefPatch({
					turnRecordId: "trn_review_1",
					publishedProduct: "review",
					resultPiEntryId: "ent_review",
				}),
			) ?? "{}",
		);

		expect(reviewState.productRefs).toMatchObject({
			plan: { entryId: "ent_plan", turnRecordId: "trn_plan_1" },
			review: { entryId: "ent_review", turnRecordId: "trn_review_1" },
		});
		expect(reviewState.semanticEntryRefs).toMatchObject({
			plan: { entryId: "ent_plan", turnRecordId: "trn_plan_1" },
			review: { entryId: "ent_review", turnRecordId: "trn_review_1" },
		});
	});

	it("resolves custom product turn-result markdown and rejects malformed refs", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "consumer",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				productRefs: {
					"implementation-summary": {
						entryId: "ent_impl_1",
						turnRecordId: "trn_impl_1",
					},
				},
			}),
		});
		deps.turnRecords.create({
			id: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			status: "succeeded",
			resultPiEntryId: "ent_impl_1",
			turnResultMarkdown: "## Implementation",
		});

		expect(
			resolveProductTurnResultMarkdown({
				process,
				productName: "implementation-summary",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toBe("## Implementation");

		expect(() =>
			resolveProductTurnResultMarkdown({
				process: { ...process, stateJson: JSON.stringify(createEmptyStructuralProcessState()) },
				productName: "implementation-summary",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toThrow(/requires product 'implementation-summary'/);
		expect(() =>
			resolveProductTurnResultMarkdown({
				process: {
					...process,
					stateJson: JSON.stringify({
						...createEmptyStructuralProcessState(),
						productRefs: {
							"implementation-summary": {
								entryId: "ent_impl_1",
								turnRecordId: "trn_missing",
							},
						},
					}),
				},
				productName: "implementation-summary",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toThrow(/references missing turn record 'trn_missing'/);

		const otherProcess = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "consumer",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_other",
			instanceId: otherProcess.id,
			turnId: "implement",
			status: "succeeded",
			resultPiEntryId: "ent_other",
			turnResultMarkdown: "## Other",
		});
		expect(() =>
			resolveProductTurnResultMarkdown({
				process: {
					...process,
					stateJson: JSON.stringify({
						...createEmptyStructuralProcessState(),
						productRefs: {
							"implementation-summary": {
								entryId: "ent_other",
								turnRecordId: "trn_other",
							},
						},
					}),
				},
				productName: "implementation-summary",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toThrow(/from process/);
	});

	it("rejects published-product outcomes that cannot create a durable product ref", async () => {
		const deps = createTestDeps();
		const processDefinition = createFixtureProcess({
			id: "product_process",
			entry: "publish",
			turns: {
				publish: createFixtureLlmTurn("publish", {
					publishedProduct: "implementation-summary",
					turnEnd: {
						outcome: "implementation-summary",
						params: {},
						complete: true,
					},
				}),
			},
		});
		const processGraphs = createProcessGraphRegistry([processDefinition]);
		const registry = buildProcessActionRegistry({ processes: processGraphs });
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});
		const process = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "publish",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});
		deps.turnRecords.create({
			id: "trn_publish_1",
			instanceId: process.id,
			turnId: "publish",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});

		const missingEntry = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_publish_1",
			turnId: "publish",
			turnType: "llm",
			outcome: "implementation-summary",
			pathType: "primary",
			turnResultMarkdown: "## Implementation",
			params: {},
		});

		expect(missingEntry.ok).toBe(false);
		expect(missingEntry.code).toBe("published_product_result_entry_missing");
		expect(deps.turnRecords.getById("trn_publish_1")?.status).toBe("running");

		const blankMarkdown = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_publish_1",
			turnId: "publish",
			turnType: "llm",
			outcome: "implementation-summary",
			pathType: "primary",
			resultPiEntryId: "ent_impl_1",
			turnResultMarkdown: "   ",
			params: {},
		});

		expect(blankMarkdown.ok).toBe(false);
		expect(blankMarkdown.code).toBe("published_product_markdown_missing");
		expect(JSON.parse(deps.processes.getById(process.id)?.stateJson ?? "{}")).toMatchObject({
			productRefs: {},
		});
	});

	it("publishes selected outcome markdown fields as products", async () => {
		const deps = createTestDeps();
		const processDefinition = createFixtureProcess({
			id: "outcome_message_process",
			entry: "review",
			turns: {
				review: llmTurn({
					availableTools: [],
					description: "Review",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "Review",
					outcomes: {
						leave_feedback: {
							description: "Leave feedback",
							parameters: { message: { type: "string", description: "Message", required: true } },
							publishedProduct: "message",
							turnResultMarkdownParameter: "message",
							complete: true,
						},
					},
				}),
			},
		});
		const processGraphs = createProcessGraphRegistry([processDefinition]);
		const registry = buildProcessActionRegistry({ processes: processGraphs });
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});
		const process = deps.processes.create({
			processId: "outcome_message_process",
			selectedTurnId: "review",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});
		deps.turnRecords.create({
			id: "trn_review_1",
			instanceId: process.id,
			turnId: "review",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});

		const result = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_review_1",
			turnId: "review",
			turnType: "llm",
			outcome: "leave_feedback",
			pathType: "primary",
			resultPiEntryId: "ent_review_1",
			turnResultMarkdown: "Please tighten the ending.",
			params: { message: "Please tighten the ending." },
		});

		expect(result.ok).toBe(true);
		expect(
			resolveProductTurnResultMarkdown({
				process: deps.processes.getById(process.id) ?? process,
				productName: "message",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toBe("Please tighten the ending.");
	});

	it("publishes automatic outcome markdown parameters as products", async () => {
		const deps = createTestDeps();
		const processDefinition = createFixtureProcess({
			id: "automatic_message_process",
			entry: "produce",
			turns: {
				produce: automaticTurn({
					description: "Produce message",
					run: async () => ({ outcome: "published", params: { message: "Published" } }),
					outcomes: {
						published: {
							description: "Published",
							parameters: {
								message: { type: "string", description: "Message", required: true },
							},
							publishedProduct: "message",
							turnResultMarkdownParameter: "message",
							complete: true,
						},
					},
				}),
			},
		});
		const processGraphs = createProcessGraphRegistry([processDefinition]);
		const registry = buildProcessActionRegistry({ processes: processGraphs });
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});
		const process = deps.processes.create({
			processId: "automatic_message_process",
			selectedTurnId: "produce",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});
		deps.turnRecords.create({
			id: "trn_auto_1",
			instanceId: process.id,
			turnId: "produce",
			turnType: "automatic",
			status: "running",
			pathType: "primary",
		});

		const result = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_auto_1",
			turnId: "produce",
			turnType: "automatic",
			outcome: "published",
			params: { message: "Published from params" },
			pathType: "primary",
			turnResultMarkdown: null,
		});

		expect(result.ok).toBe(true);
		expect(deps.turnRecords.getById("trn_auto_1")?.resultPiEntryId).toBe(
			"automatic:trn_auto_1:message",
		);
		expect(
			resolveProductTurnResultMarkdown({
				process: deps.processes.getById(process.id) ?? process,
				productName: "message",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toBe("Published from params");
	});

	it("publishes server-automatic outcome markdown parameters as products", async () => {
		const deps = createTestDeps();
		const processDefinition = createFixtureProcess({
			id: "server_automatic_message_process",
			entry: "produce",
			turns: {
				produce: serverAutomaticTurn({
					description: "Produce message",
					run: async () => ({ outcome: "published", params: { message: "Published" } }),
					outcomes: {
						published: {
							description: "Published",
							parameters: {
								message: { type: "string", description: "Message", required: true },
							},
							publishedProduct: "message",
							turnResultMarkdownParameter: "message",
							complete: true,
						},
					},
				}),
			},
		});
		const processGraphs = createProcessGraphRegistry([processDefinition]);
		const registry = buildProcessActionRegistry({ processes: processGraphs });
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});
		const process = deps.processes.create({
			processId: "server_automatic_message_process",
			selectedTurnId: "produce",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});
		deps.turnRecords.create({
			id: "trn_server_auto_1",
			instanceId: process.id,
			turnId: "produce",
			turnType: "server_automatic",
			status: "running",
			pathType: "primary",
		});
		deps.processes.update(process.id, {
			currentExecution: { kind: "server_turn", id: "trn_server_auto_1" },
		});

		const result = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_server_auto_1",
			turnId: "produce",
			turnType: "server_automatic",
			outcome: "published",
			params: { message: "Published from params" },
			pathType: "primary",
			turnResultMarkdown: null,
		});

		expect(result.ok).toBe(true);
		expect(deps.turnRecords.getById("trn_server_auto_1")?.resultPiEntryId).toBe(
			"server_automatic:trn_server_auto_1:message",
		);
		expect(
			resolveProductTurnResultMarkdown({
				process: deps.processes.getById(process.id) ?? process,
				productName: "message",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toBe("Published from params");
	});

	it("publishes human action form fields as products", async () => {
		const deps = createTestDeps();
		const processDefinition = createFixtureProcess({
			id: "form_message_process",
			entry: "review",
			turns: {
				review: humanTurn({
					description: "Review",
					actions: {
						request_revision: {
							label: "Request revision",
							acceptanceState: "requires_changes",
							form: {
								id: "request_revision",
								title: "Request revision",
								fields: [
									{
										id: "message",
										label: "Message",
										kind: "textarea",
										primaryPrompt: true,
										required: true,
										publish: true,
									},
								],
							},
							complete: true,
						},
					},
				}),
			},
		});
		const processGraphs = createProcessGraphRegistry([processDefinition]);
		const registry = buildProcessActionRegistry({ processes: processGraphs });
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});
		const process = deps.processes.create({
			processId: "form_message_process",
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});

		const result = await commands.executeProcessAction(process.id, "request_revision", {
			message: "Revise the plan with more detail.",
		});

		expect(result.ok).toBe(true);
		expect(
			resolveProductTurnResultMarkdown({
				process: deps.processes.getById(process.id) ?? process,
				productName: "message",
				turnRecords: deps.turnRecords,
				required: true,
			}),
		).toBe("Revise the plan with more detail.");
	});

	it("worker start payload includes turn-result markdown by product", () => {
		const deps = createTestDeps();
		const tempRoot = createTempRoot();
		const config = getDefaultConfig();
		config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
		config.storage.tree_files_dir = path.join(tempRoot, "trees");
		const process = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "consumer",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				productRefs: {
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
		});
		deps.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: "https://example.invalid/repo.git",
			baseBranch: "main",
			workBranch: "feature/test",
		});
		deps.turnRecords.create({
			id: "trn_plan",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "succeeded",
			resultPiEntryId: "ent_plan",
			turnResultMarkdown: "## Plan",
		});
		const processGraphs = createProcessGraphRegistry([
			createFixtureProcess({
				id: "product_process",
				entry: "consumer",
				turns: {
					consumer: createFixtureLlmTurn("consumer", {
						consumedProducts: ["plan"],
					}),
				},
			}),
		]);
		const bundle = prepareProductWorkerStart(deps, process.id, config);

		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs,
			processActionRegistry: { getTurnDefinition: () => undefined },
			resolveResourceBundle: (digest) => (digest === bundle.digest ? bundle : null),
		});

		expect(builder.buildStartMessage(process.id, "wkr_1")?.payload).toMatchObject({
			turnResultMarkdownByProduct: { plan: "## Plan" },
		});
	});

	it("does not deliver stale transition-scoped message products to later turns", () => {
		const deps = createTestDeps();
		const tempRoot = createTempRoot();
		const config = getDefaultConfig();
		config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
		config.storage.tree_files_dir = path.join(tempRoot, "trees");
		const process = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "consumer",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				productRefs: {
					message: { entryId: "ent_message", turnRecordId: "trn_message" },
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
		});
		deps.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: "https://example.invalid/repo.git",
			baseBranch: "main",
			workBranch: "feature/test",
		});
		deps.turnRecords.create({
			id: "trn_message",
			instanceId: process.id,
			turnId: "human_review",
			status: "succeeded",
			resultPiEntryId: "ent_message",
			turnResultMarkdown: "Old handoff message",
			startedAt: "2024-01-01T00:00:00.000Z",
			endedAt: "2024-01-01T00:00:01.000Z",
		});
		deps.turnRecords.create({
			id: "trn_plan",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "succeeded",
			resultPiEntryId: "ent_plan",
			turnResultMarkdown: "## Plan",
			startedAt: "2024-01-01T00:00:02.000Z",
			endedAt: "2024-01-01T00:00:03.000Z",
		});
		const processGraphs = createProcessGraphRegistry([
			createFixtureProcess({
				id: "product_process",
				entry: "consumer",
				turns: {
					consumer: createFixtureLlmTurn("consumer", {
						consumedProducts: ["plan"],
						optionalConsumedProducts: ["message"],
					}),
				},
			}),
		]);
		const bundle = prepareProductWorkerStart(deps, process.id, config);

		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs,
			processActionRegistry: { getTurnDefinition: () => undefined },
			resolveResourceBundle: (digest) => (digest === bundle.digest ? bundle : null),
		});

		expect(
			builder.buildStartMessage(process.id, "wkr_1")?.payload.turnResultMarkdownByProduct,
		).toEqual({ plan: "## Plan" });
	});

	it("allows a reviewed message product to pass through an accepting human review action", () => {
		const deps = createTestDeps();
		const tempRoot = createTempRoot();
		const config = getDefaultConfig();
		config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
		config.storage.tree_files_dir = path.join(tempRoot, "trees");
		const process = deps.processes.create({
			processId: "product_process",
			selectedTurnId: "consumer",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				productRefs: {
					message: { entryId: "ent_message", turnRecordId: "trn_message" },
				},
			}),
		});
		deps.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: "https://example.invalid/repo.git",
			baseBranch: "main",
			workBranch: "feature/test",
		});
		deps.turnRecords.create({
			id: "trn_message",
			instanceId: process.id,
			turnId: "llm_review",
			status: "succeeded",
			resultPiEntryId: "ent_message",
			turnResultMarkdown: "Reviewed handoff message",
			startedAt: "2024-01-01T00:00:00.000Z",
			endedAt: "2024-01-01T00:00:01.000Z",
		});
		deps.turnRecords.create({
			id: "trn_accept",
			instanceId: process.id,
			turnId: "human_review",
			turnType: "human",
			status: "succeeded",
			startedAt: "2024-01-01T00:00:02.000Z",
			endedAt: "2024-01-01T00:00:03.000Z",
		});
		const processGraphs = createProcessGraphRegistry([
			createFixtureProcess({
				id: "product_process",
				entry: "consumer",
				turns: {
					consumer: createFixtureLlmTurn("consumer", {
						optionalConsumedProducts: ["message"],
					}),
					human_review: humanTurn({
						description: "Review message",
						reviewProduct: "message",
						actions: {
							accept: { label: "Accept", acceptanceState: "accepted", to: "consumer" },
						},
					}),
				},
			}),
		]);
		const bundle = prepareProductWorkerStart(deps, process.id, config);

		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs,
			processActionRegistry: { getTurnDefinition: () => undefined },
			resolveResourceBundle: (digest) => (digest === bundle.digest ? bundle : null),
		});

		expect(
			builder.buildStartMessage(process.id, "wkr_1")?.payload.turnResultMarkdownByProduct,
		).toEqual({ message: "Reviewed handoff message" });
	});
});
