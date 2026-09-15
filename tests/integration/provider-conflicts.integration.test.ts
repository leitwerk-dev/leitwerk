import { FORGEJO_PR_CONFLICT_KIND, setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { GITHUB_PR_STATE_KIND, setupGitHubIntegration } from "@leitwerk-dev/github";
import type { CoreServerSetupDeps, ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { conflictKey } from "@leitwerk-dev/repository-rebase";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";

for (const provider of ["forgejo", "github"] as const) {
	function fixture() {
		let now = 0;
		const pr = {
			number: 53,
			state: "open",
			merged: false,
			mergeable: false as boolean | null | undefined,
			mergeable_state: "dirty",
			head: { ref: "work", sha: "a".repeat(40) },
			base: { ref: "main", sha: "b".repeat(40) },
			html_url: "https://example.test/owner/repo/pull/53",
		};
		const config = {
			profile: "profile",
			owner: "owner",
			repo: "repo",
			prNumber: 53,
			headSha: pr.head.sha,
			feedbackCursor: 0,
			eventKinds: ["merge_conflict"],
			pollInterval: "30s",
			lastConflictKey: null as string | null,
		};
		const armed = { id: "conflict", instanceId: "process", generation: "one", resolved: config };
		const fire = vi.fn(async (_input: unknown) => ({ ok: true }));
		const observe = vi.fn(async (_input: unknown) => ({ ok: true }));
		const client = {
			getPullRequest: vi.fn(async () => structuredClone(pr)),
			getCommit: vi.fn(async () => ({ sha: "d".repeat(40) })),
			getCheckSummary: vi.fn(async () => {
				throw new Error("checks unavailable");
			}),
			listPullRequestFeedback: vi.fn(async () => {
				throw new Error("feedback unavailable");
			}),
		};
		const sourceKind = provider === "github" ? GITHUB_PR_STATE_KIND : FORGEJO_PR_CONFLICT_KIND;
		const deps = createTestServerSetupCapability({
			externalSources: {
				listArmed: (kind: string) => (kind === sourceKind ? [structuredClone(armed)] : []),
				fire,
				observe,
			},
		} as unknown as Partial<CoreServerSetupDeps>);
		const api = { get: () => deps, provide() {}, tool() {} } as unknown as ServerExtensionAPI;
		const integration = { client: () => client } as never;
		const options = { now: () => now };
		const poller =
			provider === "github"
				? setupGitHubIntegration(api, integration, options)
				: setupForgejoIntegration(api, integration, undefined, options);
		if (!poller) throw new Error("Expected provider registration");
		return {
			pr,
			armed,
			config,
			client,
			fire,
			observe,
			poll: async () => {
				const result = await poller.poll();
				now += 30_000;
				return result;
			},
		};
	}
	describe(`${provider} conflict polling`, () => {
		it("fires confirmed conflicts independently of checks and feedback failures, deduplicating head/base pairs", async () => {
			const f = fixture();
			f.fire.mockResolvedValueOnce({ ok: false });
			await f.poll();
			f.fire.mockClear();
			await f.poll();
			await f.poll();
			expect(f.fire).toHaveBeenCalledTimes(1);
			expect(f.client.getCheckSummary).not.toHaveBeenCalled();
			expect(f.client.listPullRequestFeedback).not.toHaveBeenCalled();
			expect(f.observe).toHaveBeenCalledWith(
				expect.objectContaining({
					observation: expect.objectContaining({ revision: `${f.pr.head.sha}:${f.pr.base.sha}` }),
				}),
			);
			f.pr.base.sha = "c".repeat(40);
			await f.poll();
			expect(f.fire).toHaveBeenCalledTimes(2);
		});
		it("retries unknown or missing mergeability and ignores non-conflicting and terminal PRs", async () => {
			const f = fixture();
			for (const value of [undefined, null, true]) {
				f.pr.mergeable = value;
				f.pr.mergeable_state = provider === "github" ? "blocked" : "behind";
				await f.poll();
			}
			expect(f.fire).not.toHaveBeenCalled();
			f.pr.mergeable = false;
			f.pr.mergeable_state = "dirty";
			f.pr.state = "closed";
			await f.poll();
			expect(f.fire).not.toHaveBeenCalled();
			f.pr.state = "open";
			await f.poll();
			expect(f.fire).toHaveBeenCalledTimes(1);
		});
		it.runIf(provider === "github")(
			"leaves UI-mergeable PRs alone even when head and base differ",
			async () => {
				const f = fixture();
				f.pr.mergeable = true;
				for (const state of ["clean", "unstable", "has_hooks"]) {
					f.pr.mergeable_state = state;
					await f.poll();
				}
				expect(f.fire).not.toHaveBeenCalled();
				expect(f.client.getCommit).not.toHaveBeenCalled();
			},
		);
		it.runIf(provider === "github")(
			"repairs a mergeable PR blocked by the behind merge state using the current base",
			async () => {
				const f = fixture();
				f.pr.mergeable = true;
				f.pr.mergeable_state = "behind";
				await f.poll();
				await f.poll();
				expect(f.fire).toHaveBeenCalledTimes(1);
				expect(f.fire).toHaveBeenCalledWith(
					expect.objectContaining({
						event: {
							kind: "merge_conflict",
							conflict: expect.objectContaining({ reason: "behind", baseSha: "d".repeat(40) }),
						},
					}),
				);
				expect(f.observe).toHaveBeenCalledWith(
					expect.objectContaining({
						observation: expect.objectContaining({
							summary: expect.stringContaining("Pull request behind base"),
							revision: `${f.pr.head.sha}:${"d".repeat(40)}`,
						}),
					}),
				);
				f.client.getCommit.mockResolvedValue({ sha: "e".repeat(40) });
				await f.poll();
				expect(f.fire).toHaveBeenCalledTimes(2);
			},
		);
		it.runIf(provider === "github")(
			"retries unresolved behind metadata and branch refresh failures without firing",
			async () => {
				const f = fixture();
				f.pr.mergeable_state = "behind";
				for (const value of [undefined, null]) {
					f.pr.mergeable = value;
					await f.poll();
				}
				expect(f.client.getCommit).not.toHaveBeenCalled();
				f.pr.mergeable = true;
				f.client.getCommit.mockRejectedValueOnce(new Error("branch unavailable"));
				await f.poll();
				expect(f.fire).not.toHaveBeenCalled();
				await f.poll();
				expect(f.fire).toHaveBeenCalledTimes(1);
			},
		);
		it("rejects a different head and results from a replaced subscription", async () => {
			const f = fixture();
			f.pr.head.sha = "c".repeat(40);
			await f.poll();
			expect(f.fire).not.toHaveBeenCalled();
			f.pr.head.sha = f.config.headSha;
			f.client.getPullRequest.mockImplementationOnce(async () => {
				f.armed.generation = "two";
				return structuredClone(f.pr);
			});
			await f.poll();
			expect(f.fire).not.toHaveBeenCalled();
			await f.poll();
			expect(f.fire).toHaveBeenCalledTimes(1);
		});
		it("retains the last accepted pair across provider restart and reports metadata refresh errors", async () => {
			const f = fixture();
			f.config.lastConflictKey = conflictKey({
				owner: "owner",
				repo: "repo",
				prNumber: 53,
				headBranch: "work",
				baseBranch: "main",
				headSha: f.pr.head.sha,
				baseSha: f.pr.base.sha,
				url: f.pr.html_url,
			});
			await f.poll();
			expect(f.fire).not.toHaveBeenCalled();
			f.client.getPullRequest.mockRejectedValueOnce(new Error("metadata unavailable"));
			await f.poll();
			expect(f.observe).toHaveBeenCalledWith(
				expect.objectContaining({ refreshError: "metadata unavailable" }),
			);
		});
	});
}
