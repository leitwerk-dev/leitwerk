import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	type Codec,
	createEmptyStructuralProcessState,
	defineProcess,
	type ExtensionProcessDefinition,
	type LeafOutcomeCaptureResult,
	type LeitwerkExtensionModule,
	llmTurn,
	type ProcessLeafOutcomeDefinition,
	REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { captureLeafOutcomeSnapshot } from "./leaf-outcome-snapshot-capture.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createFilesystemSessionReader } from "./process-session-store.js";
import { buildProcessUiRegistry } from "./process-ui-registry.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const tempDirs: string[] = [];

const simpleParamsCodec: Codec<{ prompt: string }> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const structuralStateCodec: Codec<StructuralProcessState> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		const structural = createEmptyStructuralProcessState();
		return {
			...structural,
			...(record as StructuralProcessState),
		};
	},
	serialize(value) {
		return value;
	},
};

function createCaptureTurn(turnId: string) {
	return llmTurn<{ prompt: string }, StructuralProcessState, "completed">({
		description: "Capture the selected leaf outcome",
		availableTools: [],
		completionMode: "turn_end",
		branchType: "primary",
		context: "fresh",
		prompt: async () => turnId,
		outcomes: {},
		turnEnd: {
			outcome: "completed",
			params: {},
			complete: true,
		},
		turnResultMarkdown: REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
		resultSemanticRef: "plan",
	});
}

function createProcessDefinition(
	processId: string,
	rendererId: string,
	turnId: string,
	capture: ProcessLeafOutcomeDefinition<{ prompt: string }, StructuralProcessState>["capture"],
): ExtensionProcessDefinition<{ prompt: string }, StructuralProcessState> {
	const captureTurn = createCaptureTurn(turnId);
	return defineProcess({
		id: processId,
		displayName: processId,
		entry: turnId,
		turns: { [turnId]: captureTurn },
		paramsCodec: simpleParamsCodec,
		stateCodec: structuralStateCodec,
		initialState() {
			return createEmptyStructuralProcessState();
		},
		worker(api) {
			api.start(turnId);
		},
		ui(api) {
			api.leafOutcome({
				rendererId,
				capture,
			});
		},
	});
}

async function createRegistries(processDef: ExtensionProcessDefinition) {
	const module: LeitwerkExtensionModule = {
		manifest: { id: `${processDef.id}-test`, version: "0.1.0" },
		setupCatalog(api) {
			api.registerProcess(processDef);
		},
	};
	const catalog = await buildExtensionCatalogFromModules([module]);
	return {
		processActionRegistry: buildProcessActionRegistry(catalog),
		processUiRegistry: buildProcessUiRegistry(catalog),
	};
}

function baseStateJson(rootEntryId: string): string {
	return JSON.stringify({
		...createEmptyStructuralProcessState(),
		semanticEntryRefs: {
			rootEntry: { entryId: rootEntryId, turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: rootEntryId, turnRecordId: null },
			plan: null,
			review: null,
		},
	});
}

