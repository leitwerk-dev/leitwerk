import { expect, it } from "vitest";
import { deliveryTurn, routingState } from "./routing.test-fixture.js";

it.each([
	"issue",
	"ui",
] as const)("source cancellation is enabled only for issue-origin delivery (%s)", (origin) => {
	const action = deliveryTurn().externalActions?.source_cancelled;
	expect(action?.when?.({ params: { origin } } as never)).toBe(origin === "issue");
	expect(action).toMatchObject({ lifecycleStatus: "aborted" });
	expect(action).not.toHaveProperty("to");
	expect(action?.effect).toBeUndefined();
});

it.each([
	"issue",
	"ui",
] as const)("PR closure defers %s finalization until delivery reconciliation", async (origin) => {
	const state = routingState({
		headSha: "retained-head",
		prNumber: 7,
		ciRecoveryCycles: 2,
		feedbackIds: [{ kind: "conversation", id: 12 }],
		delivery: { stage: "awaiting", issueLinked: true },
	});
	const before = structuredClone(state);
	const pullRequest = { number: 7, state: "closed", merged: false, head: { sha: "retained-head" } };
	const action = deliveryTurn().externalActions?.forgejo_pr_closed;
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
	expect(deliveryTurn().outcomes.aborted).toMatchObject({ lifecycleStatus: "aborted" });
});
