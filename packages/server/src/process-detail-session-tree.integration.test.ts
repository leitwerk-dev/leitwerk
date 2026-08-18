import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	defineProcess,
	emptyParamsCodec,
	humanTurn,
	type LeitwerkExtensionModule,
	llmTurn,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createStructuralProcessState,
	createStructuralStateJson,
	structuralProcessStateCodec,
} from "./test-helpers/structural-process-fixtures.js";

const detailProcess = defineProcess<Record<string, never>, StructuralProcessState>({
	id: "process_detail_session_tree_test",
	displayName: "Process Detail Session Tree Test",
	entry: "detail",
	turns: {
		detail: humanTurn({
			description: "Detail",
			actions: { noop: { label: "No-op", acceptanceState: "accepted", complete: true } },
		}),
		implement: llmTurn({
			description: "Implement",
			branchType: "primary",
			context: "fresh",
			availableTools: [],
			prompt: async () => "Implement",
			turnEnd: { outcome: "done", params: {}, complete: true },
		}),
	},
	paramsCodec: emptyParamsCodec,
	stateCodec: structuralProcessStateCodec,
	initialState() {
		return createStructuralProcessState();
	},
	launchers(api) {
		api.launcher({
			id: "process_detail_session_tree_test.ui",
			label: "Session Tree Launcher",
			description: "Launch the process detail session tree test",
			visibility: "ui",
			ui: {
				card: { title: "Session Tree Card" },
				launchConfigSchema: { id: "session-tree", title: "Session Tree", fields: [] },
				resolveLaunchConfig: () => ({
					ok: true,
					launchConfig: { processId: "process_detail_session_tree_test", params: {} },
				}),
			},
		});
	},
});

const detailExtension: LeitwerkExtensionModule = {
	manifest: { id: "process-detail-session-tree-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(detailProcess);
	},
};

let harness: IntegrationHarness;
let tempRoot = "";

type TestBrowseItem = Record<string, unknown> & {
	id?: string;
	instanceId?: string;
	initialPromptPreview?: string;
};

function browseItems(body: { items: Array<{ kind: string; item: TestBrowseItem }> }, kind: string) {
	return body.items.flatMap((entry) => (entry.kind === kind ? [entry.item] : []));
}

function createAcceptedLlmTurnRecord(input: {
	instanceId: string;
	id: string;
	turnId: string;
	status: "running" | "succeeded" | "failed";
	current?: boolean;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	startedAt: string;
	endedAt?: string;
	turnResultMarkdown?: string;
	errorSummary?: string;
}) {
	const lease = harness.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_${input.id}`,
		state: input.current ? (input.status === "failed" ? "failed" : "busy") : "exited",
	});
	if (!input.current) {
		harness.ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt,
		});
	}
	const start = harness.ctx.deps.turnStarts.create({
		id: `tsr_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.id,
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
			turnRecordId: input.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const record = harness.ctx.deps.turnRecords.create({
		id: input.id,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: input.status,
		pathType: "primary",
		forkPiEntryId: input.forkPiEntryId ?? null,
		startedAt: input.startedAt,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
		...(input.resultPiEntryId !== undefined ? { resultPiEntryId: input.resultPiEntryId } : {}),
		...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
		...(input.turnResultMarkdown !== undefined
			? { turnResultMarkdown: input.turnResultMarkdown }
			: {}),
		...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {}),
	});
	if (input.current) {
		harness.ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	}
	return record;
}

beforeAll(async () => {
	tempRoot = await mkdtemp(path.join(tmpdir(), "leitwerk-process-detail-session-tree-"));
	harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([detailExtension]),
		inProcessWorkers: false,
		configOverride(config) {
			config.storage.tree_files_dir = path.join(tempRoot, "trees");
			config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
		},
	});
});

afterAll(async () => {
	await harness.ctx.app.close();
	await rm(tempRoot, { recursive: true, force: true });
});

