import {
	createExternalSourcePollReporter,
	type ExternalSourceArmingLike,
	type ExternalSourceServiceLike,
} from "@leitwerk-dev/process-sdk";
import { expect, test } from "vitest";
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
	let attempts = 0;
	let observations = 0;
	const sources: ExternalSourceServiceLike = {
		listArmed: () => [armed],
		fire: async () => ({ ok: ++attempts > 1 }),
		observe: async () => {
			observations++;
			return { ok: true };
		},
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
	expect(attempts).toBe(2);
	expect(observations).toBe(4);
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
