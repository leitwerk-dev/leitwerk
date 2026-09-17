import type {
	CoreServerSetupDeps,
	ExternalSourceArmingLike,
	RegisteredProcessWatcherLike,
} from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import type { GitHubClientLike } from "./capability.js";
import {
	GITHUB_CHECKS_KIND,
	GITHUB_ISSUE_CANCELLED_KIND,
	GITHUB_PR_FEEDBACK_KIND,
	GITHUB_PR_TERMINAL_KIND,
} from "./external.js";
import { githubIssueWatcherSource } from "./issue-watcher.js";
import { createGitHubProvider } from "./provider.js";

it("preserves GitHub's distinct-label validation after trimming shared watcher fields", () => {
	const config = {
		type: "github_issue",
		enabled: true,
		profile: " test ",
		poll_interval: " 1h ",
		labels: { trigger: " ready ", done: "ready" },
	};
	expect(() => githubIssueWatcherSource.parseConfig(config)).toThrow(
		"Trigger and done labels must differ",
	);
	const parsed = githubIssueWatcherSource.parseConfig({
		...config,
		labels: { ...config.labels, done: "done" },
	});
	expect(parsed.config).toMatchObject({
		profile: "test",
		pollInterval: "1h",
		labels: { trigger: "ready", done: "done" },
	});
});

