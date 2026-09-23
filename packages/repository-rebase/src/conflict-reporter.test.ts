import {
	createExternalSourcePollReporter,
	type ExternalSourceArmingLike,
	type ExternalSourceServiceLike,
} from "@leitwerk-dev/process-sdk";
import { expect, test, vi } from "vitest";
import { conflictKey, createConflictReporter } from "./index.js";

const conflict = {
	owner: "owner",
	repo: "repo",
	prNumber: 1,
	headBranch: "work",
	baseBranch: "main",
	headSha: "a".repeat(40),
	baseSha: "b".repeat(40),
	url: "https://example.test/pr/1",
};
const observation = {
	summary: "Conflict",
	observedAt: "2026-09-21",
	subject: "pr:1",
	revision: conflict.headSha,
};
const armed: ExternalSourceArmingLike = {
	id: "sub",
	instanceId: "process",
	generation: "1",
	resolved: conflict,
	processId: "definition",
	turnId: "turn",
	externalActionId: "action",
	source: { kind: "forge" },
};

test("retries rejected fires, deduplicates accepted pairs and honors persisted keys", async () => {
	let current = armed;
	const fire = vi.fn<ExternalSourceServiceLike["fire"]>(async () => ({ ok: true }));
	fire.mockResolvedValueOnce({ ok: false });
	const observe = vi.fn<NonNullable<ExternalSourceServiceLike["observe"]>>(async () => ({
		ok: true,
	}));
	const sources: ExternalSourceServiceLike = {
		listArmed: () => [current],
		fire,
		observe,
	};
	const report = createExternalSourcePollReporter(sources, { created: [], errors: [] });
	const reportConflict = createConflictReporter("forge");
	expect(await reportConflict(report, armed, conflict, null, observation)).toBe(true);
	expect(await reportConflict(report, armed, conflict, null, observation)).toBe(true);
	expect(await reportConflict(report, armed, conflict, null, observation)).toBe(false);
	expect(
		await createConflictReporter("forge")(
			report,
			armed,
			conflict,
			conflictKey(conflict),
			observation,
		),
	).toBe(false);
	expect(fire.mock.calls).toEqual([
		[
			{
				instanceId: "process",
				armingId: "sub",
				event: { kind: "merge_conflict", conflict },
				mergeKey: JSON.stringify(["owner", "repo", 1, "a".repeat(40), "b".repeat(40)]),
			},
		],
		[
			{
				instanceId: "process",
				armingId: "sub",
				event: { kind: "merge_conflict", conflict },
				mergeKey: JSON.stringify(["owner", "repo", 1, "a".repeat(40), "b".repeat(40)]),
			},
		],
	]);
	expect(observe).toHaveBeenCalledTimes(4);
	for (const [input] of observe.mock.calls) {
		expect(input).toMatchObject({
			instanceId: "process",
			armingId: "sub",
			generation: "1",
			observation: {
				observedAt: "2026-09-21",
				subject: "pr:1",
				revision: "a".repeat(40),
				links: [
					{
						id: "conflicting-pr",
						label: "PR #1",
						url: "https://example.test/pr/1",
						kind: "pull_request",
					},
				],
			},
		});
	}
	current = { ...armed, generation: "2" };
	expect(await reportConflict(report, current, conflict, null, observation)).toBe(true);
	expect(await reportConflict(report, current, conflict, null, observation)).toBe(false);
	expect(fire).toHaveBeenCalledTimes(3);
	expect(fire.mock.calls[2]).toEqual(fire.mock.calls[1]);
	expect(observe).toHaveBeenCalledTimes(6);
	expect(observe.mock.calls.slice(4).map(([input]) => input.generation)).toEqual(["2", "2"]);
});

test("checks freshness again after observation completes", async () => {
	let current = armed;
	let attempts = 0;
	const sources: ExternalSourceServiceLike = {
		listArmed: () => [current],
		fire: async () => {
			attempts++;
			return { ok: true };
		},
		observe: async () => {
			await Promise.resolve();
			current = { ...armed, generation: "2" };
			return { ok: true };
		},
	};
	const report = createExternalSourcePollReporter(sources, { created: [], errors: [] });
	expect(await createConflictReporter("forge")(report, armed, conflict, null, observation)).toBe(
		false,
	);
	expect(attempts).toBe(0);
});
