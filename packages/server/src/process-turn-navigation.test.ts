import { defineProcess, getProcessGraph, humanTurn, llmTurn } from "@leitwerk-dev/process-sdk";
import type { ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { presentProcessTurnNavigation } from "./process-turn-navigation.js";

const codec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };
const process = defineProcess({
	id: "change",
	displayName: "Change",
	entry: "implement",
	happyPath: ["implement", "decision"],
	paramsCodec: codec,
	stateCodec: codec,
	initialState: () => ({}),
	turns: {
		implement: llmTurn({
			description: "Implement",
			branchType: "primary",
			context: "fresh",
			availableTools: [],
			prompt: async () => "Implement the change",
			outcomes: { ready: { description: "Ready for review", parameters: {}, to: "decision" } },
		}),
		decision: humanTurn({
			description: "Review",
			actions: { approve: { label: "Approve", acceptanceState: "accepted", complete: true } },
		}),
	},
});
const graph = getProcessGraph(new Map([[process.id, process]]), process.id);

describe("turn navigation", () => {
	it("uses the owning turn label for human history and includes the next human decision", () => {
		const turn = {
			turnId: "decision",
			displayTurn: "Adjust",
			outcome: "Adjust",
		} as ProcessTimelineTurnSummary;
		const result = presentProcessTurnNavigation({
			graph,
			turns: [turn],
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		expect(result.turns[0]).toMatchObject({ displayTurn: "Review", outcome: "Adjust" });
		expect(turn.displayTurn).toBe("Adjust");
		expect(result.plannedNextTurn).toEqual({ turnId: "decision", description: "Review" });
	});
	it("preserves unknown historical labels and does not invent a next turn", () => {
		const turn = { turnId: "removed", displayTurn: "Old turn" } as ProcessTimelineTurnSummary;
		expect(
			presentProcessTurnNavigation({
				graph,
				turns: [turn],
				selectedTurnId: "removed",
				lifecycleStatus: "active",
			}),
		).toEqual({ turns: [turn], plannedNextTurn: null });
		for (const lifecycleStatus of ["waiting", "completed", "aborted", "error"] as const) {
			expect(
				presentProcessTurnNavigation({
					graph,
					turns: [],
					selectedTurnId: "implement",
					lifecycleStatus,
				}).plannedNextTurn,
			).toBeNull();
		}
		expect(
			presentProcessTurnNavigation({
				graph: { ...graph, happyPath: null },
				turns: [],
				selectedTurnId: "implement",
				lifecycleStatus: "active",
			}).plannedNextTurn,
		).toBeNull();
	});
	it("labels mapped item records and plans the next frozen item", () => {
		const run = {
			id: "mlr_1",
			instanceId: "pi_1",
			turnId: "implement",
			status: "active" as const,
			itemCount: 3,
			nextIndex: 1,
			createdAt: "t",
			updatedAt: "t",
		};
		const item = (itemIndex: number, itemKey: string, label: string) => ({
			runId: run.id,
			instanceId: "pi_1",
			itemIndex,
			itemKey,
			label,
			itemJson: "{}",
			status: "pending" as const,
			outcome: null,
			resultJson: null,
			turnRecordId: null,
			completedAt: null,
		});
		const turns = ["trn_a", "trn_b"].map(
			(id) => ({ id, turnId: "implement", displayTurn: "implement" }) as ProcessTimelineTurnSummary,
		);
		const result = presentProcessTurnNavigation({
			graph,
			turns,
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			turnRecords: [
				{ id: "trn_a", iteration: { runId: run.id, itemKey: "a", itemIndex: 0 } },
				{ id: "trn_b", iteration: { runId: run.id, itemKey: "b", itemIndex: 1 } },
			],
			mapped: {
				runs: [run],
				items: [item(0, "a", "Alpha"), item(1, "b", "Bravo"), item(2, "c", "Charlie")],
			},
		});
		expect(result.turns.map((turn) => [turn.displayTurn, turn.iteration])).toEqual([
			["Implement: Alpha", { runId: run.id, itemKey: "a", index: 0, count: 3, label: "Alpha" }],
			["Implement: Bravo", { runId: run.id, itemKey: "b", index: 1, count: 3, label: "Bravo" }],
		]);
		expect(result.plannedNextTurn).toEqual({
			turnId: "implement",
			description: "Implement: Charlie",
			iteration: { runId: run.id, itemKey: "c", index: 2, count: 3, label: "Charlie" },
		});
		expect(
			presentProcessTurnNavigation({
				graph,
				turns: [],
				selectedTurnId: "implement",
				lifecycleStatus: "active",
				mapped: { runs: [{ ...run, nextIndex: 2 }], items: [item(2, "c", "Charlie")] },
			}).plannedNextTurn,
		).toEqual({ turnId: "decision", description: "Review" });
	});
});
