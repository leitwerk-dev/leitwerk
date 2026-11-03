import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import {
	createRepositoryChangePublication,
	patchPublicationState,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { bindExternalWrites } from "@leitwerk-dev/external-writes/internal";
import { createCapabilityAccessor } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { describe, expect, it } from "vitest";
import type { GitLabDeliveryObservation } from "./external.js";
import {
	type GitLabMaintainedProcess,
	type GitLabMaintenance,
	type GitLabMaintenanceContext,
	gitlabMaintenance,
} from "./maintenance.js";
import { mr } from "./merge-request.test-fixture.js";
import { createGitLabPublicationAdapter, type GitLabPublicationParams } from "./publication.js";

function fixture({
	cycles = 1,
	projectKey = "repo",
}: {
	cycles?: number;
	projectKey?: "repo" | "repo_1" | "repo_2";
} = {}) {
	const namespace = "testPublication";
	const coordinated = projectKey !== "repo";
	const projectId = projectKey === "repo_2" ? 8 : 7;
	const selectedNamespace = coordinated ? `${namespace}:${projectKey}` : namespace;
	const otherKey = projectKey === "repo_1" ? "repo_2" : "repo_1";
	const adapter = createGitLabPublicationAdapter<GitLabPublicationParams>([], namespace);
	if (coordinated)
		adapter.repositories = (params) =>
			["repo_1", "repo_2"].map((key, index) => ({
				key,
				params: { ...params, projectId: 7 + index },
			}));
	const { process } = createRepositoryChangeProcess<GitLabPublicationParams>({
		processId: "test_change",
		displayName: "Test change",
		paramsCodec: {
			parse: (value) => value as GitLabPublicationParams,
			serialize: (value) => value,
		},
		publication: createRepositoryChangePublication(adapter),
	});
	type Policy = GitLabMaintainedProcess<GitLabPublicationParams, RepositoryChangeState>;
	const policies: Policy[] = [];
	const maintenance: GitLabMaintenance = {
		register: (policy) => policies.push(policy as unknown as Policy),
		assertOwnership: async () => {},
		ownsProcess: (id) => policies.some((policy) => policy.processId === id),
	};
	const capabilities = createCapabilityAccessor([{ token: gitlabMaintenance, value: maintenance }]);
	adapter.maintenance?.register({ ...createToolCollector().api, ...capabilities }, process);
	const policy = policies[0];
	if (!policy) throw new Error("Publication maintenance was not registered");
	const binding = { projectKey, profile: "team", projectId, iid: 1 };
	const params: GitLabPublicationParams = {
		owner: "team",
		repo: "repository",
		workBranch: mr.source_branch,
		baseBranch: "main",
		gitlabProfile: "team",
		projectId: 7,
		origin: "ui",
	};
	let state = patchPublicationState(process.stateCodec.parse({}), selectedNamespace, {
		headSha: "head",
		prNumber: 1,
		prUrl: mr.web_url,
		ciRecoveryCycles: cycles,
		pipeline: { id: 10, number: 10, project_id: projectId, sha: "head", status: "failed" },
		delivery: { stage: "awaiting", issueLinked: true },
	});
	if (coordinated)
		state = patchPublicationState(state, `${namespace}:${otherKey}`, {
			headSha: "other-head",
			prNumber: 2,
			ciRecoveryCycles: 2,
			conversationCursor: 100,
			feedbackIds: [{ kind: "inline", id: 101, discussionId: "pending-review" }],
			delivery: { stage: "awaiting" },
		});
	const context: GitLabMaintenanceContext<GitLabPublicationParams, RepositoryChangeState> = {
		process: createTestProcessInstance({
			processId: process.id,
			selectedTurnId: "deliver_change",
			lifecycleStatus: "waiting",
			currentExecution: null,
		}),
		projects: [],
		params,
		state,
		now: 0,
		signal: new AbortController().signal,
		externalWrites: bindExternalWrites(createInMemoryExternalWriteLog(), "process"),
		async callIntegrationTool() {
			throw new Error("Routing must not perform external writes");
		},
	};
	const pipeline = {
		id: 10,
		project_id: projectId,
		sha: "head",
		status: "failed",
		ref: mr.source_branch,
		web_url: "https://forge.test/a/-/pipelines/10",
	};
	const observation: GitLabDeliveryObservation = {
		mr: {
			...mr,
			project_id: projectId,
			source_project_id: projectId,
			target_project_id: projectId,
		},
		pipeline,
	};
	return {
		pipeline,
		observation,
		otherPublication: () => readPublicationState(state, `${namespace}:${otherKey}`),
		observe(observed: GitLabDeliveryObservation) {
			const decision = policy.observe({ ...context, state }, binding, observed);
			state = decision.state;
			return {
				action: decision.action,
				publication: readPublicationState(state, selectedNamespace),
				selectedRepository: policy.currentBinding?.({ ...context, state }),
			};
		},
	};
}

it("routes an observed running-to-failed retry of a handled pipeline to another CI repair", () => {
	const f = fixture();
	expect(f.observe(f.observation).action).toBeUndefined();
	expect(
		f.observe({ ...f.observation, pipeline: { ...f.pipeline, status: "running" } }),
	).toMatchObject({ action: undefined, publication: { ciRecoveryCycles: 1 } });
	expect(f.observe(f.observation)).toMatchObject({
		action: "maintenance_ci",
		publication: { ciRecoveryCycles: 2, pipeline: { number: 10, status: "failed" } },
	});
});

it("routes a distinct failed pipeline on the same revision to another CI repair", () => {
	const f = fixture();
	expect(f.observe(f.observation).action).toBeUndefined();
	expect(f.observe({ ...f.observation, pipeline: { ...f.pipeline, id: 11 } })).toMatchObject({
		action: "maintenance_ci",
		publication: { ciRecoveryCycles: 2, pipeline: { number: 11, status: "failed" } },
	});
});

describe.each(["repo_1", "repo_2"] as const)("coordinated CI budget for %s", (projectKey) => {
	it("routes feedback without spending CI budget or changing the other repository", () => {
		const f = fixture({ cycles: 2, projectKey });
		const other = structuredClone(f.otherPublication());
		expect(
			f.observe({
				...f.observation,
				feedback: [
					{
						id: 201,
						discussionId: "review",
						body: "Improve the documentation",
						author: "developer",
						createdAt: new Date(0).toISOString(),
					},
				],
			}),
		).toMatchObject({
			action: "maintenance_feedback",
			selectedRepository: projectKey,
			publication: {
				ciRecoveryCycles: 2,
				conversationCursor: 0,
				feedbackIds: [{ kind: "inline", id: 201, discussionId: "review" }],
			},
		});
		expect(f.otherPublication()).toEqual(other);
	});

	it.each([
		[0, 1, "maintenance_ci"],
		[1, 2, "maintenance_ci"],
		[2, 3, "maintenance_ci"],
		[3, 3, "maintenance_operator"],
	] as const)("routes a failure after %i repairs with budget %i to %s", (cycles, expectedCycles, action) => {
		const f = fixture({ cycles, projectKey });
		const other = structuredClone(f.otherPublication());
		expect(f.observe({ ...f.observation, pipeline: { ...f.pipeline, id: 11 } })).toMatchObject({
			action,
			selectedRepository: projectKey,
			publication: { ciRecoveryCycles: expectedCycles, headSha: "head" },
		});
		// Routing one repository cannot consume another's feedback or repair budget.
		expect(f.otherPublication()).toEqual(other);
	});
});
