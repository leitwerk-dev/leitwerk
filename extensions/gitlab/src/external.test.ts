import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import type { GitLabClientLike, GitLabFeedback, GitLabObservation } from "./client.js";
import { createGitLabProvider, GITLAB_MR_KIND, observationKey } from "./external.js";
import { mr } from "./merge-request.test-fixture.js";

it("debounces comments on unchanged green CI, resets for new arrivals and resumes after restart", async () => {
	let time = 10_000;
	const notes: GitLabFeedback[] = [
		{
			id: 1,
			discussionId: "thread",
			body: "Please adjust",
			author: "alice",
			createdAt: new Date(time).toISOString(),
		},
	];
	const observation: GitLabObservation = {
		mr: {
			...mr,
			source_branch: "upgrade",
			web_url: "https://forge.test/mr/1",
		},
		pipeline: {
			id: 1,
			project_id: 7,
			sha: "head",
			ref: "upgrade",
			status: "success",
			web_url: "https://forge.test/pipelines/1",
		},
	};
	const armed = {
		id: "observe",
		instanceId: "process",
		resolved: {
			profile: "test",
			projectId: 7,
			iid: 1,
			afterKey: observationKey(observation),
			pollInterval: "1s",
			feedback: { afterId: 0, quietPeriodMs: 120_000 },
		},
	};
	const fire = vi.fn(async () => ({ ok: true }));
	const deps = createTestServerSetupCapability({
		externalSources: {
			listArmed: (kind: string) => (kind === GITLAB_MR_KIND ? [armed] : []),
			fire,
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const client = {
		getMergeRequest: async () => observation.mr,
		listMergeRequestPipelines: async () => [observation.pipeline],
		getPipeline: async () => observation.pipeline,
		listMergeRequestFeedback: async () => structuredClone(notes),
	} as unknown as GitLabClientLike;
	const create = () =>
		createGitLabProvider(
			deps,
			{ profiles: () => ["test"], client: () => client },
			{ now: () => time },
		);
	let provider = create();
	expect((await provider.poll()).errors).toEqual([]);
	expect(fire).not.toHaveBeenCalled();
	time = 100_000;
	notes.push({
		discussionId: "thread",
		body: "And this",
		author: "alice",
		id: 2,
		createdAt: new Date(time).toISOString(),
		path: "settings.gradle.kts",
		line: 1,
	});
	await provider.poll();
	provider = create();
	time = 219_999;
	await provider.poll();
	expect(fire).not.toHaveBeenCalled();
	time = 221_000;
	await provider.poll();
	expect(fire).toHaveBeenCalledTimes(1);
	expect(fire).toHaveBeenLastCalledWith(
		expect.objectContaining({ mergeKey: expect.stringContaining(":1,2") }),
	);
	armed.resolved.feedback.afterId = 2;
	provider = create();
	time += 121_000;
	await provider.poll();
	expect(fire).toHaveBeenCalledTimes(1);
});
