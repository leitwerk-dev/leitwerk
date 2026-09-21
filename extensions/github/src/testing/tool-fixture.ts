import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import {
	createExtensionTestHarness,
	type ExtensionToolFixture,
} from "@leitwerk-dev/test-support/process";
import type { GitHubClientLike } from "../capability.js";
import type { GitHubPullRequest } from "../client.js";
import { registerGitHubTools } from "../tools.js";

export function toolFixtureInput(id = "p"): ExtensionToolFixture {
	return {
		id,
		params: {},
		projects: [
			createProjectFixture({
				process: { id },
				key: "one",
				workBranch: "feature",
				baseBranch: "main",
				metadata: { github: { owner: "team", repo: "one", profile: "first" } },
			}),
		],
		invocationId: "retained-pr-key",
	};
}

export const pullRequestArgs = {
	projectKey: "one",
	owner: "attacker",
	repo: "two",
	profile: "other",
	title: "A change",
	body: "Review",
	head: "feature",
	base: "main",
};

/** Stateful provider boundary, with no Git, filesystem, or network. Unexpected calls fail closed. */
export async function toolFixture() {
	const pulls: GitHubPullRequest[] = [];
	const comments: Array<{ body: string }> = [];
	const requests: Array<{ method: string; owner: string; repo: string }> = [];
	const profiles: string[] = [];
	const failure = { create: "none" as "none" | "before" | "after", comment: false };
	const record = (method: string, owner: string, repo: string) =>
		requests.push({ method, owner, repo });
	const methods = {
		profile: { apiBaseUrl: "https://github.invalid", token: "fake", botLogin: "bot" },
		async listPullRequests(owner, repo) {
			record("list", owner, repo);
			return structuredClone(pulls);
		},
		async createPullRequest(owner, repo, input) {
			record("create", owner, repo);
			if (failure.create === "before") throw new Error("create rejected");
			const pr: GitHubPullRequest = {
				number: pulls.length + 1,
				title: input.title,
				body: input.body,
				state: "open",
				merged: false,
				merge_commit_sha: null,
				html_url: "https://github.invalid/team/one/pull/1",
				head: { ref: input.head, sha: "feature-sha" },
				base: { ref: input.base, sha: "base-sha" },
			};
			pulls.push(pr);
			if (failure.create === "after") throw new Error("response lost");
			return structuredClone(pr);
		},
		async listIssueComments(owner, repo) {
			record("comments", owner, repo);
			return structuredClone(comments);
		},
		async addIssueComment(owner, repo, _number, body) {
			record("comment", owner, repo);
			comments.push({ body });
			if (failure.comment) throw new Error("response lost");
			return {};
		},
		async updatePullRequest(owner, repo, number, patch) {
			record("update", owner, repo);
			const pr = pulls.find((p) => p.number === number);
			if (!pr) throw new Error("Unknown PR");
			Object.assign(pr, patch);
			return structuredClone(pr);
		},
	} satisfies Pick<
		GitHubClientLike,
		| "profile"
		| "listPullRequests"
		| "createPullRequest"
		| "listIssueComments"
		| "addIssueComment"
		| "updatePullRequest"
	>;
	const client = new Proxy(methods, {
		get(target, key) {
			if (!(key in target)) throw new Error(`Unexpected provider access: ${String(key)}`);
			return Reflect.get(target, key);
		},
	}) as unknown as GitHubClientLike;
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "github-tools-test", version: "1" },
				setupServer(api) {
					const deps = api.get(coreHostCapabilities.serverSetup);
					if (!deps || Array.isArray(deps)) throw new Error("Missing server setup");
					registerGitHubTools(
						api,
						{
							client(profile) {
								profiles.push(profile);
								return client;
							},
						},
						deps.externalWrites as ExternalWriteLogRepoLike,
					);
				},
			},
		],
	});

	return {
		pulls,
		comments,
		requests,
		profiles,
		failure,
		test,
		execute(name: string, args: Record<string, unknown>, fixture = toolFixtureInput()) {
			return test.callTool(name, args, fixture);
		},
	};
}