function fixture() {
	let now = 180_000;
	let armings: Array<ExternalSourceArmingLike & { kind: string }> = [];
	const issue = { number: 1, state: "open", labels: [{ id: 1, name: "trigger" }] };
	const pr = {
		number: 2,
		state: "open",
		merged: false,
		head: { ref: "feature", sha: "a" },
		base: { ref: "main", sha: "b" },
	};
	const client = {
		profile: { botLogin: "bot" },
		getIssue: vi.fn(async () => structuredClone(issue)),
		getPullRequest: vi.fn(async () => structuredClone(pr)),
		getCheckSummary: vi.fn(async () => ({
			headSha: "a",
			status: "failure",
			total: 1,
			failed: [{ name: "test", url: "https://github.test/check", conclusion: "failure" }],
		})),
		listActionablePullRequestFeedback: vi.fn(async () => [
			{ kind: "conversation", id: 7, createdAt: new Date(0).toISOString() },
			{ kind: "review", id: 3, createdAt: new Date(0).toISOString() },
			{ kind: "inline", id: 4, createdAt: new Date(0).toISOString() },
		]),
	};
	const fire = vi.fn(async () => ({ ok: true }));
	const observe = vi.fn(async () => ({ ok: true }));
	const deps = createTestServerSetupCapability({
		externalSources: {
			listArmed: (kind: string) => armings.filter((a) => a.kind === kind),
			fire,
			observe,
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const provider = createGitHubProvider(
		deps,
		{ client: () => client as unknown as GitHubClientLike },
		{ now: () => now },
	);
	function arm(kind: string, config: Record<string, unknown> = {}) {
		const armed = {
			id: kind,
			kind,
			instanceId: "p",
			generation: "one",
			resolved: {
				profile: "test",
				owner: "leitwerk-dev",
				repo: "test",
				prNumber: 2,
				issueNumber: 1,
				triggerLabel: "trigger",
				headSha: "a",
				pollInterval: "1s",
				...config,
			},
		} as unknown as ExternalSourceArmingLike & { kind: string };
		armings.push(armed);
		return armed;
	}
	return {
		client,
		issue,
		pr,
		fire,
		observe,
		provider,
		arm,
		advance: () => {
			now += 2000;
		},
		replace: () => {
			armings = armings.map((a) => ({
				...a,
				generation: "two",
				resolved: { ...(a.resolved as object), headSha: "new" },
			}));
		},
	};
}
describe("persisted GitHub issue workflow sources", () => {
	it("retains independent feedback cursors, the quiet period, and the original event shape", async () => {
		const f = fixture();
		f.arm(GITHUB_PR_FEEDBACK_KIND, {
			conversationCursor: 7,
			reviewCursor: 0,
			inlineCursor: 2,
			quietPeriodMs: 181_000,
		});
		await f.provider.poll();
		expect(f.fire).not.toHaveBeenCalled();
		f.advance();
		await f.provider.poll();
		expect(f.fire).toHaveBeenCalledWith(
			expect.objectContaining({
				event: {
					feedbackIds: [
						{ kind: "review", id: 3 },
						{ kind: "inline", id: 4 },
					],
					cursors: { conversationCursor: 7, reviewCursor: 3, inlineCursor: 4 },
				},
				mergeKey: "7:3:4",
				generation: "one",
			}),
		);
	});
	it.each([
		GITHUB_CHECKS_KIND,
		GITHUB_PR_FEEDBACK_KIND,
		GITHUB_PR_TERMINAL_KIND,
	])("rejects stale events and observations from %s", async (kind) => {
		const f = fixture();
		f.arm(kind);
		if (kind === GITHUB_PR_TERMINAL_KIND) f.pr.merged = true;
		f.client.getPullRequest.mockImplementation(async () => {
			f.replace();
			return structuredClone(f.pr);
		});
		await f.provider.poll();
		expect(f.fire).not.toHaveBeenCalled();
		expect(f.observe).not.toHaveBeenCalled();
	});
	it("correlates checks with both requested and refreshed PR revisions", async () => {
		const f = fixture();
		f.arm(GITHUB_CHECKS_KIND);
		f.client.getCheckSummary.mockImplementation(async () => {
			f.pr.head.sha = "new";
			return { headSha: "a", status: "failure", total: 1, failed: [] };
		});
		await f.provider.poll();
		expect(f.fire).not.toHaveBeenCalled();
		expect(f.observe).not.toHaveBeenCalled();
	});
	it("records refresh errors without firing checks", async () => {
		const f = fixture();
		f.arm(GITHUB_CHECKS_KIND);
		f.client.getCheckSummary.mockRejectedValue(new Error("Unavailable"));
		const result = await f.provider.poll();
		expect(result.errors).toEqual([expect.stringContaining("Unavailable")]);
		expect(f.observe).toHaveBeenCalledWith(
			expect.objectContaining({ refreshError: "Unavailable", generation: "one" }),
		);
		expect(f.fire).not.toHaveBeenCalled();
	});
	it("gives terminal PRs precedence when a merge closes the issue between reads", async () => {
		const f = fixture();
		f.arm(GITHUB_PR_TERMINAL_KIND);
		f.arm(GITHUB_ISSUE_CANCELLED_KIND);
		f.client.getIssue.mockImplementation(async () => {
			f.pr.merged = true;
			return { ...f.issue, state: "closed" };
		});
		await f.provider.poll();
		expect(f.fire).not.toHaveBeenCalled();
		f.advance();
		await f.provider.poll();
		expect(f.fire).toHaveBeenCalledTimes(1);
		expect(f.fire).toHaveBeenCalledWith(
			expect.objectContaining({ armingId: GITHUB_PR_TERMINAL_KIND }),
		);
	});
	it("does not turn a terminal-read failure into issue cancellation", async () => {
		const f = fixture();
		f.arm(GITHUB_PR_TERMINAL_KIND);
		f.arm(GITHUB_ISSUE_CANCELLED_KIND);
		f.issue.state = "closed";
		f.client.getPullRequest.mockRejectedValue(new Error("Unavailable"));
		await f.provider.poll();
		expect(f.fire).not.toHaveBeenCalled();
	});
});

it.each([
	true,
	false,
])("rechecks membership after launch preparation (authorized=%s)", async (allowed) => {
	let member = true;
	const issue = { number: 1, labels: [{ name: "trigger" }] };
	const resolveLaunchAttempt = vi.fn(async () => ({
		launchConfig: {},
		launchPlan: {},
		preparationChecks: [
			{
				id: "prepare",
				label: "Prepare",
				run: async () => {
					member = allowed;
				},
			},
		],
	}));
	const watcher = {
		sourceId: githubIssueWatcherSource.id,
		processId: "change",
		watcherId: "issues",
		enabled: true,
		config: {
			profile: "test",
			pollInterval: "1s",
			repositories: { include: [], exclude: [] },
			labels: { trigger: "trigger", done: "done" },
		},
		resolveLaunchAttempt,
	};
	const launched = vi.fn();
	const client = {
		listRepositories: async () => [
			{ name: "test", full_name: "leitwerk-dev/test", owner: { login: "leitwerk-dev" } },
		],
		listOpenIssues: async () => [issue],
		authorizedTrigger: vi.fn(async () => (member ? { issue, actor: "member", eventId: 1 } : null)),
	};
	const deps = createTestServerSetupCapability({
		processes: { listAll: () => [] },
		processWatchers: { listBySource: () => [watcher] },
		launchRuns: {
			startWatcher: async (w: RegisteredProcessWatcherLike, event: unknown) => {
				const attempt = await w.resolveLaunchAttempt(event);
				for (const check of attempt?.preparationChecks ?? []) await check.run({} as never);
				launched();
				return { process: { id: "new" }, error: null };
			},
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const result = await createGitHubProvider(deps, {
		client: () => client as unknown as GitHubClientLike,
	}).poll();
	expect(launched).toHaveBeenCalledTimes(allowed ? 1 : 0);
	expect(client.authorizedTrigger).toHaveBeenCalledTimes(2);
	expect(result.errors).toHaveLength(allowed ? 0 : 1);
});
