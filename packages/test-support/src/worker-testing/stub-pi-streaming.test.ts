import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { StubPiTreeHandleFactory as BaseStubPiTreeHandleFactory } from "./stub-pi-tree-handle.js";

const handles = new Set<
	Awaited<ReturnType<BaseStubPiTreeHandleFactory["createPrimaryTreeHandle"]>>
>();
const releaseGates: Array<() => void> = [];

class StubPiTreeHandleFactory extends BaseStubPiTreeHandleFactory {
	override async createPrimaryTreeHandle(
		options: Parameters<BaseStubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
	) {
		const handle = await super.createPrimaryTreeHandle(options);
		handles.add(handle);
		const close = handle.close.bind(handle);
		handle.close = async () => {
			await close();
			handles.delete(handle);
		};
		return handle;
	}
}

async function cleanup(root: string): Promise<void> {
	for (const release of releaseGates.splice(0)) release();
	try {
		const results = await Promise.allSettled([...handles].map((handle) => handle.close()));
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

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
		const toolCalls: string[] = [];
		handle.subscribe((event) => {
			if (event.type === "stream.delta") deltas.push(event.data);
			if (event.type === "tool.call") toolCalls.push(String(event.data.toolCallId));
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
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).not.toBe("");
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
						toolCallId: toolCalls[0],
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
		expect(next.resultEntryId).not.toBe(result.resultEntryId);
		expect(resumed.getLeafId()).toBe(next.resultEntryId);
		expect(resumed.getBranch().map((entry) => entry.id)).toContain(result.resultEntryId);
		await resumed.close();
	} finally {
		await cleanup(root);
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
		const next = await handle.prompt("Next turn");
		expect(next.startLeafId).toBe(entry.id);
		expect(next.resultEntryId).not.toBe(entry.id);
		expect(handle.getLeafId()).toBe(next.resultEntryId);
		await handle.close();
		expect(SessionManager.open(treeFile).getEntry(entry.id)).toEqual(entry);
		expect((await readFile(treeFile, "utf8")).split("\n").length).toBeGreaterThan(2);
	} finally {
		await cleanup(root);
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
		await cleanup(root);
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
		const toolCalls: string[] = [];
		handle.subscribe((event) => {
			if (event.type === "tool.call") toolCalls.push(String(event.data.toolCallId));
		});
		let executedToolCallId: string | undefined;
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
						executedToolCallId = context?.toolCallId;
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
		expect(toolCalls).toHaveLength(1);
		expect(executedToolCallId).toBeTruthy();
		expect(executedToolCallId).toBe(toolCalls[0]);
		await handle.close();
	} finally {
		await cleanup(root);
	}
});

it.each([
	false,
	true,
])("returns streamed-only output once with trace recording=%s", async (recordSessionTrace) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-stream-only-test-"));
	try {
		const treeFile = path.join(root, "tree.jsonl");
		const handle = await new StubPiTreeHandleFactory({
			recordSessionTrace,
			toolCallScriptResolver: () => ({ calls: [], textChunks: ["Scripted ", "answer"] }),
		}).createPrimaryTreeHandle({ treeFile, workspaceRoot: root, resume: false });
		const chunks: string[] = [];
		handle.subscribe((event) => {
			if (event.type === "stream.delta") chunks.push(String(event.data.text));
		});
		const result = await handle.prompt("Do not echo this prompt");
		expect(chunks).toEqual(["Scripted ", "answer"]);
		expect(result.assistantMarkdown).toBe("Scripted answer");
		const assistantText = handle
			.getBranch()
			.flatMap((entry) => {
				const message = entry.message as
					| { role?: string; content?: string | Array<{ type: string; text?: string }> }
					| undefined;
				if (message?.role !== "assistant") return [];
				return typeof message.content === "string"
					? [message.content]
					: (message.content ?? [])
							.filter((block) => block.type === "text")
							.map((block) => block.text ?? "");
			})
			.join("");
		expect(assistantText).toBe("Scripted answer");
		expect(handle.getLeafId()).toBe(result.resultEntryId);
		await handle.close();
	} finally {
		await cleanup(root);
	}
});

it.each([
	"abort",
	"close",
] as const)("rejects when %s is requested on the final streamed chunk", async (operation) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-final-chunk-test-"));
	try {
		const handle = await new StubPiTreeHandleFactory({
			recordSessionTrace: true,
			toolCallScriptResolver: () => ({ calls: [], textChunks: ["Final chunk"], chunkDelayMs: 1 }),
		}).createPrimaryTreeHandle({
			treeFile: path.join(root, "tree.jsonl"),
			workspaceRoot: root,
			resume: false,
		});
		const events: string[] = [];
		let startedTurnId: string | undefined;
		let stopped: Promise<void> | undefined;
		handle.subscribe((event) => {
			events.push(event.type);
			if (event.type === "turn.start") startedTurnId = event.turnId;
			if (event.type === "stream.delta")
				stopped = operation === "abort" ? handle.abortTurn() : handle.close();
		});
		await expect(handle.prompt("Input")).rejects.toThrow(
			operation === "abort" ? "aborted" : "closed",
		);
		await stopped;
		expect(events).not.toContain("turn.end");
		const manager = SessionManager.open(path.join(root, "tree.jsonl"));
		if (!startedTurnId) throw new Error("Missing turn.start event");
		expect(manager.getEntry(startedTurnId)).toBeUndefined();
		expect(manager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({ content: [{ type: "text", text: "Final chunk" }] }),
				}),
			]),
		);
		if (operation === "abort") await handle.close();
	} finally {
		await cleanup(root);
	}
});

it("rejects a cancelled turn after its asynchronous resolver returns", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-resolver-cancel-test-"));
	try {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		releaseGates.push(release);
		const handle = await new StubPiTreeHandleFactory({
			async toolCallScriptResolver() {
				entered();
				await pending;
				return { calls: [] };
			},
		}).createPrimaryTreeHandle({
			treeFile: path.join(root, "tree"),
			workspaceRoot: root,
			resume: false,
		});
		const events: string[] = [];
		let startedTurnId: string | undefined;
		handle.subscribe((event) => {
			events.push(event.type);
			if (event.type === "turn.start") startedTurnId = event.turnId;
		});
		const turn = handle.prompt("Input");
		const rejected = expect(turn).rejects.toThrow("aborted");
		await started;
		await handle.abortTurn();
		release();
		await rejected;
		expect(events).toEqual(["turn.start"]);
		if (!startedTurnId) throw new Error("Missing turn.start event");
		expect(handle.getEntry(startedTurnId)).toBeUndefined();
		await handle.close();
	} finally {
		await cleanup(root);
	}
});
