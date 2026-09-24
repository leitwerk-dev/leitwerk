import { forgejoIssueWatcherSource } from "@leitwerk-dev/forgejo";
import { describe, expect, it } from "vitest";
import { forgejoRepoChangeProcess } from "./testing/default-process.js";
import { launcherFixture } from "./testing/launcher-fixture.js";

describe("forgejoRepoChangeProcess", () => {
	it("uses one waiting automatic delivery turn for publication and external evidence", () => {
		for (const removed of [
			"import_plan",
			"publish_work_branch",
			"create_pull_request",
			"wait_for_remote",
			"evaluate_pipeline",
			"source_issue_cancelled",
			"acknowledge_pull_request_feedback",
			"reply_to_pull_request_feedback",
			"push_feedback_revision",
			"push_ci_repair",
			"finalize_pull_request_terminal",
		]) {
			expect(forgejoRepoChangeProcess.turns.has(removed)).toBe(false);
		}

		const delivery = forgejoRepoChangeProcess.turns.get("deliver_change")?.definition;
		expect(delivery).toMatchObject({
			kind: "automatic",
			integrationTools: expect.arrayContaining([
				"forgejo_ensure_pull_request",
				"forgejo_add_pull_request_feedback_reaction",
				"forgejo_reply_to_pull_request_feedback",
			]),
			outcomes: {
				awaiting: { effect: expect.any(Function) },
				feedback_ready: { to: "revise_from_pull_request_feedback" },
				completed: { complete: true },
				aborted: { lifecycleStatus: "aborted" },
			},
			externalActions: {
				forgejo_feedback: { to: "deliver_change" },
				woodpecker_failure_repair: { to: "repair_woodpecker_pipeline" },
				woodpecker_failure_operator: { to: "ci_operator_action" },
				forgejo_pr_merged: { to: "deliver_change" },
				forgejo_pr_closed: { to: "deliver_change" },
				source_cancelled: { lifecycleStatus: "aborted" },
			},
		});
	});

	it("launches against the issue repository default branch with stable project metadata", async () => {
		const { watcher, ui, identity } = launcherFixture();
		expect(watcher.source).toBe(forgejoIssueWatcherSource);

		const event = {
			profile: "team",
			repository: {
				name: "service",
				full_name: "team/service",
				ssh_url: "ssh://git@forgejo.example:2222/team/service.git",
				default_branch: "trunk",
				owner: { login: "team" },
			},
			issue: {
				number: 42,
				title: "Change it",
				body: "Acceptance details",
				html_url: "https://forgejo.example/team/service/issues/42",
			},
			labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
		};
		const launch = await watcher.resolveLaunchConfig(event);

		expect(launch).toMatchObject({
			processId: "forgejo_repo_change_process",
			externalId: "forgejo:team/service#42",
			params: {
				baseBranch: "trunk",
				workBranch: "leitwerk/issue-42",
				forgejoProfile: "team",
				woodpeckerProfile: "team",
				sshCredentialRef: "team",
			},
			projects: [
				{
					key: "repo",
					baseBranch: "trunk",
					workBranch: "leitwerk/issue-42",
					metadata: {
						forgejo: { owner: "team", repo: "service", issueNumber: 42 },
						"leitwerk.gitIdentity": identity,
					},
				},
			],
		});
		expect(watcher.preparationChecks).toBe(ui.preparationChecks);
	});
});

it("reuses the feedback turn for conflict repair even after CI retries are exhausted", async () => {
	const state = forgejoRepoChangeProcess.stateCodec.parse({
		extensionState: {
			forgejoRepoChange: {
				headSha: "a".repeat(40),
				prNumber: 53,
				prUrl: "https://example.test/pr/53",
				ciRecoveryCycles: 3,
			},
		},
	});
	const params = { owner: "owner", repo: "repo", workBranch: "work", baseBranch: "main" };
	const deliver = forgejoRepoChangeProcess.turns.get("deliver_change")?.definition;
	if (deliver?.kind !== "automatic") throw new Error("delivery");
	const action = deliver.externalActions?.forgejo_merge_conflict;
	expect(action?.to).toBe("revise_from_pull_request_feedback");
	const event = {
		conflict: {
			owner: "owner",
			repo: "repo",
			prNumber: 53,
			headBranch: "work",
			baseBranch: "main",
			headSha: "a".repeat(40),
			baseSha: "b".repeat(40),
			url: "https://example.test/pr/53",
		},
	};
	const effect = await action?.effect?.({ state, params, event } as never);
	expect(effect?.state).toMatchObject({
		extensionState: {
			forgejoRepoChange: { repairReason: "rebase", ciRecoveryCycles: 3, conflict: event.conflict },
		},
	});
	expect(() => action?.effect?.({ state: effect?.state, params, event } as never)).toThrow(
		"Stale or invalid",
	);
	const operator = forgejoRepoChangeProcess.turns.get("ci_operator_action")?.definition;
	if (operator?.kind !== "human") throw new Error("operator");
	const retry = await ("choose" in operator.actions.retry_repair
		? operator.actions.retry_repair.choose({ ctx: { state: effect?.state } } as never)
		: undefined);
	expect(retry).toBe("feedback");
});
