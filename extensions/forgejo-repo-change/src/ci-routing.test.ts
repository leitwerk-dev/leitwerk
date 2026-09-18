import { expect, it } from "vitest";
import { forgejoRepoChangeProcess as process } from "./index.js";

function deliveryTurn() {
	const turn = process.turns.get("deliver_change")?.definition;
	if (turn?.kind !== "automatic") throw new Error("Missing delivery turn");
	return turn;
}

function operatorTurn() {
	const turn = process.turns.get("ci_operator_action")?.definition;
	if (turn?.kind !== "human") throw new Error("Missing operator turn");
	return turn;
}

function stateWithCycles(ciRecoveryCycles?: number) {
	return process.stateCodec.parse({
		extensionState: {
			unrelated: { retained: true },
			forgejoRepoChange: {
				headSha: "current-head",
				prNumber: 7,
				prUrl: "https://forgejo.example/team/service/pulls/7",
				...(ciRecoveryCycles === undefined ? {} : { ciRecoveryCycles }),
			},
		},
	});
}

it.each([
	[undefined, "repair", 1],
	[0, "repair", 1],
	[1, "repair", 2],
	[2, "repair", 3],
	[3, "operator", 3],
	[4, "operator", 4],
] as const)("routes CI with %s retained cycles to %s", async (cycles, route, nextCycles) => {
	const state = stateWithCycles(cycles);
	const before = structuredClone(state);
	const actions = deliveryTurn().externalActions;
	const repair = actions?.woodpecker_failure_repair;
	const operator = actions?.woodpecker_failure_operator;
	const context = { state };
	expect(repair?.when?.(context as never)).toBe(route === "repair");
	expect(operator?.when?.(context as never)).toBe(route === "operator");
	const selected = route === "repair" ? repair : operator;
	expect(selected?.to).toBe(
		route === "repair" ? "repair_woodpecker_pipeline" : "ci_operator_action",
	);
	const pipeline = { number: 9, status: "failure", branch: "work", commit: "current-head" };
	const effect = await selected?.effect?.({ state, event: { pipeline } } as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			unrelated: { retained: true },
			forgejoRepoChange: {
				repairReason: "ci",
				pipeline,
				ciRecoveryCycles: nextCycles,
				headSha: "current-head",
				prNumber: 7,
			},
		},
	});
	expect(state).toEqual(before);
});

it.each([
	"ci",
	"feedback",
	"rebase",
] as const)("operator retry preserves %s evidence and the exhausted automatic budget", async (repairReason) => {
	const state = stateWithCycles(3);
	Object.assign(state.extensionState.forgejoRepoChange, {
		repairReason,
		pipeline: { number: 9, status: "failure" },
	});
	const before = structuredClone(state);
	const action = operatorTurn().actions.retry_repair;
	if (!("choose" in action)) throw new Error("Missing retry branches");
	const branch = await action.choose({ ctx: { state } } as never);
	expect(action.branches[branch].to).toBe(
		repairReason === "ci" ? "repair_woodpecker_pipeline" : "revise_from_pull_request_feedback",
	);
	expect(action.effect).toBeUndefined();
	expect(state).toEqual(before);
});

it("resume waiting clears pending adjustment without resetting the CI budget or evidence", async () => {
	const state = stateWithCycles(3);
	const pipeline = { number: 9, status: "failure" };
	Object.assign(state.extensionState.forgejoRepoChange, {
		repairReason: "ci",
		pipeline,
		conversationCursor: 12,
		feedbackIds: [{ kind: "conversation", id: 12 }],
		delivery: { stage: "awaiting", adjustment: { origin: "ci", publishRequired: true } },
	});
	const before = structuredClone(state);
	const action = operatorTurn().actions.resume_waiting;
	expect(action).toMatchObject({ to: "deliver_change" });
	const effect = await action.effect?.({ ctx: { state } } as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			forgejoRepoChange: {
				ciRecoveryCycles: 3,
				pipeline,
				headSha: "current-head",
				conversationCursor: 12,
				feedbackIds: [],
				delivery: { stage: "awaiting", adjustment: null },
			},
		},
	});
	expect(state).toEqual(before);
});

it.each([
	["changes_ready", true],
	["no_changes", false],
] as const)("CI %s retains the exhausted budget when returning to delivery", async (name, publishRequired) => {
	const state = stateWithCycles(3);
	const turn = process.turns.get("repair_woodpecker_pipeline")?.definition;
	if (turn?.kind !== "llm") throw new Error("Missing repair turn");
	const outcome = turn.outcomes?.[name];
	expect(outcome).toMatchObject({ to: "deliver_change" });
	const effect = await outcome?.effect?.({ ctx: { state }, event: {} } as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			forgejoRepoChange: {
				ciRecoveryCycles: 3,
				delivery: { adjustment: { origin: "ci", publishRequired } },
			},
		},
	});
});

it("operator abort terminates without routing another repair", () => {
	expect(operatorTurn().actions.abort).toMatchObject({ lifecycleStatus: "aborted" });
	expect(operatorTurn().actions.abort).not.toHaveProperty("to");
});
