import { expect, it } from "vitest";
import { forgejoRepoChangeProcess as process } from "./index.js";
import { forgejoRepoChangeParamsCodec } from "./params.js";
import { deliveryTurn, routingState } from "./routing.test-fixture.js";

const params = {
	launchKind: "requested_change",
	repoLocator: "ssh://git@forgejo.example/team/service.git",
	prompt: "Update the service",
	issueUrl: "https://forgejo.example/team/service/issues/42",
	doneLabel: "leitwerk-done",
	forgejoProfile: "retained-forge",
	woodpeckerProfile: "retained-ci",
	sshCredentialRef: "retained-ssh",
	owner: "team",
	repo: "service",
	workBranch: "work",
	baseBranch: "main",
	issueNumber: 42,
	triggerLabel: "use-leitwerk",
};

it.each([
	["ui", 0, "woodpecker_failure_repair"],
	["issue", 2, "woodpecker_failure_repair"],
	[undefined, 3, "woodpecker_failure_operator"],
] as const)("resolves retained %s delivery sources with %s CI cycles", (origin, ciRecoveryCycles, ciAction) => {
	const state = routingState({
		headSha: "retained-head",
		prNumber: 7,
		prUrl: "https://forgejo.example/pulls/7",
		conversationCursor: 11,
		reviewCursor: 12,
		inlineCursor: 13,
		pipeline: { number: 8 },
		ciRecoveryCycles,
		lastConflictKey: "seen-conflict",
	});
	const ctx = {
		params: forgejoRepoChangeParamsCodec.parse({ ...params, ...(origin ? { origin } : {}) }),
		state,
	};
	const armed = Object.entries(deliveryTurn().externalActions ?? {}).filter(
		([, action]) => !action.when || action.when(ctx as never),
	);
	expect(armed.map(([id]) => id).sort()).toEqual(
		[
			"forgejo_merge_conflict",
			"forgejo_feedback",
			"forgejo_pr_merged",
			"forgejo_pr_closed",
			ciAction,
			...(origin === "ui" ? [] : ["source_cancelled"]),
		].sort(),
	);
	for (const [id, action] of armed) {
		const resolved = action.source.resolve(ctx as never);
		expect(resolved).toMatchObject({
			owner: "team",
			repo: "service",
			profile: id === ciAction ? "retained-ci" : "retained-forge",
		});
		if (id === ciAction)
			expect(resolved).toMatchObject({
				branch: "work",
				headSha: "retained-head",
				afterPipelineNumber: 8,
			});
		if (id === "forgejo_feedback")
			expect(resolved).toMatchObject({
				prNumber: 7,
				conversationCursor: 11,
				reviewCursor: 12,
				inlineCursor: 13,
			});
		if (id === "forgejo_merge_conflict")
			expect(resolved).toMatchObject({
				prNumber: 7,
				headSha: "retained-head",
				lastConflictKey: "seen-conflict",
			});
		if (id === "source_cancelled")
			expect(resolved).toMatchObject({ issueNumber: 42, triggerLabel: "use-leitwerk" });
	}
});

it.each([
	"revise_from_pull_request_feedback",
	"repair_woodpecker_pipeline",
	"ci_operator_action",
])("does not arm delivery sources while parked at %s", (id) => {
	const turn = process.turns.get(id)?.definition;
	expect(turn).toBeDefined();
	expect(Object.keys((turn as { externalActions?: object }).externalActions ?? {})).toEqual([]);
});
