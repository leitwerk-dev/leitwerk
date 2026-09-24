import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import type { GitHubIntegration } from "./capability.js";
import type { GitHubClient } from "./client.js";
import { GITHUB_PR_STATE_KIND } from "./external.js";
import { createGitHubProvider } from "./provider.js";

function providerFixture(
	client: Partial<GitHubClient>,
	options: { now?: () => number; revision?: () => string } = {},
) {
	const observe = vi.fn(async (_input: unknown) => ({ ok: true }));
	const fire = vi.fn(async () => ({ ok: true }));
	const deps = createTestServerSetupCapability({
		externalSources: {
			listArmed: (kind: string) =>
				kind === GITHUB_PR_STATE_KIND
					? [
							{
								id: "github-merged",
								generation: options.revision?.() ?? "initial",
								instanceId: "process-1",
								resolved: {
									profile: "public",
									owner: "leitwerk-dev",
									repo: "leitwerk",
									prNumber: 25,
									headSha: options.revision?.() ?? "head-sha",
									feedbackCursor: 0,
									eventKinds: ["merged"],
									pollInterval: "1s",
								},
							},
						]
					: [],
			fire,
			observe,
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const integration = {
		client: () => client as GitHubClient,
	} satisfies GitHubIntegration;
	return { provider: createGitHubProvider(deps, integration, options), fire, observe };
}

describe("createGitHubProvider", () => {
	it("fires a merged pull request even when an unrelated checks query fails", async () => {
		const pullRequest = {
			number: 25,
			title: "Change",
			body: null,
			state: "closed",
			merged: true,
			merge_commit_sha: "merge-sha",
			html_url: "https://github.test/leitwerk-dev/leitwerk/pull/25",
			head: { ref: "change", sha: "head-sha" },
			base: { ref: "main", sha: "base-sha" },
		};
		const getCheckSummary = vi.fn(async () => {
			throw new Error("GitHub GET checks failed with 403");
		});
		const listPullRequestFeedback = vi.fn(async () => []);
		const { provider, fire } = providerFixture({
			profile: {
				apiBaseUrl: "https://api.github.test",
				token: "secret",
				botLogin: "leitwerk",
			},
			getPullRequest: vi.fn(async () => pullRequest),
			getCheckSummary,
			listPullRequestFeedback,
		});

		await provider.poll();

		expect(getCheckSummary).not.toHaveBeenCalled();
		expect(listPullRequestFeedback).not.toHaveBeenCalled();
		expect(fire).toHaveBeenCalledWith({
			instanceId: "process-1",
			armingId: "github-merged",
			generation: "initial",
			event: {
				kind: "merged",
				pullRequest,
			},
			mergeKey: "terminal:25:true",
		});
	});
});

it("observes failure and success across revisions without firing unsubscribed checks", async () => {
	let now = 0;
	let revision = "a";
	let status: "pending" | "failure" | "success" = "pending";
	const { provider, fire, observe } = providerFixture(
		{
			profile: { apiBaseUrl: "https://api.github.test", token: "fixture", botLogin: "bot" },
			getPullRequest: vi.fn(async () => ({
				number: 25,
				title: "Change",
				body: null,
				state: "open",
				merged: false,
				merge_commit_sha: null,
				html_url: "https://github.test/pr/25",
				head: { ref: "change", sha: revision },
				base: { ref: "main", sha: "base" },
			})),
			getCheckSummary: vi.fn(async () => ({
				headSha: revision,
				status,
				total: 1,
				failed:
					status === "failure"
						? [{ name: "Full validation", conclusion: "failure", url: "https://github.test/run/1" }]
						: [],
			})),
		},
		{ now: () => now, revision: () => revision },
	);
	await provider.poll();
	now += 2000;
	status = "failure";
	await provider.poll();
	now += 2000;
	revision = "b";
	status = "pending";
	await provider.poll();
	now += 2000;
	status = "success";
	await provider.poll();
	expect(fire).not.toHaveBeenCalled();
	expect(observe.mock.calls).toHaveLength(4);
	expect(observe.mock.calls[1]?.[0]).toMatchObject({
		generation: "a",
		observation: {
			revision: "a",
			summary: expect.stringContaining("Full validation"),
			links: [
				{
					id: "check-0",
					label: "Full validation",
					url: "https://github.test/run/1",
					kind: "pipeline",
				},
			],
		},
	});
	expect(observe.mock.calls[3]?.[0]).toMatchObject({
		generation: "b",
		observation: { revision: "b", summary: expect.stringContaining("success") },
	});
});
