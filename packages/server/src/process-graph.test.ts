import { defineProcess, humanTurn, llmTurn } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	getProcessGraph,
	listLlmTurnIdsForProcessGraph,
	serializeProcessGraph,
} from "./process-graph.js";

const paramsCodec = {
	parse: () => ({}),
	serialize: (value: Record<string, never>) => value,
};

const stateCodec = {
	parse: () => ({}),
	serialize: (value: Record<string, never>) => value,
};

function createProcess() {
	return defineProcess({
		id: "graph_view_process",
		displayName: "Graph View Process",
		entry: "draft",
		paramsCodec,
		stateCodec,
		initialState: () => ({}),
		turns: {
			draft: llmTurn({
				availableTools: [],
				description: "Draft",
				branchType: "primary",
				context: "fresh",
				prompt: async () => "draft",
				outcomes: {
					ready: { description: "Ready", parameters: {}, to: "review" },
				},
			}),
			review: humanTurn({
				description: "Review",
				actions: {
					approve: {
						label: "Approve",
						acceptanceState: "accepted",
						complete: true,
					},
				},
			}),
		},
	});
}

describe("process-graph", () => {
	it("reads process-owned turns directly from defineProcess output", () => {
		const process = createProcess();
		const registry = new Map([[process.id, process]]);

		expect(listLlmTurnIdsForProcessGraph(registry, process.id)).toEqual(["draft"]);
		expect(getProcessGraph(registry, process.id).turns.get("review")?.transitions).toEqual([
			{ lifecycleStatus: "completed", trigger: "approve" },
		]);
	});

	it("serializes the browser turn graph from the shared process graph view", () => {
		const process = createProcess();
		const processRegistry = new Map([[process.id, process]]);
		expect(serializeProcessGraph(processRegistry, process.id)).toEqual({
			id: process.id,
			entryTurnIds: [process.entryTurnId],
			reachableTurnIds: ["draft", "review"],
			turnTransitions: {
				draft: [{ nextTurnId: "review", outcome: "ready" }],
				review: [{ lifecycleStatus: "completed", trigger: "approve" }],
			},
		});
	});
});
