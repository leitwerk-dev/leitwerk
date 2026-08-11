import type { PiTreeEntry } from "@leitwerk-dev/process-sdk";
import { StubPiTreeHandle } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import { isPiTreeEmptyForPreparedEmptyPlan } from "./llm-turn-execution.js";

function bootstrapModelChange(id: string, parentId: string | null = null): PiTreeEntry {
	return {
		id,
		parentId,
		type: "model_change",
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

function bootstrapThinkingLevel(id: string, parentId: string | null): PiTreeEntry {
	return {
		id,
		parentId,
		type: "thinking_level_change",
		timestamp: "2026-01-01T00:00:01.000Z",
	};
}

function userMessage(id: string, parentId: string | null): PiTreeEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:02.000Z",
		message: {
			role: "user",
			content: "draft a poem",
		},
	};
}

function stubHandleFromEntries(
	entries: readonly PiTreeEntry[],
	currentLeafId: string | null,
): StubPiTreeHandle {
	const childIdsByParent = new Map<string | null, string[]>();
	for (const entry of entries) {
		const siblings = childIdsByParent.get(entry.parentId) ?? [];
		siblings.push(entry.id);
		childIdsByParent.set(entry.parentId, siblings);
	}
	return new StubPiTreeHandle({
		sessionId: "stub-empty-plan",
		treeFile: "/tmp/stub-empty-plan.jsonl",
		isResumed: false,
		state: {
			turnSeq: 0,
			currentLeafId,
			entries: new Map(entries.map((entry) => [entry.id, entry])),
			childIdsByParent,
		},
	});
}

describe("isPiTreeEmptyForPreparedEmptyPlan", () => {
	it("treats a literally empty Pi tree as empty", () => {
		const piHandle = new StubPiTreeHandle({
			sessionId: "stub-empty",
			treeFile: "/tmp/stub-empty.jsonl",
			isResumed: false,
		});
		expect(isPiTreeEmptyForPreparedEmptyPlan(piHandle)).toBe(true);
	});

	it("treats Pi bootstrap model/thinking entries alone as empty", () => {
		const model = bootstrapModelChange("model-1");
		const thinking = bootstrapThinkingLevel("thinking-1", "model-1");
		const piHandle = stubHandleFromEntries([model, thinking], thinking.id);
		expect(isPiTreeEmptyForPreparedEmptyPlan(piHandle)).toBe(true);
	});

	it("treats trees with conversational messages as non-empty", () => {
		const model = bootstrapModelChange("model-1");
		const thinking = bootstrapThinkingLevel("thinking-1", "model-1");
		const user = userMessage("user-1", "thinking-1");
		const piHandle = stubHandleFromEntries([model, thinking, user], user.id);
		expect(isPiTreeEmptyForPreparedEmptyPlan(piHandle)).toBe(false);
	});
});
