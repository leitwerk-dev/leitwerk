import { expect, it } from "vitest";
import { forgejoRepoChangeProcess as process } from "./index.js";

function delivery() {
	const turn = process.turns.get("deliver_change")?.definition;
	if (turn?.kind !== "automatic") throw new Error("Missing delivery turn");
	return turn;
}

it.each([
	"issue",
	"ui",
] as const)("source cancellation is enabled only for issue-origin delivery (%s)", (origin) => {
	const action = delivery().externalActions?.source_cancelled;
	expect(action?.when?.({ params: { origin } } as never)).toBe(origin === "issue");
	expect(action).toMatchObject({ lifecycleStatus: "aborted" });
	expect(action).not.toHaveProperty("to");
	expect(action?.effect).toBeUndefined();
});

it.each([
	"issue",
	"ui",
] as const)("PR closure defers %s finalization until delivery reconciliation", async (origin) => {
	const state = process.stateCodec.parse({
		extensionState: {
			forgejoRepoChange: {
				headSha: "retained-head",
				prNumber: 7,
				ciRecoveryCycles: 2,
				feedbackIds: [{ kind: "conversation", id: 12 }],
				delivery: { stage: "awaiting", issueLinked: true },
			},
		},
	});
	const before = structuredClone(state);
	const pullRequest = { number: 7, state: "closed", merged: false, head: { sha: "retained-head" } };
	const action = delivery().externalActions?.forgejo_pr_closed;
	expect(action).toMatchObject({ to: "deliver_change" });
	expect(action).not.toHaveProperty("lifecycleStatus");
	const effect = await action?.effect?.({
		params: { origin },
		state,
		event: { pullRequest },
	} as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			forgejoRepoChange: {
				headSha: "retained-head",
				prNumber: 7,
				ciRecoveryCycles: 2,
				feedbackIds: [{ kind: "conversation", id: 12 }],
				delivery: { stage: "awaiting", issueLinked: true, terminalPullRequest: pullRequest },
			},
		},
	});
	expect(state).toEqual(before);
	expect(delivery().outcomes.aborted).toMatchObject({ lifecycleStatus: "aborted" });
});
