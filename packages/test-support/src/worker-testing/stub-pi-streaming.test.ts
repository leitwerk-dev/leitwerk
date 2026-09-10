import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StubPiTreeHandleFactory } from "./stub-pi-tree-handle.js";

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
