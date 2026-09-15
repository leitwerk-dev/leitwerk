import type { CoreServerSetupDeps, WatcherLaunchResultLike } from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoClient } from "./client.js";
import {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	type ForgejoFeedbackSourceConfig,
} from "./external.js";
import { forgejoIssueWatcherSource } from "./issue-watcher.js";
import { createForgejoProvider, matchesConfiguredRepository } from "./provider.js";

afterEach(() => {
	vi.useRealTimers();
});

function watcherLaunchResult(error: string | null = null): WatcherLaunchResultLike {
	return {
		launchRunId: "lnr_test",
		process: { id: "agt_test" } as WatcherLaunchResultLike["process"],
		error,
	};
}

function providerFixture(input: {
	armedByKind: Record<string, unknown[]>;
	client: Partial<ForgejoClient>;
	watchers?: unknown[];
}) {
	const fire = vi.fn(async () => ({ ok: true }));
	const listBySource = vi.fn(() => input.watchers ?? []);
	const startWatcher = vi.fn(async () => watcherLaunchResult());
	const deps = createTestServerSetupCapability({
		externalSources: {
			listArmed: (kind: string) => input.armedByKind[kind] ?? [],
			fire,
		},
		processWatchers: { listBySource },
		launchRuns: { startWatcher },
	} as unknown as Partial<CoreServerSetupDeps>);
	const integration = {
		profiles: () => ["default"],
		client: () => input.client as ForgejoClient,
	} satisfies ForgejoIntegration;
	return {
		provider: createForgejoProvider(deps, integration),
		fire,
		listBySource,
		startWatcher,
	};
}

it.each([
	[["team/notebook"], [], "team/notebook", true],
	[["team/notebook"], [], "team/service", false],
	[[], ["team/notebook"], "team/notebook", false],
	[[], ["team/notebook"], "team/service", true],
	[["team/notebook"], ["team/notebook"], "team/notebook", false],
] as const)("matches repository filters %j / %j for %s: %s", (include, exclude, full_name, expected) => {
	expect(
		matchesConfiguredRepository(
			{ repositories: { include: [...include], exclude: [...exclude] } },
			{ full_name } as never,
		),
	).toBe(expected);
});

describe("createForgejoProvider", () => {
	const profile = { baseUrl: "https://git.example.test", token: "secret", botLogin: "leitwerk" };
	const feedbackArming = (overrides: Partial<ForgejoFeedbackSourceConfig> = {}) => ({
		id: "feedback-arm",
		instanceId: "process-1",
		resolved: {
			profile: "primary",
			owner: "team",
			repo: "repo",
			prNumber: 8,
			conversationCursor: 0,
			reviewCursor: 0,
			inlineCursor: 0,
			quietPeriodMs: 120_000,
			pollInterval: "1s",
			...overrides,
		},
	});
	const repository = {
		id: 1,
		name: "service",
		full_name: "team/service",
		ssh_url: "ssh://git@example.test/team/service.git",
		html_url: "https://git.example.test/team/service",
		default_branch: "main",
		owner: { login: "team" },
	};
	const issue = {
		number: 42,
		title: "Change it",
		body: null,
		state: "open",
		html_url: "https://git.example.test/team/service/issues/42",
		updated_at: "2026-08-11T00:00:00Z",
		user: { login: "alice" },
		labels: [{ id: 1, name: "use-leitwerk" }],
	};
	const watcher = {
		processId: "forgejo_repo_change_process",
		watcherId: "use_leitwerk",
		enabled: true,
		config: {
			profile: "primary",
			pollInterval: "1s",
			labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
		},
		launchModelConfig: { defaultModelProfileId: null, turnConfigs: {} },
	};
	const discoveryFixture = () =>
		providerFixture({
			armedByKind: {},
			watchers: [watcher],
			client: {
				listRepositories: vi.fn(async () => [repository]),
				listOpenIssues: vi.fn(async () => [issue]),
			},
		});

	it("delegates discovered work to the typed issue watcher's launch coordinator", async () => {
		const { provider, listBySource, startWatcher } = discoveryFixture();

		const result = await provider.poll();

		expect(listBySource).toHaveBeenCalledWith(forgejoIssueWatcherSource);
		expect(startWatcher).toHaveBeenCalledWith(
			expect.objectContaining({
				processId: "forgejo_repo_change_process",
				watcherId: "use_leitwerk",
			}),
			{
				profile: "primary",
				repository,
				issue,
				labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
			},
			{ idempotencyKey: "forgejo:team/service#42" },
		);
		expect(result.created).toEqual(["forgejo:team/service#42"]);
	});

	it("preserves process launch failure details in the poll result", async () => {
		const { provider, startWatcher } = discoveryFixture();
		startWatcher.mockResolvedValueOnce(watcherLaunchResult("Process startup failed."));

		const result = await provider.poll();

		expect(result.created).toEqual([]);
		expect(result.errors).toEqual(["forgejo:team/service#42:Process startup failed."]);
	});

	it("debounces unseen human feedback, excludes the bot, and advances independent cursors", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-10T12:05:00Z"));
		const armed = feedbackArming({ conversationCursor: 10, reviewCursor: 20, inlineCursor: 30 });
		const { provider, fire } = providerFixture({
			armedByKind: { [FORGEJO_PR_FEEDBACK_KIND]: [armed] },
			client: {
				profile,
				listPullRequestFeedback: vi.fn(async () => [
					{
						kind: "conversation",
						id: 11,
						body: "bot",
						author: "leitwerk",
						createdAt: "2026-08-10T12:01:00Z",
					},
					{
						kind: "review",
						id: 21,
						body: "review",
						author: "alice",
						createdAt: "2026-08-10T12:02:00Z",
					},
					{
						kind: "inline",
						id: 32,
						body: "inline",
						author: "bob",
						createdAt: "2026-08-10T12:03:00Z",
					},
				]),
			},
		});

		const result = await provider.poll();

		expect(result.errors).toEqual([]);
		expect(fire).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "process-1",
				armingId: "feedback-arm",
				event: {
					feedbackIds: [
						{ kind: "review", id: 21 },
						{ kind: "inline", id: 32 },
					],
					cursors: {
						conversationCursor: 10,
						reviewCursor: 21,
						inlineCursor: 32,
					},
				},
			}),
		);
	});

	it("keeps a feedback batch armed until the two-minute quiet period expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-10T12:05:00Z"));
		const { provider, fire } = providerFixture({
			armedByKind: { [FORGEJO_PR_FEEDBACK_KIND]: [feedbackArming()] },
			client: {
				profile,
				listPullRequestFeedback: vi.fn(async () => [
					{
						kind: "review",
						id: 2,
						body: "new",
						author: "alice",
						createdAt: "2026-08-10T12:04:30Z",
					},
				]),
			},
		});

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});

	it("fires cancellation when the source issue loses the trigger label", async () => {
		const { provider, fire } = providerFixture({
			armedByKind: {
				[FORGEJO_ISSUE_CANCELLED_KIND]: [
					{
						id: "issue-arm",
						instanceId: "process-1",
						resolved: {
							profile: "primary",
							owner: "team",
							repo: "repo",
							issueNumber: 4,
							triggerLabel: "use-leitwerk",
							pollInterval: "1s",
						},
					},
				],
			},
			client: {
				getIssue: vi.fn(
					async () =>
						({
							number: 4,
							state: "open",
							labels: [],
							title: "Change",
						}) as never,
				),
			},
		});

		await provider.poll();

		expect(fire).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({ reason: "trigger_label_removed" }),
				mergeKey: "4:trigger_label_removed",
			}),
		);
	});
});
