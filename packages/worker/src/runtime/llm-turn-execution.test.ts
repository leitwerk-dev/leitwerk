import type { PiTreeNode } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { isPiTreeEmptyForPreparedEmptyPlan } from "./llm-turn-execution.js";

function node(type: string, children: PiTreeNode[] = []): PiTreeNode {
	return {
		entry: {
			id: type,
			parentId: null,
			type,
			timestamp: "2026-01-01T00:00:00.000Z",
			...(type === "message" ? { message: { role: "user", content: "draft a poem" } } : {}),
		},
		children: children.map((child) => ({
			...child,
			entry: { ...child.entry, parentId: type },
		})),
	};
}

describe("isPiTreeEmptyForPreparedEmptyPlan", () => {
	it("treats a literally empty Pi tree as empty", () => {
		expect(isPiTreeEmptyForPreparedEmptyPlan({ getTree: () => [] })).toBe(true);
	});

	it("treats Pi bootstrap model/thinking entries alone as empty", () => {
		const tree = [node("model_change", [node("thinking_level_change")])];
		expect(isPiTreeEmptyForPreparedEmptyPlan({ getTree: () => tree })).toBe(true);
	});

	it("treats trees with conversational messages as non-empty", () => {
		const tree = [node("model_change", [node("thinking_level_change", [node("message")])])];
		expect(isPiTreeEmptyForPreparedEmptyPlan({ getTree: () => tree })).toBe(false);
	});
});
