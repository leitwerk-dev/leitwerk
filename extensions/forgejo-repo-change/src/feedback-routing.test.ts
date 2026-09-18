import { expect, it } from "vitest";
import { forgejoRepoChangeProcess as process } from "./index.js";

function feedbackState() {
	return process.stateCodec.parse({
		extensionState: {
			unrelated: { retained: true },
			forgejoRepoChange: {
				headSha: "current-head",
				prNumber: 7,
				prUrl: "https://forgejo.example/pulls/7",
				ciRecoveryCycles: 3,
				conversationCursor: 10,
				reviewCursor: 20,
				inlineCursor: 30,
				feedbackIds: [{ kind: "conversation", id: 10 }],
				delivery: { stage: "awaiting", adjustment: null },
			},
		},
	});
}

it("accepts feedback evidence without resetting unrelated delivery state or omitted cursors", async () => {
	const state = feedbackState();
	const before = structuredClone(state);
	const turn = process.turns.get("deliver_change")?.definition;
	if (turn?.kind !== "automatic") throw new Error("Missing delivery turn");
	const action = turn.externalActions?.forgejo_feedback;
	const feedbackIds = [{ kind: "inline", id: 31 }];
	expect(action).toMatchObject({ to: "deliver_change" });
	const effect = await action?.effect?.({
		state,
		event: { feedbackIds, cursors: { inlineCursor: 31 } },
	} as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			unrelated: { retained: true },
			forgejoRepoChange: {
				repairReason: "feedback",
				feedbackIds,
				conversationCursor: 10,
				reviewCursor: 20,
				inlineCursor: 31,
				ciRecoveryCycles: 3,
				headSha: "current-head",
			},
		},
	});
	expect(state).toEqual(before);
});

it.each([
	["changes_ready", true],
	["no_changes", false],
] as const)("feedback %s requests publication only when necessary", async (name, publishRequired) => {
	const state = feedbackState();
	const before = structuredClone(state);
	const turn = process.turns.get("revise_from_pull_request_feedback")?.definition;
	if (turn?.kind !== "llm") throw new Error("Missing feedback turn");
	const outcome = turn.outcomes?.[name];
	expect(outcome).toMatchObject({ to: "deliver_change" });
	const effect = await outcome?.effect?.({ ctx: { state }, event: {} } as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			unrelated: { retained: true },
			forgejoRepoChange: {
				headSha: "current-head",
				ciRecoveryCycles: 3,
				feedbackIds: [{ kind: "conversation", id: 10 }],
				delivery: { stage: "awaiting", adjustment: { origin: "feedback", publishRequired } },
			},
		},
	});
	expect(state).toEqual(before);
});

it("cannot_repair routes feedback to the operator without planning publication", () => {
	const turn = process.turns.get("revise_from_pull_request_feedback")?.definition;
	if (turn?.kind !== "llm") throw new Error("Missing feedback turn");
	const outcome = turn.outcomes?.cannot_repair;
	expect(outcome).toMatchObject({ to: "ci_operator_action" });
	expect(outcome?.effect).toBeUndefined();
});
