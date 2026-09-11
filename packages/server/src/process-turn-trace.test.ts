import { createReadonlyEntryTree, type PiSessionEntry } from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { parsePiSessionTreeContent, type ReadonlyPiSessionTree } from "./pi-session-tree.js";
import {
	buildCommittedTurnTrace,
	buildTurnTraceFromSession,
	buildTurnTracePreview,
	buildTurnTracePreviewsFromSession,
} from "./process-turn-trace.js";

function jsonl(...entries: readonly Record<string, unknown>[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("process turn trace projection", () => {
	it("recovers recorded activity while preserving session prompt, usage, and diagnostic order", () => {
		const trace = buildCommittedTurnTrace({
			tree: parsePiSessionTreeContent(
				"trace-test",
				jsonl(
					{
						type: "message",
						id: "prompt",
						parentId: null,
						timestamp: "2026-01-01T00:00:01Z",
						message: { role: "user", content: "Keep the prompt" },
					},
					{
						type: "message",
						id: "error",
						parentId: "prompt",
						timestamp: "2026-01-01T00:00:02Z",
						message: {
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "Initial failure",
							usage: { input: 10, output: 2 },
						},
					},
				),
			),
			turnRecord: {
				id: "turn",
				turnType: "llm",
				status: "failed",
				forkPiEntryId: null,
				resultPiEntryId: null,
				startedAt: "2026-01-01T00:00:00Z",
				endedAt: "2026-01-01T00:00:05Z",
			},
			events: [
				{
					id: "evt1",
					instanceId: "trace-test",
					eventType: "pi.retry.end",
					createdAt: "2026-01-01T00:00:03Z",
					data: { turnRecordId: "turn", success: true },
				},
				{
					id: "evt2",
					instanceId: "trace-test",
					eventType: "pi.stream.delta",
					createdAt: "2026-01-01T00:00:04Z",
					data: { turnRecordId: "turn", streamType: "thinking", text: "Recovered thinking" },
				},
			],
		});
		expect(trace.assistant.thinking).toBe("Recovered thinking");
		expect(trace.piInput?.fullPrompt).toBe("Keep the prompt");
		expect(trace.usage?.input).toBe(10);
		expect(
			trace.traceItems
				.filter((item) => item.kind === "operational_event")
				.map((item) => item.eventType),
		).toEqual(["pi.error", "pi.retry.end"]);
	});

	it("projects assistant text, reasoning, usage, Pi input, and tool details from a turn slice", () => {
		const tree = parsePiSessionTreeContent(
			"trace-test",
			jsonl(
				{
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "Do the work" },
				},
				{
					type: "message",
					id: "user-2",
					parentId: "user-1",
					timestamp: "2026-01-01T00:00:01.500Z",
					message: { role: "user", content: "Use the saved context" },
				},
				{
					type: "message",
					id: "assistant-1",
					parentId: "user-2",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Inspect first.\n" },
							{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
							{ type: "text", text: "Done." },
							{ type: "thinking", thinking: "Check the result.\n" },
							{ type: "toolCall", id: "tool-1", name: "duplicate", arguments: { ignored: true } },
						],
						usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18 },
					},
				},
				{
					type: "message",
					id: "tool-result-1",
					parentId: "assistant-1",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						details: { path: "README.md", truncation: { truncated: true } },
						isError: false,
					},
				},
			),
		);

		const trace = buildTurnTraceFromSession({
			tree,
			turnRecord: {
				id: "trn_1",
				turnType: "llm",
				forkPiEntryId: null,
				resultPiEntryId: "tool-result-1",
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:04.000Z",
				status: "succeeded",
			},
		});

		expect(trace?.assistant.text.length).toBeGreaterThan(0);
		expect(trace?.assistant.thinking.length).toBeGreaterThan(0);
		expect(trace?.piInput?.parts.map((part) => part.text)).toEqual([
			"Do the work",
			"Use the saved context",
		]);
		expect(trace?.usage?.totalTokens).toBe(18);
		expect(trace?.toolCalls).toHaveLength(1);
		expect(trace?.toolCalls[0]?.status).toBe("completed");
		expect(trace?.toolCalls[0]).not.toHaveProperty("result");
		expect(trace?.traceItems.map((item) => item.kind)).toEqual([
			"thinking",
			"tool_call",
			"thinking",
		]);
		expect(trace?.toolCalls[0]).toMatchObject({
			toolName: "read",
			arguments: { path: "README.md" },
			startedAt: "2026-01-01T00:00:02.000Z",
			completedAt: "2026-01-01T00:00:03.000Z",
			resultText: "file contents",
			truncated: true,
		});
		expect(
			buildTurnTracePreviewsFromSession({
				tree,
				turnRecords: [
					{
						id: "trn_1",
						turnType: "llm",
						forkPiEntryId: null,
						resultPiEntryId: "tool-result-1",
						startedAt: "2026-01-01T00:00:00.000Z",
						endedAt: "2026-01-01T00:00:04.000Z",
						status: "succeeded",
					},
				],
			}).trn_1,
		).toEqual(buildTurnTracePreview("trn_1", trace));
	});

	it("keeps correlated operational events when the session slice is empty", () => {
		const tree = parsePiSessionTreeContent("trace-test", "");
		const trace = buildTurnTraceFromSession({
			tree,
			turnRecord: {
				id: "trn_operational",
				turnType: "llm",
				forkPiEntryId: null,
				resultPiEntryId: null,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:04.000Z",
				status: "failed",
			},
			events: [
				{
					id: "evt_operational",
					instanceId: "agt_1",
					eventType: "pi.error",
					data: {
						turnRecordId: "trn_operational",
						message: "Provider request failed",
					},
					createdAt: "2026-01-01T00:00:03.000Z",
				},
			],
		});

		expect(trace?.traceItems).toEqual([
			expect.objectContaining({
				kind: "operational_event",
				eventType: "pi.error",
				message: "Provider request failed",
			}),
		]);
	});

	it("sorts operational events chronologically without moving thinking or tool slots", () => {
		const tree = parsePiSessionTreeContent(
			"trace-test",
			jsonl(
				{
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "Do the work" },
				},
				{
					type: "message",
					id: "assistant-1",
					parentId: "user-1",
					timestamp: "2026-01-01T00:00:04.000Z",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "Later provider failure",
						content: [
							{ type: "thinking", thinking: "Inspect first" },
							{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
						],
					},
				},
			),
		);

		const trace = buildTurnTraceFromSession({
			tree,
			turnRecord: {
				id: "trn_mixed",
				turnType: "llm",
				forkPiEntryId: null,
				resultPiEntryId: "assistant-1",
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:05.000Z",
				status: "failed",
			},
			events: [
				{
					id: "evt_earlier",
					instanceId: "agt_1",
					eventType: "pi.error",
					data: {
						turnRecordId: "trn_mixed",
						message: "Earlier retry failure",
						timestamp: "2026-01-01T00:00:02.000Z",
					},
					createdAt: "2026-01-01T00:00:02.000Z",
				},
			],
		});

		expect(trace?.traceItems.map((item) => item.kind)).toEqual([
			"operational_event",
			"thinking",
			"tool_call",
			"operational_event",
		]);
		expect(
			trace?.traceItems
				.filter((item) => item.kind === "operational_event")
				.map((item) => item.message),
		).toEqual(["Earlier retry failure", "Later provider failure"]);
	});

	it("builds compact previews without carrying full reasoning payloads", () => {
		const trace = {
			assistant: {
				text: "A".repeat(2_000),
				thinking: Array.from({ length: 200 }, (_, index) => `step ${index}`).join("\n"),
				lastUpdatedAt: "2026-01-01T00:00:02.000Z",
			},
			toolCalls: [],
			traceItems: [],
			usage: null,
			piInput: null,
		};

		const preview = buildTurnTracePreview("trn_1", trace);

		expect(preview.assistantTextPreview.length).toBeLessThan(trace.assistant.text.length);
		expect(preview.assistantTextTruncated).toBe(true);
		expect(preview.thinkingPreview.length).toBeLessThan(trace.assistant.thinking.length);
		expect(preview.thinkingPreviewTruncated).toBe(true);
	});

	it("indexes a large multi-turn tree once and isolates changed previews", () => {
		const turnCount = 200;
		const entries: Record<string, unknown>[] = [];
		const turnRecords = Array.from({ length: turnCount }, (_, index) => {
			const entryId = (sequence: number): string =>
				`00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
			const userId = entryId(index * 2 + 1);
			const assistantId = entryId(index * 2 + 2);
			const previousAssistantId = index > 0 ? entryId(index * 2) : null;
			const userTimestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString();
			const assistantTimestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString();
			entries.push(
				{
					type: "message",
					id: userId,
					parentId: previousAssistantId,
					timestamp: userTimestamp,
					message: { role: "user", content: `prompt ${index}` },
				},
				{
					type: "message",
					id: assistantId,
					parentId: userId,
					timestamp: assistantTimestamp,
					message: { role: "assistant", content: `assistant ${index}` },
				},
			);
			return {
				id: `trn_${index}`,
				turnType: "llm" as const,
				forkPiEntryId: previousAssistantId,
				resultPiEntryId: assistantId,
				startedAt: userTimestamp,
				endedAt: assistantTimestamp,
				status: "succeeded" as const,
			};
		});
		const createTree = (treeEntries: Record<string, unknown>[]): ReadonlyPiSessionTree => ({
			...createReadonlyEntryTree(treeEntries as unknown as PiSessionEntry[]),
			treeFile: "large-trace-test",
			header: null,
			getTree: () => [],
		});
		const tree = createTree(entries);
		let indexedEntryReads = 0;
		const countedEntries = new Proxy(tree.entries, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) {
					indexedEntryReads += 1;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const getBranch = vi.fn(tree.getBranch);
		const countedTree: ReadonlyPiSessionTree = { ...tree, entries: countedEntries, getBranch };

		const previews = buildTurnTracePreviewsFromSession({
			tree: countedTree,
			turnRecords,
		});

		expect(Object.keys(previews)).toHaveLength(turnCount);
		expect(indexedEntryReads).toBe(entries.length);
		expect(getBranch).not.toHaveBeenCalled();
		expect(previews.trn_137?.assistantTextPreview).toBe("assistant 137");

		const changedEntries = entries.map((entry) =>
			entry.id === "00000000-0000-4000-8000-000000000276"
				? { ...entry, message: { role: "assistant", content: "changed assistant" } }
				: entry,
		);
		const changedPreviews = buildTurnTracePreviewsFromSession({
			tree: createTree(changedEntries),
			turnRecords,
		});
		expect(changedPreviews.trn_137?.assistantTextPreview).toBe("changed assistant");
		for (const turnRecord of turnRecords) {
			if (turnRecord.id !== "trn_137") {
				expect(changedPreviews[turnRecord.id]).toEqual(previews[turnRecord.id]);
			}
		}
	});
});
