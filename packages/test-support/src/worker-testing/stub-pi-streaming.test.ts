import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { StubPiTreeHandleFactory } from "./stub-pi-tree-handle.js";

it("records SDK-readable input, reasoning and tool results across fresh factories", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-trace-test-"));
	try {
		const factoryOptions = {
			recordSessionTrace: true,
			toolCallScriptResolver: () => ({
				thinkingChunks: ["Inspect the notebook.\n", "Keep the update focused.\n"],
				textChunks: ["Preparing the update.\n"],
				calls: [{ toolName: "save", args: { text: "Weekly review" } }],
			}),
		};
		const options = {
			instanceId: "trace-process",
			workspaceRoot: root,
			treeFile: path.join(root, "tree.jsonl"),
			resume: false,
		};
		const handle = await new StubPiTreeHandleFactory(factoryOptions).createPrimaryTreeHandle(
			options,
		);
		const deltas: unknown[] = [];
		handle.subscribe((event) => {
			if (event.type === "stream.delta") deltas.push(event.data);
		});
		const result = await handle.promptCustom(
			{
				content: "Update the notebook",
				details: { kind: "turn_prompt", startRecordId: "start-1" },
			},
			{
				tools: [
					{
						name: "save",
						description: "Save",
						parameters: {},
						async execute() {
							return "Saved the weekly review";
						},
					},
				],
			},
		);
		await handle.close();
		expect(deltas).toEqual([
			{ streamType: "thinking", text: "Inspect the notebook.\n" },
			{ streamType: "thinking", text: "Keep the update focused.\n" },
			{ streamType: "text", text: "Preparing the update.\n" },
		]);
		const manager = SessionManager.open(options.treeFile);
		expect(manager.getLeafId()).toBe(result.resultEntryId);
		expect(manager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom_message", content: "Update the notebook" }),
				expect.objectContaining({
					message: expect.objectContaining({
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Inspect the notebook.\nKeep the update focused.\n" },
							{ type: "text", text: "Preparing the update.\n" },
						],
					}),
				}),
				expect.objectContaining({
					message: expect.objectContaining({
						role: "toolResult",
						toolCallId: "tool-2",
						content: [{ type: "text", text: "Saved the weekly review" }],
						isError: false,
					}),
				}),
			]),
		);
		const resumed = await new StubPiTreeHandleFactory({
			recordSessionTrace: true,
		}).createPrimaryTreeHandle({ ...options, resume: true });
		expect(resumed.getBranch()).toHaveLength(manager.getEntries().length);
		const next = await resumed.prompt("Follow up");
		expect(next.startLeafId).toBe(result.resultEntryId);
		expect(next.resultEntryId).toBe("turn-3");
		await resumed.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("retains legacy stub sessions when enabling trace recording", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-legacy-test-"));
	try {
		const treeFile = path.join(root, "tree.jsonl");
		const entry = {
			id: "turn-7",
			parentId: null,
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "assistant", content: "Existing result" },
		};
		await writeFile(
			treeFile,
			JSON.stringify({
				turnSeq: 7,
				currentLeafId: entry.id,
				entries: [entry],
				childIdsByParent: [{ parentId: null, childIds: [entry.id] }],
			}),
		);
		const handle = await new StubPiTreeHandleFactory({
			recordSessionTrace: true,
		}).createPrimaryTreeHandle({ treeFile, workspaceRoot: root, resume: true });
		expect(handle.getEntry(entry.id)).toEqual(entry);
		expect((await handle.prompt("Next turn")).resultEntryId).toBe("turn-8");
		await handle.close();
		expect(SessionManager.open(treeFile).getEntry(entry.id)).toEqual(entry);
		expect((await readFile(treeFile, "utf8")).split("\n").length).toBeGreaterThan(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("correlates asynchronous scripts to their process and resumes persisted sequence state", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-script-test-"));
	try {
		const contexts: Array<{ instanceId?: string; turnSequence: number }> = [];
		const factory = new StubPiTreeHandleFactory({
			async toolCallScriptResolver(context) {
				contexts.push(context);
				return {
					calls: [{ toolName: "markdown_result", args: { markdown: "A result" } }],
					textChunks: ["A ", "result"],
					chunkDelayMs: 1,
				};
			},
		});
		const options = {
			instanceId: "process-a",
			workspaceRoot: root,
			sessionCwd: root,
			treeFile: path.join(root, "tree"),
			resume: false,
		};
		const handle = await factory.createPrimaryTreeHandle(options);
		const chunks: string[] = [];
		handle.subscribe((event) => {
			if (event.type === "stream.delta") chunks.push(String(event.data.text));
		});
		await handle.prompt("Ignored wording");
		expect(chunks).toEqual(["A ", "result"]);
		await handle.close();
		const resumed = await factory.createPrimaryTreeHandle({ ...options, resume: true });
		await resumed.prompt("Different wording");
		expect(contexts.map((c) => [c.instanceId, c.turnSequence])).toEqual([
			["process-a", 1],
			["process-a", 2],
		]);
		await resumed.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("aborts an interactive tool using its correlated call context", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-script-test-"));
	try {
		const factory = new StubPiTreeHandleFactory({
			toolCallScriptResolver: () => ({ toolName: "question", args: {} }),
		});
		const handle = await factory.createPrimaryTreeHandle({
			instanceId: "process-b",
			workspaceRoot: root,
			treeFile: path.join(root, "tree"),
			resume: false,
		});
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const turn = handle.prompt("Ask", {
			tools: [
				{
					name: "question",
					description: "Wait for input",
					parameters: {},
					async execute(_args, context) {
						expect(context?.toolCallId).toBe("tool-1");
						if (!context) throw new Error("Missing context");
						return new Promise((_resolve, reject) => {
							context.signal.addEventListener("abort", () => reject(context.signal.reason), {
								once: true,
							});
							started();
						});
					},
				},
			],
		});
		const outcome = expect(turn).rejects.toThrow("aborted");
		await entered;
		await handle.abortTurn();
		await outcome;
		await handle.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