function writeTreeFile(instanceId: string, entries: readonly Record<string, unknown>[]): string {
	const treeFilesDir = mkdtempSync(path.join(tmpdir(), "leaf-outcome-capture-"));
	tempDirs.push(treeFilesDir);
	const sessionEntries = [
		{
			type: "session",
			version: 3,
			id: `${instanceId}-session`,
			timestamp: "2026-04-18T00:00:00.000Z",
			cwd: process.cwd(),
		},
		...entries,
	];
	writeFileSync(
		path.join(treeFilesDir, `${instanceId}.jsonl`),
		`${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
	return treeFilesDir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("captureLeafOutcomeSnapshot", () => {
	it("returns null when capture opts out of creating a snapshot", async () => {
		const deps = createTestDeps();
		const turnId = "capture_skip_turn";
		const processDef = createProcessDefinition(
			"skip_capture_process",
			"test:skip_capture_process.leaf_outcome",
			turnId,
			() => null,
		);
		const { processActionRegistry, processUiRegistry } = await createRegistries(processDef);
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: turnId,
			lifecycleStatus: "active",
			paramsJson: JSON.stringify({ prompt: "Skip the capture" }),
			stateJson: baseStateJson("root-user"),
		});
		const turnRecord = deps.turnRecords.create({
			id: "trn_skip_capture",
			instanceId: process.id,
			turnId: "capture_leaf",
			status: "succeeded",
			pathType: "primary",
			resultPiEntryId: "assistant-leaf",
			turnResultMarkdown: "## Turn result",
			endedAt: "2026-04-18T11:00:02.000Z",
		});
		const treeFilesDir = writeTreeFile(process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T11:00:00.000Z",
			},
			{
				id: "assistant-leaf",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T11:00:01.000Z",
				message: { role: "assistant", content: "## Tree leaf" },
			},
		]);

		const snapshot = await captureLeafOutcomeSnapshot({
			process,
			projects: [],
			processActionRegistry,
			processUiRegistry,
			turnRecords: deps.turnRecords,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
			leaf: {
				entryId: "assistant-leaf",
				turnRecordId: turnRecord.id,
			},
			turnRecord,
			anchoredAt: "2026-04-18T11:00:02.000Z",
		});

		expect(snapshot).toBeNull();
	});

	it("returns invalid_capture_result when the capture payload does not validate", async () => {
		const deps = createTestDeps();
		const turnId = "capture_invalid_turn";
		const processDef = createProcessDefinition(
			"invalid_capture_process",
			"test:invalid_capture_process.leaf_outcome",
			turnId,
			() =>
				({
					rendererId: "test:wrong_renderer",
					props: [] as unknown as Record<string, unknown>,
					fallbackMarkdown: "## Partial snapshot",
				}) as LeafOutcomeCaptureResult,
		);
		const { processActionRegistry, processUiRegistry } = await createRegistries(processDef);
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: turnId,
			lifecycleStatus: "active",
			paramsJson: JSON.stringify({ prompt: "Validate the capture result" }),
			stateJson: baseStateJson("root-user"),
		});
		const turnRecord = deps.turnRecords.create({
			id: "trn_invalid_capture",
			instanceId: process.id,
			turnId: "capture_leaf",
			status: "succeeded",
			pathType: "primary",
			resultPiEntryId: "assistant-leaf",
			turnResultMarkdown: "## Turn result",
			endedAt: "2026-04-18T11:00:02.000Z",
		});
		const treeFilesDir = writeTreeFile(process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T11:00:00.000Z",
			},
			{
				id: "assistant-leaf",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T11:00:01.000Z",
				message: { role: "assistant", content: "## Tree leaf" },
			},
		]);

		const snapshot = await captureLeafOutcomeSnapshot({
			process,
			projects: [],
			processActionRegistry,
			processUiRegistry,
			turnRecords: deps.turnRecords,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
			leaf: {
				entryId: "assistant-leaf",
				turnRecordId: turnRecord.id,
			},
			turnRecord,
			anchoredAt: "2026-04-18T11:00:02.000Z",
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				instanceId: process.id,
				leafEntryId: "assistant-leaf",
				turnRecordId: turnRecord.id,
				rendererId: "test:invalid_capture_process.leaf_outcome",
				status: "capture_error",
				warningCode: "invalid_capture_result",
				fallbackMarkdown: "## Partial snapshot",
			}),
		);
		expect(snapshot?.warningMessage).toContain(
			"must match 'test:invalid_capture_process.leaf_outcome'",
		);
		expect(snapshot?.warningMessage).toContain("props must be an object");
	});

	it("invokes capture even when the selected leaf entry is missing", async () => {
		const deps = createTestDeps();
		let captureCalls = 0;
		const turnId = "capture_missing_leaf_turn";
		const processDef = createProcessDefinition(
			"missing_leaf_process",
			"test:missing_leaf_process.leaf_outcome",
			turnId,
			(ctx) => {
				captureCalls += 1;
				return {
					rendererId: "test:missing_leaf_process.leaf_outcome",
					props: {
						ok: true,
						hasLeafEntry: ctx.readLeafEntry() !== null,
						rootEntryId: ctx.readTreeEntry("root-user")?.id ?? null,
					},
					fallbackMarkdown: "## Captured without the missing leaf entry",
				};
			},
		);
		const { processActionRegistry, processUiRegistry } = await createRegistries(processDef);
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: turnId,
			lifecycleStatus: "active",
			paramsJson: JSON.stringify({ prompt: "Missing leaf" }),
			stateJson: baseStateJson("root-user"),
		});
		const treeFilesDir = writeTreeFile(process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T11:10:00.000Z",
			},
		]);

		const snapshot = await captureLeafOutcomeSnapshot({
			process,
			projects: [],
			processActionRegistry,
			processUiRegistry,
			turnRecords: deps.turnRecords,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
			leaf: {
				entryId: "missing-leaf-entry",
				turnRecordId: null,
			},
			turnRecord: null,
			anchoredAt: "2026-04-18T11:10:02.000Z",
		});

		expect(captureCalls).toBe(1);
		expect(snapshot).toEqual(
			expect.objectContaining({
				instanceId: process.id,
				leafEntryId: "missing-leaf-entry",
				turnRecordId: null,
				rendererId: "test:missing_leaf_process.leaf_outcome",
				status: "ready",
				fallbackMarkdown: "## Captured without the missing leaf entry",
				props: {
					ok: true,
					hasLeafEntry: false,
					rootEntryId: "root-user",
				},
			}),
		);
	});
});
