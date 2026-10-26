import {
	applyPublicationEvidence,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { GitLabDeliveryObservation } from "@leitwerk-dev/gitlab";
import { describe, expect, it } from "vitest";
import { createGitLabRepoChange } from "./index.js";
import { gitlabPublicationEvidence } from "./process.js";

const process = createGitLabRepoChange({ docker: false }).process;
const state = process.stateCodec.parse({
	extensionState: {
		gitlabRepoChange: { prNumber: 4, headSha: "a".repeat(40), prUrl: "https://gitlab.test/mr/4" },
	},
});
const observation = {
	mr: {
		iid: 4,
		project_id: 1,
		source_project_id: 1,
		target_project_id: 1,
		title: "Change",
		description: null,
		state: "opened",
		labels: [],
		sha: "a".repeat(40),
		source_branch: "feature",
		target_branch: "main",
		web_url: "https://gitlab.test/mr/4",
	},
	pipeline: {
		id: 8,
		project_id: 1,
		sha: "a".repeat(40),
		ref: "feature",
		status: "failed",
		web_url: "https://gitlab.test/pipeline/8",
	},
	observationKey: "failed-8",
} satisfies GitLabDeliveryObservation;
describe("GitLab publication routing", () => {
	it("isolates runtime and exposes the shared delivery and repair turns", () => {
		const containerProcess = createGitLabRepoChange({ docker: true }).process;
		expect(process.runtime).toMatchObject({ docker: false });
		expect(containerProcess.runtime).toMatchObject({ docker: true });
		expect(process.turns.has("deliver_change")).toBe(true);
		expect(process.turns.has("repair_gitlab_pipeline")).toBe(true);
	});
	it("prioritizes terminal MR state and rejects another request", () => {
		expect(
			gitlabPublicationEvidence(state, {
				...observation,
				mr: { ...observation.mr, state: "merged" },
				feedback: [
					{ id: 12, discussionId: "d", body: "feedback", author: "human", createdAt: "2026-01-01" },
				],
			}),
		).toMatchObject({ kind: "terminal", request: { number: 4, merged: true } });
		expect(() =>
			gitlabPublicationEvidence(state, { ...observation, mr: { ...observation.mr, iid: 5 } }),
		).toThrow();
	});
	it("routes failed current-head CI and waits for different heads or pending pipelines", () => {
		expect(gitlabPublicationEvidence(state, observation)).toMatchObject({ kind: "failure" });
		expect(
			gitlabPublicationEvidence(state, {
				...observation,
				mr: { ...observation.mr, sha: "b".repeat(40) },
			}),
		).toMatchObject({ kind: "observed" });
		expect(
			gitlabPublicationEvidence(state, {
				...observation,
				pipeline: { ...observation.pipeline, status: "pending" },
			}),
		).toMatchObject({ kind: "observed" });
	});
	it("handles feedback and verified merge-result CI on a changed source revision", () => {
		const head = "b".repeat(40);
		const event = { ...observation, mr: { ...observation.mr, sha: head } };
		const feedback = gitlabPublicationEvidence(state, {
			...event,
			feedback: [
				{ id: 12, discussionId: "d", body: "feedback", author: "human", createdAt: "2026-01-01" },
			],
		});
		expect(feedback).toMatchObject({ kind: "feedback", remoteHeadSha: head });
		expect(
			applyPublicationEvidence({}, readPublicationState(state, "gitlabRepoChange"), feedback),
		).toMatchObject({ headSha: head, workBaselineSha: observation.mr.sha });
		expect(
			gitlabPublicationEvidence(state, {
				...event,
				pipelineSourceHead: head,
				pipeline: { ...observation.pipeline, sha: "merge-result" },
			}),
		).toMatchObject({ kind: "failure", remoteHeadSha: head });
		expect(
			gitlabPublicationEvidence(state, {
				...event,
				pipelineSourceHead: observation.mr.sha,
				pipeline: { ...observation.pipeline, sha: "old-merge-result" },
			}),
		).toMatchObject({ kind: "observed" });
	});

	it("keeps failed CI unconsumed when a feedback batch takes priority", () => {
		const evidence = gitlabPublicationEvidence(state, {
			...observation,
			feedback: [
				{ id: 12, discussionId: "d", body: "feedback", author: "human", createdAt: "2026-01-01" },
			],
		});
		expect(evidence).toMatchObject({
			kind: "feedback",
			conversationCursor: 12,
			feedbackIds: [{ kind: "inline", id: 12, discussionId: "d" }],
		});
		expect(evidence.observationKey).toBeUndefined();
		const current = applyPublicationEvidence(
			{ owner: "team/subgroup", repo: "repo", workBranch: "feature", baseBranch: "main" },
			{ ...readPublicationState(state, "gitlabRepoChange"), observationKey: "prior-observation" },
			evidence,
		);
		expect(current.observationKey).toBe("prior-observation");
	});
});
