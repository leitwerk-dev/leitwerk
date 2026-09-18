import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import type { GitHubClientLike } from "../capability.js";
import type { GitHubPullRequest } from "../client.js";
import { registerGitHubTools } from "../tools.js";

export function toolContext(id = "p"): IntegrationToolExecutionContext {
	return {
		process: { id, paramsJson: "{}" },
		project: {
			instanceId: id,
			workBranch: "feature",
			baseBranch: "main",
			metadata: { github: { owner: "team", repo: "one", profile: "first" } },
		},
		idempotencyKey: "retained-pr-key",
		signal: new AbortController().signal,
	} as unknown as IntegrationToolExecutionContext;
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
export function toolFixture() {
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
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector();
	registerGitHubTools(
		api,
		{
			client(profile) {
				profiles.push(profile);
				return client;
			},
		},
		writes,
	);
	return {
		pulls,
		comments,
		requests,
		profiles,
		failure,
		writes,
		tools,
		execute(name: string, args: Record<string, unknown>, ctx = toolContext()) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing tool ${name}`);
			return tool.execute(ctx, args);
		},
	};
}
