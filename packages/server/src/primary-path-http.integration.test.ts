import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	type Codec,
	createEmptyStructuralProcessState,
	defineProcess,
	emptyParamsCodec,
	humanTurn,
	type LeitwerkExtensionModule,
	parseStructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const structuralStateCodec: Codec<ReturnType<typeof createEmptyStructuralProcessState>> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

const snapshotProcess = defineProcess<
	Record<string, never>,
	ReturnType<typeof createEmptyStructuralProcessState>
>({
	id: "primary_path_test_process",
	displayName: "Primary Path Snapshot Test Process",
	entry: "snapshot",
	turns: {
		snapshot: humanTurn({
			description: "Snapshot",
			actions: { noop: { label: "No-op", acceptanceState: "accepted", complete: true } },
		}),
	},
	paramsCodec: emptyParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
});

const snapshotExtension: LeitwerkExtensionModule = {
	manifest: { id: "primary-path-http-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(snapshotProcess);
	},
};

let harness: IntegrationHarness;
let tempRoot = "";

beforeAll(async () => {
	tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-stage11-"));
	harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([snapshotExtension]),
		inProcessWorkers: false,
		configOverride(config) {
			config.storage.tree_files_dir = path.join(tempRoot, "trees");
			config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
			mkdirSync(config.storage.tree_files_dir, { recursive: true });
			mkdirSync(config.storage.process_workspaces_dir, { recursive: true });
		},
	});
});

afterAll(async () => {
	await harness.ctx.app.close();
	rmSync(tempRoot, { recursive: true, force: true });
});

function createPrimaryPathStateJson() {
	return JSON.stringify({
		...createEmptyStructuralProcessState(),
		semanticEntryRefs: {
			rootEntry: { entryId: "root-user", turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: "assistant-impl", turnRecordId: "trn_impl_1" },
			plan: { entryId: "assistant-plan", turnRecordId: "trn_plan_1" },
			review: { entryId: "review-entry", turnRecordId: "trn_review_1" },
		},
	});
}

function writePrimaryPathTree(instanceId: string) {
	const treeFile = path.join(harness.config.storage.tree_files_dir, `${instanceId}.jsonl`);
	writeFileSync(
		treeFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "sess-1",
				timestamp: "2026-04-13T10:00:00.000Z",
				cwd: "/tmp/project",
			}),
			JSON.stringify({
				type: "message",
				id: "root-user",
				parentId: null,
				timestamp: "2026-04-13T10:00:01.000Z",
				message: { role: "user", content: "Plan this change" },
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-plan",
				parentId: "root-user",
				timestamp: "2026-04-13T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "## Plan\n\n- Do the thing" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-impl",
				parentId: "assistant-plan",
				timestamp: "2026-04-13T10:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Implemented the change" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "review-entry",
				parentId: "root-user",
				timestamp: "2026-04-13T10:00:04.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Review findings" }],
				},
			}),
			JSON.stringify({
				type: "label",
				id: "label-1",
				parentId: "assistant-impl",
				timestamp: "2026-04-13T10:00:05.000Z",
				targetId: "assistant-plan",
				label: "approved-plan",
			}),
		].join("\n")}
`,
	);
}

function seedAcceptedWorkerTurn(input: {
	instanceId: string;
	turnRecordId: string;
	turnId: string;
	pathType: "primary" | "root_branch" | "leaf_branch";
	forkPiEntryId?: string;
	startedAt: string;
	workerId: string;
}) {
	const lease = harness.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: input.workerId,
		state: "busy",
	});
	const turnStartRecordId = `tsr_${input.turnRecordId}`;
	harness.ctx.deps.turnStarts.create({
		id: turnStartRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
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
				piResourceSnapshotDigest: "fixture-resource-digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	harness.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: "running",
		attemptNumber: 1,
		turnStartRecordId,
		acceptedWorkerLeaseId: lease.id,
		pathType: input.pathType,
		...(input.forkPiEntryId ? { forkPiEntryId: input.forkPiEntryId } : {}),
		startedAt: input.startedAt,
	});
	harness.ctx.deps.processes.update(input.instanceId, {
		currentExecution: { kind: "worker_start", id: turnStartRecordId },
	});
}

function seedSucceededWorkerTurn(input: {
	instanceId: string;
	turnRecordId: string;
	turnId: string;
	pathType: "primary" | "root_branch" | "leaf_branch";
	forkPiEntryId?: string;
	resultPiEntryId: string;
	startedAt: string;
	endedAt: string;
}) {
	const lease = harness.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_${input.turnRecordId}`,
		state: "busy",
	});
	const turnStartRecordId = `tsr_${input.turnRecordId}`;
	harness.ctx.deps.turnStarts.create({
		id: turnStartRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
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
				piResourceSnapshotDigest: "fixture-resource-digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	harness.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: "succeeded",
		attemptNumber: 1,
		turnStartRecordId,
		acceptedWorkerLeaseId: lease.id,
		pathType: input.pathType,
		...(input.forkPiEntryId ? { forkPiEntryId: input.forkPiEntryId } : {}),
		resultPiEntryId: input.resultPiEntryId,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
	});
}

