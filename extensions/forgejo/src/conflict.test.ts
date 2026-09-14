import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { conflictKey } from "@leitwerk-dev/repository-rebase";
import { describe, expect, it, vi } from "vitest";
import { FORGEJO_PR_CONFLICT_KIND } from "./external.js";
import { createForgejoProvider } from "./provider.js";

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
		getCheckSummary: vi.fn(async () => {
			throw new Error("checks unavailable");
		}),
		listPullRequestFeedback: vi.fn(async () => {
			throw new Error("feedback unavailable");
		}),
	};
	const deps = {
		polling: {
			create: (options: { pollOnce(): Promise<unknown> }) => ({ poll: options.pollOnce }),
		},
		externalSources: {
			listArmed: (kind: string) =>
				kind === FORGEJO_PR_CONFLICT_KIND ? [structuredClone(armed)] : [],
			fire,
			observe,
		},
	} as unknown as CoreServerSetupDeps;
	const integration = { client: () => client } as never;
	const provider = createForgejoProvider(deps, integration, undefined, { now: () => now });
	return {
		pr,
		armed,
		config,
		client,
		fire,
		observe,
		poll: async () => {
			const result = await provider.poll();
			now += 30_000;
			return result;
		},
	};
}
describe("Forgejo conflict polling", () => {
	it("fires confirmed conflicts independently of checks and feedback failures, deduplicating head/base pairs", async () => {
		const f = fixture();
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
	it("retries unknown or missing mergeability and ignores clean-but-behind and terminal PRs", async () => {
		const f = fixture();
		for (const value of [undefined, null, true]) {
			f.pr.mergeable = value;
			f.pr.mergeable_state = "behind";
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