describe("process detail HTTP route", () => {
	it("includes a redacted conversation tree in the process UI snapshot", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			stateJson: createStructuralStateJson(),
		});
		await mkdir(harness.config.storage.tree_files_dir, { recursive: true });
		await writeFile(
			path.join(harness.config.storage.tree_files_dir, `${process.id}.jsonl`),
			[
				{ type: "session", version: 3, id: "session", timestamp: "0", cwd: "/tmp" },
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "1",
					message: { role: "user", content: "private" },
				},
				{
					type: "message",
					id: "b",
					parentId: "a",
					timestamp: "2",
					message: { role: "assistant", content: "secret" },
				},
				{
					type: "message",
					id: "c",
					parentId: "a",
					timestamp: "3",
					message: { role: "toolResult", toolName: "read", content: "hidden" },
				},
				{
					type: "label",
					id: "label",
					parentId: "b",
					timestamp: "4",
					targetId: "b",
					label: "review",
				},
				{
					type: "custom",
					id: "orphan",
					parentId: "missing",
					timestamp: "5",
					customType: "private-diagnostic",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		createAcceptedLlmTurnRecord({
			instanceId: process.id,
			id: "turn-plan",
			turnId: "plan",
			status: "succeeded",
			startedAt: "2025-01-01T00:00:00.000Z",
			endedAt: "2025-01-01T00:01:00.000Z",
			resultPiEntryId: "b",
			turnResultMarkdown: "private turn result",
		});
		createAcceptedLlmTurnRecord({
			instanceId: process.id,
			id: "turn-implement",
			turnId: "implement",
			status: "running",
			startedAt: "2025-01-01T00:02:00.000Z",
			forkPiEntryId: "b",
		});

		const response = await fetch(`${harness.address}/api/processes/${process.id}/ui-snapshot`);
		expect(response.status).toBe(200);
		const { instanceTree } = await response.json();
		expect(instanceTree).toMatchObject({ currentLeafId: "turn-implement" });
		expect(instanceTree.nodes).toEqual([
			expect.objectContaining({
				id: "turn-plan",
				parentId: null,
				resultState: "succeeded",
			}),
			expect.objectContaining({
				id: "turn-implement",
				parentId: "turn-plan",
				resultState: "pending",
			}),
		]);
		expect(JSON.stringify(instanceTree)).not.toMatch(/private|secret|hidden|diagnostic|toolResult/);
	});

	it("bounds the sidebar overview and exposes paginated server-side browse/search", async () => {
		const created = Array.from({ length: 105 }, (_, index) =>
			harness.ctx.deps.processes.create({
				processId: "process_detail_session_tree_test",
				lifecycleStatus: "active",
				selectedTurnId: "implement",
				title: `Globally sorted ${String(104 - index).padStart(3, "0")}`,
				paramsJson: JSON.stringify({ prompt: `bounded-overview-${index}` }),
				stateJson: createStructuralStateJson(),
			}),
		);
		const scheduledAction = harness.ctx.deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: "process_detail_session_tree_test",
			instanceId: created[0]?.id,
			actionId: "retry",
			payloadJson: "{}",
			nextRunAt: "2026-12-01T00:00:00.000Z",
		});
		const projectBatchSpy = vi.spyOn(harness.ctx.deps.projects, "listByInstances");
		const projectNPlusOneSpy = vi.spyOn(harness.ctx.deps.projects, "listByInstance");
		const processWindowSpy = vi.spyOn(harness.ctx.deps.processes, "listOverviewWindow");

		const overviewResponse = await fetch(`${harness.address}/api/processes/overview`);
		const overview = await overviewResponse.json();
		expect(overviewResponse.status).toBe(200);
		expect(overview.processes).toHaveLength(100);
		expect(overview.futureExecutions).toEqual([]);
		expect(overview.truncated).toBe(true);
		expect(projectBatchSpy).toHaveBeenCalledTimes(1);
		expect(projectNPlusOneSpy).not.toHaveBeenCalled();

		const browseResponse = await fetch(
			`${harness.address}/api/processes/browse?limit=20&query=bounded-overview-104`,
		);
		const browse = await browseResponse.json();
		expect(browseResponse.status).toBe(200);
		expect(browseItems(browse, "process").map((item) => item.instanceId)).toEqual([
			created[104]?.id,
		]);
		expect(browse.pagination).toMatchObject({
			limit: 20,
			offset: 0,
			total: 1,
			processTotal: 1,
			futureExecutionTotal: 0,
			hasMore: false,
		});
		expect(browseItems(browse, "future")).toEqual([]);

		const sortedFirstPage = await (
			await fetch(
				`${harness.address}/api/processes/browse?limit=5&query=bounded-overview&sortKey=title&sortDirection=asc`,
			)
		).json();
		const sortedLastPage = await (
			await fetch(
				`${harness.address}/api/processes/browse?limit=5&offset=100&query=bounded-overview&sortKey=title&sortDirection=asc`,
			)
		).json();
		expect(browseItems(sortedFirstPage, "process").map((item) => item.instanceId)).toEqual(
			created
				.slice(100)
				.reverse()
				.map((process) => process.id),
		);
		expect(browseItems(sortedLastPage, "process").map((item) => item.instanceId)).toEqual(
			created
				.slice(0, 5)
				.reverse()
				.map((process) => process.id),
		);
		expect(sortedLastPage.pagination).toMatchObject({ offset: 100, total: 105, hasMore: false });
		expect(processWindowSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 5,
				sortKey: "title",
				sortDirection: "asc",
			}),
		);
		const firstPageIds = new Set(
			browseItems(sortedFirstPage, "process").map((item) => item.instanceId),
		);
		expect(
			projectBatchSpy.mock.calls.some(
				([instanceIds]) =>
					instanceIds.length === 5 && instanceIds.every((id) => firstPageIds.has(id)),
			),
		).toBe(true);

		const externalIdFallback = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			externalId: "VISIBLE-EXTERNAL-FALLBACK",
			stateJson: createStructuralStateJson(),
		});
		const instanceIdFallback = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			stateJson: createStructuralStateJson(),
		});
		for (const [visibleFallback, expectedId] of [
			["VISIBLE-EXTERNAL-FALLBACK", externalIdFallback.id],
			[instanceIdFallback.id, instanceIdFallback.id],
		]) {
			const response = await (
				await fetch(`${harness.address}/api/processes/browse?query=${visibleFallback}`)
			).json();
			expect(browseItems(response, "process").map((item) => item.instanceId)).toEqual([expectedId]);
		}

		const scheduledLaunch = harness.ctx.deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "process_detail_session_tree_test",
			launcherId: "process_detail_session_tree_test.ui",
			payloadJson: serializeFutureLaunchPayload({
				launcherInput: { instructions: "CrossSourceNeedle" },
				modelConfig: {},
				launchPlan: {
					launcherId: "process_detail_session_tree_test.ui",
					processId: "process_detail_session_tree_test",
					processInput: {
						processId: "process_detail_session_tree_test",
						selectedTurnId: "detail",
						lifecycleStatus: "waiting",
						paramsJson: "{}",
						stateJson: createStructuralStateJson(),
					},
					projectInputs: [],
					startTurnId: null,
				},
			}),
			nextRunAt: "2026-12-02T00:00:00.000Z",
		});
		for (const launcherSearch of [
			"Session Tree Launcher",
			"Session Tree Card",
			"Session CrossSourceNeedle",
		]) {
			const response = await (
				await fetch(
					`${harness.address}/api/processes/browse?query=${encodeURIComponent(launcherSearch)}`,
				)
			).json();
			expect(browseItems(response, "future").map((item) => item.id)).toEqual([scheduledLaunch.id]);
		}

		projectBatchSpy.mockRestore();
		projectNPlusOneSpy.mockRestore();
		processWindowSpy.mockRestore();
		harness.ctx.deps.futureExecutions.delete(scheduledAction.id);
		harness.ctx.deps.futureExecutions.delete(scheduledLaunch.id);
		harness.ctx.deps.processes.delete(externalIdFallback.id);
		harness.ctx.deps.processes.delete(instanceIdFallback.id);
		for (const process of created) {
			harness.ctx.deps.processes.delete(process.id);
		}
	});

	it("returns raw Pi session entries without rewriting the JSONL tree file", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			lifecycleStatus: "completed",
			selectedTurnId: null,
			currentExecution: null,
			stateJson: createStructuralStateJson(),
		});

		await mkdir(harness.config.storage.tree_files_dir, { recursive: true });
		const treeFile = path.join(harness.config.storage.tree_files_dir, `${process.id}.jsonl`);
		const treeContent = `${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "sess_1",
				timestamp: "2026-04-22T10:00:00.000Z",
				cwd: "/tmp/project",
			}),
			JSON.stringify({
				type: "message",
				id: "root-user",
				parentId: null,
				timestamp: "2026-04-22T10:00:01.000Z",
				message: {
					role: "user",
					content: "Ship the requested change",
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-plan",
				parentId: "root-user",
				timestamp: "2026-04-22T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Need to inspect the repo.\n" },
						{ type: "toolCall", id: "tool_1", name: "read", arguments: { path: "README.md" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "tool-result-1",
				parentId: "assistant-plan",
				timestamp: "2026-04-22T10:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool_1",
					toolName: "read",
					content: [{ type: "text", text: "README contents" }],
					details: { path: "README.md", bytes: 128 },
					isError: false,
					timestamp: 3,
				},
			}),
			JSON.stringify({
				type: "label",
				id: "label-1",
				parentId: "tool-result-1",
				timestamp: "2026-04-22T10:00:04.000Z",
				targetId: "assistant-plan",
				label: "latest-plan",
			}),
		].join("\n")}\n`;
		await writeFile(treeFile, treeContent, "utf8");
		const before = await readFile(treeFile, "utf8");

		const response = await fetch(`${harness.address}/api/processes/${process.id}`);
		expect(response.status).toBe(200);
		const body = await response.json();

		expect(body.piSessionEntries).toEqual([
			expect.objectContaining({
				type: "message",
				id: "root-user",
				parentId: null,
			}),
			expect.objectContaining({
				type: "message",
				id: "assistant-plan",
				parentId: "root-user",
			}),
			expect.objectContaining({
				type: "message",
				id: "tool-result-1",
				parentId: "assistant-plan",
			}),
			expect.objectContaining({
				type: "label",
				id: "label-1",
				targetId: "assistant-plan",
				label: "latest-plan",
			}),
		]);

		const after = await readFile(treeFile, "utf8");
		expect(after).toBe(before);
	});

	it("serves a compact UI snapshot and lazy full reasoning details", async () => {
		const largeState = "state-payload".repeat(2_000);
		const largePrompt = "Please implement the compact snapshot route. ".repeat(200);
		const privateOutcomePayload = `private-outcome-${"x".repeat(500_000)}`;
		const process = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			lifecycleStatus: "completed",
			selectedTurnId: null,
			currentExecution: null,
			paramsJson: JSON.stringify({ initialPrompt: largePrompt }),
			stateJson: JSON.stringify({ largeState }),
			metadata: { privatePayload: largeState },
		});
		const turnRecord = createAcceptedLlmTurnRecord({
			id: "trn_compact_snapshot",
			instanceId: process.id,
			turnId: "implement",
			status: "succeeded",
			forkPiEntryId: null,
			resultPiEntryId: "tool-result-1",
			startedAt: "2026-04-22T10:00:00.000Z",
			endedAt: "2026-04-22T10:00:03.000Z",
			turnResultMarkdown: "Done",
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "turn_outcome_recorded",
			data: {
				turnRecordId: turnRecord.id,
				turnId: "implement",
				outcome: "done",
				params: { summary: "Implementation complete", privateOutcomePayload },
			},
		});

		await mkdir(harness.config.storage.tree_files_dir, { recursive: true });
		const treeFile = path.join(harness.config.storage.tree_files_dir, `${process.id}.jsonl`);
		const fullThinking = "Need a compact render model. ".repeat(80);
		const fullAssistantText = "Implemented the compact UI snapshot. ".repeat(80);
		await writeFile(
			treeFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sess_1",
					timestamp: "2026-04-22T10:00:00.000Z",
					cwd: "/tmp/project",
				}),
				JSON.stringify({
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp: "2026-04-22T10:00:01.000Z",
					message: { role: "user", content: largePrompt, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "assistant-result",
					parentId: "root-user",
					timestamp: "2026-04-22T10:00:02.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: fullThinking },
							{ type: "toolCall", id: "tool_1", name: "read", arguments: { path: "README.md" } },
							{ type: "text", text: fullAssistantText },
						],
						usage: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 125 },
						timestamp: 2,
					},
				}),
				JSON.stringify({
					type: "message",
					id: "tool-result-1",
					parentId: "assistant-result",
					timestamp: "2026-04-22T10:00:03.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tool_1",
						toolName: "read",
						content: [{ type: "text", text: "README contents" }],
						details: {
							path: "README.md",
							bytes: 128,
							fullOutputPath: "/private/workspaces/agt_secret/read-output.txt",
							extensionMetadata: { secret: "diagnostic-only-value" },
						},
						isError: false,
						timestamp: 3,
					},
				}),
			].join("\n")}\n`,
			"utf8",
		);

		const overviewResponse = await fetch(
			`${harness.address}/api/processes/browse?query=compact%20snapshot%20route`,
		);
		expect(overviewResponse.status).toBe(200);
		const overview = await overviewResponse.json();
		const overviewItem = browseItems(overview, "process").find(
			(item) => item.instanceId === process.id,
		);
		expect(overviewItem).toBeDefined();
		expect(overviewItem.process).toBeUndefined();
		expect(overviewItem.initialPromptPreview.length).toBeLessThan(largePrompt.length);
		expect(overviewItem).not.toHaveProperty("initialPromptSearchText");

		const readSessionTreeSpy = vi.spyOn(harness.ctx.deps.sessionReader, "readSessionTree");
		const snapshotResponse = await fetch(
			`${harness.address}/api/processes/${process.id}/ui-snapshot`,
		);
		expect(readSessionTreeSpy).toHaveBeenCalledTimes(1);
		readSessionTreeSpy.mockRestore();
		expect(snapshotResponse.status).toBe(200);
		expect(snapshotResponse.headers.get("server-timing")).toContain("ui-snapshot");
		const snapshotText = await snapshotResponse.text();
		expect(snapshotText).not.toContain(privateOutcomePayload.slice(0, 100));
		expect(snapshotText.length).toBeLessThan(privateOutcomePayload.length / 2);
		const snapshot = JSON.parse(snapshotText);
		expect(snapshot.process.paramsJson).toBeUndefined();
		expect(snapshot.process.stateJson).toBeUndefined();
		expect(snapshot.process.metadata).toBeUndefined();
		expect(snapshot.events).toBeUndefined();
		expect(snapshot.inputs).toBeUndefined();
		expect(snapshot.turnRecords).toBeUndefined();
		expect(snapshot.piSessionEntries).toBeUndefined();
		expect(snapshot.primaryPath.primaryPathEntries).toEqual([]);
		expect(snapshot.primaryPath.entryCount).toBeGreaterThan(0);
		const preview = snapshot.timeline.tracePreviewsByTurnRecordId[turnRecord.id];
		expect(preview.assistantTextPreview.length).toBeLessThan(fullAssistantText.length);
		expect(preview.thinkingPreview.length).toBeLessThan(fullThinking.length);
		expect(preview.toolCallCount).toBe(1);

		const reasoningResponse = await fetch(
			`${harness.address}/api/processes/${process.id}/turn-records/${turnRecord.id}/reasoning`,
		);
		expect(reasoningResponse.status).toBe(200);
		const reasoning = await reasoningResponse.json();
		expect(reasoning.reasoning.assistant.text.length).toBe(fullAssistantText.length);
		expect(reasoning.reasoning.assistant.thinking.length).toBe(fullThinking.length);
		expect(reasoning.reasoning.toolCalls).toHaveLength(1);
		expect(reasoning.reasoning.toolCalls[0]).toMatchObject({
			startedAt: "2026-04-22T10:00:02.000Z",
			completedAt: "2026-04-22T10:00:03.000Z",
			resultText: "README contents",
			truncated: false,
		});
		const staleReasoningResponse = await fetch(
			`${harness.address}/api/processes/${process.id}/turn-records/${turnRecord.id}/reasoning?sessionSignature=stale`,
		);
		expect(staleReasoningResponse.status).toBe(409);
		const reasoningJson = JSON.stringify(reasoning);
		expect(reasoningJson).not.toContain("/private/workspaces");
		expect(reasoningJson).not.toContain("diagnostic-only-value");
		expect(reasoningJson).not.toContain("assistant-result");
		expect(reasoningJson).not.toContain("tool-result-1");
	});

	it("keeps an older turn's correlated operational events after more than 1,000 newer events", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			lifecycleStatus: "error",
			selectedTurnId: "implement",
			stateJson: createStructuralStateJson(),
		});
		const turnRecord = createAcceptedLlmTurnRecord({
			id: "trn_older_reasoning",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			current: true,
			startedAt: "2026-04-22T12:00:00.000Z",
			endedAt: "2026-04-22T12:01:00.000Z",
		});
		harness.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "pi.retry.start",
			data: {
				turnRecordId: turnRecord.id,
				message: "Retrying the older turn",
			},
		});
		for (let index = 0; index < 1_001; index += 1) {
			harness.ctx.deps.events.create({
				instanceId: process.id,
				eventType: "pi.error",
				data: {
					turnRecordId: `trn_newer_${index}`,
					message: `Newer event ${index}`,
				},
			});
		}

		const response = await fetch(
			`${harness.address}/api/processes/${process.id}/turn-records/${turnRecord.id}/reasoning`,
		);
		expect(response.status).toBe(200);
		const detail = await response.json();
		expect(detail.reasoning.traceItems).toEqual([
			expect.objectContaining({
				kind: "operational_event",
				eventType: "pi.retry.start",
				message: "Retrying the older turn",
			}),
		]);
	});

	it("projects retry replacement state without exposing process metadata", async () => {
		const process = harness.ctx.deps.processes.create({
			processId: "process_detail_session_tree_test",
			lifecycleStatus: "active",
			selectedTurnId: "implement",
			currentExecution: null,
			stateJson: createStructuralStateJson(),
			metadata: {
				retryFromTurnRecordId: "trn_retry_failed",
				retryForkPiEntryId: "pi_before_retry",
			},
		});
		createAcceptedLlmTurnRecord({
			id: "trn_retry_failed",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			forkPiEntryId: "pi_before_retry",
			resultPiEntryId: null,
			startedAt: "2026-04-22T11:00:00.000Z",
			endedAt: "2026-04-22T11:01:00.000Z",
			errorSummary: "Provider timed out",
		});

		const response = await fetch(`${harness.address}/api/processes/${process.id}/ui-snapshot`);
		expect(response.status).toBe(200);
		const snapshot = await response.json();
		expect(snapshot.process.metadata).toBeUndefined();
		expect(snapshot.timeline.turns).toEqual([
			expect.objectContaining({
				id: "current:implement",
				turnId: "implement",
				status: "in_progress",
			}),
		]);
	});
});
