import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { createTestDiagnostics } from "@leitwerk-dev/test-support/local-git";
import { expect, it, onTestFailed, onTestFinished } from "vitest";
import {
	createRemoteRepoChangeFixture,
	remoteState,
} from "./testing/remote-repo-change-fixture.js";

it.each([
	"no_changes",
	"cannot_repair",
] as const)("feedback %s returns to waiting without publishing a change", async (feedbackOutcome) => {
	const trace = createTestDiagnostics(`feedback ${feedbackOutcome}`);
	onTestFailed(() => trace.report());
	return trace.run(async () => {
		trace.mark("fixture.start");
		const fixture = await createRemoteRepoChangeFixture(undefined, { feedbackOutcome });
		onTestFinished(async () => {
			trace.mark("cleanup.start");
			await fixture.close();
			trace.mark("cleanup.end");
		});
		trace.mark("fixture.ready");
		trace.mark("plan.start");
		const id = await fixture.launchTicketlessChange("Update the service image");
		trace.mark("plan.ready", { instanceId: id });
		await fixture.approvePlan(id);
		trace.mark("implementation.ready");
		await fixture.approveImplementation(id);
		trace.mark("publication.ready");
		const pr = fixture.forgejo.pullRequest();
		const head = pr.head.sha;
		const history = fixture.git.log(pr.head.ref);
		if (feedbackOutcome === "no_changes") {
			trace.mark("delivery.restart.start");
			await fixture.restart();
			await fixture.waitForTurn(id, "deliver_change");
			trace.mark("delivery.restart.end");
		}
		const feedback = fixture.forgejo.addFeedback(pr.number);
		trace.mark("feedback.poll.start");
		await fixture.pollFeedback();
		trace.mark("feedback.poll.end");

		if (feedbackOutcome === "cannot_repair") {
			trace.mark("operator.wait.start");
			const blocked = await fixture.waitForTurn(id, "ci_operator_action");
			trace.mark("operator.wait.end");
			expect(remoteState(blocked)).toMatchObject({
				headSha: head,
				repairReason: "feedback",
				feedbackIds: [{ kind: "conversation", id: feedback.id }],
			});
			expect(fixture.forgejo.replies).toHaveLength(0);
			const turns = fixture.harness.ctx.deps.turnRecords.listByInstance(id);
			const writes = fixture.harness.ctx.deps.externalWrites.listByInstance(id);
			trace.mark("operator.restart.start");
			await fixture.restart();
			const reopened = await fixture.waitForTurn(id, "ci_operator_action");
			expect(reopened.stateJson).toBe(blocked.stateJson);
			expect(fixture.subscriptions(id)).toEqual([]);
			expect(fixture.harness.ctx.deps.turnRecords.listByInstance(id)).toEqual(turns);
			expect(fixture.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
			trace.mark("operator.restart.end");
			await fixture.action(id, "resume_waiting");
			trace.mark("operator.resumed");
		} else {
			trace.mark("reply.wait.start");
			await waitForValue(
				() => fixture.forgejo.replies.length,
				(count) => count === 1,
				12_000,
			);
			trace.mark("reply.wait.end");
			expect(fixture.forgejo.replies[0]).toMatchObject({
				prNumber: pr.number,
				feedbackId: feedback.id,
				kind: "conversation",
			});
		}
		trace.mark("delivery.wait.start");
		const waiting = await fixture.waitForTurn(id, "deliver_change");
		trace.mark("delivery.wait.end");
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
		trace.mark("replay.start");
		await fixture.restart();
		await fixture.waitForTurn(id, "deliver_change");
		await fixture.pollFeedback();
		await fixture.waitForTurn(id, "deliver_change");
		expect(fixture.piTurns.filter((turn) => turn.kind === "feedback")).toHaveLength(1);
		expect(fixture.forgejo.replies).toHaveLength(feedbackOutcome === "no_changes" ? 1 : 0);
		trace.mark("replay.end");
	});
}, 30_000);