describe("primary-path snapshot HTTP route", () => {
	it("returns a normalized primary-path snapshot with labels, semantic entry refs, annotations, and turn state", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			stateJson: createPrimaryPathStateJson(),
		});
		seedSucceededWorkerTurn({
			turnRecordId: "trn_plan_1",
			instanceId: process.id,
			turnId: "generate_plan",
			pathType: "primary",
			resultPiEntryId: "assistant-plan",
			startedAt: "2026-04-13T10:00:01.000Z",
			endedAt: "2026-04-13T10:00:02.000Z",
		});
		seedSucceededWorkerTurn({
			turnRecordId: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			resultPiEntryId: "assistant-impl",
			startedAt: "2026-04-13T10:00:02.500Z",
			endedAt: "2026-04-13T10:00:03.000Z",
		});
		seedSucceededWorkerTurn({
			turnRecordId: "trn_review_1",
			instanceId: process.id,
			turnId: "run_llm_review",
			pathType: "root_branch",
			forkPiEntryId: "root-user",
			resultPiEntryId: "review-entry",
			startedAt: "2026-04-13T10:00:03.500Z",
			endedAt: "2026-04-13T10:00:04.000Z",
		});
		harness.ctx.deps.turnAnnotations.create({
			instanceId: process.id,
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_plan_1",
			references: [
				{ kind: "turn_record", turnRecordId: "trn_plan_1", role: "subject" },
				{ kind: "entry", entryId: "assistant-plan", role: "subject" },
			],
			payload: { turnId: "generate_plan", outcome: "plan_saved" },
		});
		harness.ctx.deps.turnAnnotations.create({
			instanceId: process.id,
			annotationType: "semantic_marker",
			annotationKey: "latest_plan_marker",
			references: [{ kind: "semantic_entry_ref", ref: "plan", role: "subject" }],
			payload: { kind: "latest-plan" },
		});
		harness.ctx.deps.turnAnnotations.create({
			instanceId: process.id,
			annotationType: "review_marker",
			annotationKey: "latest_review_marker",
			references: [{ kind: "semantic_entry_ref", ref: "review", role: "subject" }],
			payload: { kind: "latest-review" },
		});
		seedAcceptedWorkerTurn({
			instanceId: process.id,
			turnRecordId: "trn_running",
			turnId: "implement",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			startedAt: "2026-04-13T10:00:05.000Z",
			workerId: "wkr_primary_path",
		});
		writePrimaryPathTree(process.id);

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.primaryPathEntries.map((entry: { id: string }) => entry.id)).toEqual([
			"root-user",
			"assistant-plan",
			"assistant-impl",
		]);
		expect(body.currentLeaf).toEqual({ entryId: "assistant-impl", turnRecordId: "trn_impl_1" });
		expect(body.semanticEntryRefs.review).toEqual({
			entryId: "review-entry",
			turnRecordId: "trn_review_1",
		});
		expect(body.labels).toEqual({ "assistant-plan": "approved-plan" });
		expect(body.turnAnnotations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ annotationKey: "turn_milestone:trn_plan_1" }),
				expect.objectContaining({ annotationKey: "latest_plan_marker" }),
			]),
		);
		expect(body.turnAnnotations).toHaveLength(2);
		expect(
			body.turnAnnotations.some(
				(annotation: { annotationKey: string }) =>
					annotation.annotationKey === "latest_review_marker",
			),
		).toBe(false);
		expect(body.detailRail).toEqual({
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		});
		expect(body.turnState).toEqual({
			currentTurnRecordId: "trn_running",
			workerState: "busy",
			isStreaming: true,
			activeTurn: {
				turnRecordId: "trn_running",
				turnId: "implement",
				turnType: "llm",
				pathType: "primary",
				startedAt: "2026-04-13T10:00:05.000Z",
				assistant: { text: "", thinking: "", lastUpdatedAt: null },
				toolCalls: [],
				traceItems: [],
				usage: null,
				eventWindowTruncated: false,
			},
		});
		expect(body.events).toBeUndefined();
	});

	it("falls back to tree and turn-record facts when primary path semantic refs are missing", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});
		seedSucceededWorkerTurn({
			turnRecordId: "trn_plan_fallback",
			instanceId: process.id,
			turnId: "generate_plan",
			pathType: "primary",
			resultPiEntryId: "assistant-plan",
			startedAt: "2026-04-13T10:00:01.000Z",
			endedAt: "2026-04-13T10:00:02.000Z",
		});
		seedSucceededWorkerTurn({
			turnRecordId: "trn_impl_fallback",
			instanceId: process.id,
			turnId: "implement",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			resultPiEntryId: "assistant-impl",
			startedAt: "2026-04-13T10:00:02.500Z",
			endedAt: "2026-04-13T10:00:03.000Z",
		});
		writePrimaryPathTree(process.id);

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.primaryPathEntries.map((entry: { id: string }) => entry.id)).toEqual([
			"root-user",
			"assistant-plan",
			"assistant-impl",
		]);
		expect(body.currentLeaf).toEqual({
			entryId: "assistant-impl",
			turnRecordId: "trn_impl_fallback",
		});
		expect(body.semanticEntryRefs.rootEntry).toEqual({
			entryId: "root-user",
			turnRecordId: null,
		});
		expect(body.semanticEntryRefs.currentPrimaryPathLeaf).toEqual({
			entryId: "assistant-impl",
			turnRecordId: "trn_impl_fallback",
		});
	});

	it("rebuilds live active-turn assistant and tool state from persisted events", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			stateJson: createPrimaryPathStateJson(),
		});
		writePrimaryPathTree(process.id);
		seedAcceptedWorkerTurn({
			instanceId: process.id,
			turnRecordId: "trn_running_live",
			turnId: "implement",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			startedAt: "2026-04-13T10:00:05.000Z",
			workerId: "wkr_live_turn",
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.stream.delta",
			data: {
				turnRecordId: "trn_running_live",
				turnId: "turn-7",
				streamType: "thinking",
				text: "Need to inspect the implementation.\n",
				timestamp: "2026-04-13T10:00:05.100Z",
			},
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.stream.delta",
			data: {
				turnRecordId: "trn_running_live",
				turnId: "turn-7",
				streamType: "text",
				text: "Implementing the change",
				timestamp: "2026-04-13T10:00:05.200Z",
			},
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.usage",
			data: {
				turnRecordId: "trn_running_live",
				turnId: "turn-7",
				input: 640,
				output: 180,
				cacheRead: 320,
				cacheWrite: 40,
				totalTokens: 1180,
				cost: {
					input: 0.0128,
					output: 0.0108,
					cacheRead: 0.0032,
					cacheWrite: 0.0016,
					total: 0.0284,
				},
				timestamp: "2026-04-13T10:00:05.250Z",
			},
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.tool.call",
			data: {
				turnRecordId: "trn_running_live",
				turnId: "turn-7",
				toolCallId: "tool-1",
				name: "run_tests",
				arguments: { suite: "unit" },
				timestamp: "2026-04-13T10:00:05.300Z",
			},
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.tool.result",
			data: {
				turnRecordId: "trn_running_live",
				turnId: "turn-7",
				toolCallId: "tool-1",
				name: "run_tests",
				result: { ok: true },
				isError: false,
				timestamp: "2026-04-13T10:00:05.400Z",
			},
		});
		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.turnState).toEqual({
			currentTurnRecordId: "trn_running_live",
			workerState: "busy",
			isStreaming: true,
			activeTurn: {
				turnRecordId: "trn_running_live",
				turnId: "implement",
				turnType: "llm",
				pathType: "primary",
				startedAt: "2026-04-13T10:00:05.000Z",
				assistant: {
					text: "Implementing the change",
					thinking: "Need to inspect the implementation.\n",
					lastUpdatedAt: "2026-04-13T10:00:05.200Z",
				},
				toolCalls: [
					{
						toolCallId: "tool-1",
						toolName: "run_tests",
						status: "completed",
						startedAt: "2026-04-13T10:00:05.300Z",
						completedAt: "2026-04-13T10:00:05.400Z",
						arguments: { suite: "unit" },
						result: { ok: true },
						isError: false,
					},
				],
				traceItems: [
					{ kind: "thinking", text: "Need to inspect the implementation.\n" },
					{ kind: "tool_call", toolCallId: "tool-1" },
				],
				usage: {
					input: 640,
					output: 180,
					cacheRead: 320,
					cacheWrite: 40,
					totalTokens: 1180,
					cost: {
						input: 0.0128,
						output: 0.0108,
						cacheRead: 0.0032,
						cacheWrite: 0.0016,
						total: 0.0284,
					},
					requestCount: 1,
					maxInputTokens: 640,
				},
				eventWindowTruncated: false,
			},
		});
	});

	it("marks the active-turn snapshot truncated when replay exceeds the bounded event window", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			stateJson: createPrimaryPathStateJson(),
		});
		writePrimaryPathTree(process.id);
		seedAcceptedWorkerTurn({
			instanceId: process.id,
			turnRecordId: "trn_running_truncated",
			turnId: "implement",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			startedAt: "2026-04-13T10:10:00.000Z",
			workerId: "wkr_live_turn_truncated",
		});
		for (let index = 0; index < 501; index += 1) {
			const seconds = String(Math.floor(index / 100)).padStart(2, "0");
			const milliseconds = String(index % 100).padStart(3, "0");
			harness.ctx.deps.events.create({
				instanceId: process.id,
				eventType: "pi.stream.delta",
				data: {
					turnRecordId: "trn_running_truncated",
					turnId: "turn-99",
					streamType: "text",
					text: `chunk-${index} `,
					timestamp: `2026-04-13T10:10:${seconds}.${milliseconds}Z`,
				},
			});
		}
		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.turnState.activeTurn).toMatchObject({
			turnRecordId: "trn_running_truncated",
			eventWindowTruncated: true,
		});
		expect(body.turnState.activeTurn.assistant.text).toContain("chunk-500");
	});

	it("includes annotations for the current running non-primary turn record", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
			stateJson: createPrimaryPathStateJson(),
		});
		writePrimaryPathTree(process.id);
		seedSucceededWorkerTurn({
			turnRecordId: "trn_impl_visible",
			instanceId: process.id,
			turnId: "implement",
			pathType: "primary",
			resultPiEntryId: "assistant-impl",
			startedAt: "2026-04-13T10:00:03.000Z",
			endedAt: "2026-04-13T10:00:04.000Z",
		});
		seedAcceptedWorkerTurn({
			instanceId: process.id,
			turnRecordId: "trn_review_running",
			turnId: "run_llm_review",
			pathType: "root_branch",
			forkPiEntryId: "root-user",
			startedAt: "2026-04-13T10:00:04.500Z",
			workerId: "wkr_review_running",
		});
		harness.ctx.deps.turnAnnotations.create({
			instanceId: process.id,
			annotationType: "current_review_turn",
			annotationKey: "current_review_turn:trn_review_running",
			references: [{ kind: "turn_record", turnRecordId: "trn_review_running", role: "subject" }],
			payload: { status: "running" },
		});

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.turnAnnotations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ annotationKey: "current_review_turn:trn_review_running" }),
			]),
		);
	});

	it("terminates when the tree contains a cycle", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				semanticEntryRefs: {
					rootEntry: null,
					currentPrimaryPathLeaf: { entryId: "entry-a", turnRecordId: "trn_cycle" },
					plan: null,
					review: null,
				},
			}),
		});
		writeFileSync(
			path.join(harness.config.storage.tree_files_dir, `${process.id}.jsonl`),
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sess-cycle",
					timestamp: "2026-04-13T11:00:00.000Z",
					cwd: "/tmp/project",
				}),
				JSON.stringify({
					type: "message",
					id: "entry-a",
					parentId: "entry-b",
					timestamp: "2026-04-13T11:00:01.000Z",
					message: { role: "assistant", content: "A" },
				}),
				JSON.stringify({
					type: "message",
					id: "entry-b",
					parentId: "entry-a",
					timestamp: "2026-04-13T11:00:02.000Z",
					message: { role: "assistant", content: "B" },
				}),
			].join("\n")}
`,
		);

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.primaryPathEntries.map((entry: { id: string }) => entry.id)).toEqual([
			"entry-b",
			"entry-a",
		]);
	});

	it("reports no streaming state for terminal processes without workers", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: null,
			lifecycleStatus: "completed",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.turnState).toEqual({
			currentTurnRecordId: null,
			workerState: null,
			isStreaming: false,
			activeTurn: null,
		});
	});

	it("returns an empty primary path when the tree file is missing", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "primary_path_test_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});

		const response = await fetch(`${harness.address}/api/processes/${process.id}/primary-path`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.primaryPathEntries).toEqual([]);
		expect(body.currentLeaf).toBeNull();
		expect(body.labels).toEqual({});
		expect(body.turnAnnotations).toEqual([]);
		expect(body.turnState).toEqual({
			currentTurnRecordId: null,
			workerState: null,
			isStreaming: false,
			activeTurn: null,
		});
	});
});
