import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, it } from "vitest";
import {
	createRemoteRepoChangeFixture,
	remoteState,
} from "./testing/diagnosed-remote-repo-change-fixture.js";

it.each([
	"no_changes",
	"cannot_repair",
] as const)("feedback %s returns to waiting without publishing a change", async (feedbackOutcome) => {
	const fixture = await createRemoteRepoChangeFixture(undefined, { feedbackOutcome });
	const id = await fixture.launchTicketlessChange("Update the service image");
	await fixture.publishChange(id);
	const pr = fixture.forgejo.pullRequest();
	const head = pr.head.sha;
	const history = fixture.git.log(pr.head.ref);
	if (feedbackOutcome === "no_changes") {
		await fixture.restart();
		await fixture.waitForTurn(id, "deliver_change");
	}
	const feedback = fixture.forgejo.addFeedback(pr.number);
	await fixture.pollFeedback();

	if (feedbackOutcome === "cannot_repair") {
		const blocked = await fixture.waitForTurn(id, "ci_operator_action");
		expect(remoteState(blocked)).toMatchObject({
			headSha: head,
			repairReason: "feedback",
			feedbackIds: [{ kind: "conversation", id: feedback.id }],
		});
		expect(fixture.forgejo.replies).toHaveLength(0);
		const turns = fixture.harness.process(id).snapshot().turns;
		const writes = fixture.harness.process(id).snapshot().writeReceipts;
		await fixture.restart();
		const reopened = await fixture.waitForTurn(id, "ci_operator_action");
		expect(reopened.stateJson).toBe(blocked.stateJson);
		expect(fixture.subscriptions(id)).toEqual([]);
		expect(fixture.harness.process(id).snapshot().turns).toEqual(turns);
		expect(fixture.harness.process(id).snapshot().writeReceipts).toEqual(writes);
		await fixture.action(id, "resume_waiting");
	} else {
		await waitForValue(
			() => fixture.forgejo.replies.length,
			(count) => count === 1,
			12_000,
		);
		expect(fixture.forgejo.replies[0]).toMatchObject({
			prNumber: pr.number,
			feedbackId: feedback.id,
			kind: "conversation",
		});
	}
	const waiting = await fixture.waitForTurn(id, "deliver_change");
	expect(remoteState(waiting)).toMatchObject({
		headSha: head,
		conversationCursor: feedback.id,
		feedbackIds: [],
		delivery: { adjustment: null },
	});
	expect(fixture.git.head(pr.head.ref)).toBe(head);
	expect(fixture.git.log(pr.head.ref)).toEqual(history);
	expect(fixture.forgejo.pullRequests).toHaveLength(1);
	expect(fixture.piTurns.filter((turn) => turn.kind === "feedback")).toHaveLength(1);

	// Consumed feedback must not launch another revision or reply on the next poll.
	await fixture.restart();
	await fixture.waitForTurn(id, "deliver_change");
	await fixture.pollFeedback();
	await fixture.waitForTurn(id, "deliver_change");
	expect(fixture.piTurns.filter((turn) => turn.kind === "feedback")).toHaveLength(1);
	expect(fixture.forgejo.replies).toHaveLength(feedbackOutcome === "no_changes" ? 1 : 0);
}, 30_000);
