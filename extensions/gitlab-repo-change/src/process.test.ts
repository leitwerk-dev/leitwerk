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
const observation: GitLabDeliveryObservation = {
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
};
describe("GitLab publication routing", () => {
	it("isolates runtime and exposes the shared delivery and repair turns", () => {
		expect(process.runtime).toEqual({ docker: false });
		expect(createGitLabRepoChange({ docker: true }).process.runtime).toEqual({ docker: true });
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
		).toMatchObject({ kind: "terminal", request: { merged: true } });
		expect(() =>
			gitlabPublicationEvidence(state, { ...observation, mr: { ...observation.mr, iid: 5 } }),
		).toThrow("Stale");
	});
	it("ignores CI for a different head and waits for pending pipelines", () => {
		expect(
			gitlabPublicationEvidence(state, {
				...observation,
				mr: { ...observation.mr, sha: "b".repeat(40) },
			}),
		).toMatchObject({ kind: "observed" });
		expect(
			gitlabPublicationEvidence(state, {
				...observation,
				pipeline: {
					id: 8,
					project_id: 1,
					sha: "a".repeat(40),
					ref: "feature",
					web_url: "https://gitlab.test/pipeline/8",
					status: "pending",
				},
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
			feedbackIds: [{ id: 12, discussionId: "d" }],
		});
		expect(evidence.observationKey).toBeUndefined();
		const current = applyPublicationEvidence(
			{ owner: "team/subgroup", repo: "repo", workBranch: "feature", baseBranch: "main" },
			readPublicationState(state, "gitlabRepoChange"),
			evidence,
		);
		expect(current.observationKey).toBeUndefined();
	});
});
