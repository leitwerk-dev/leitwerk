import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSkillInvocations } from "./invocation-detector.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill invocation detector", () => {
	it("records timestamped reads only from the managed agent directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-invocations-"));
		roots.push(root);
		const snapshot = path.join(root, "session.jsonl");
		await writeFile(
			snapshot,
			[
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "read",
								arguments: { path: "/managed/agt_1/lease_1/skills/review/SKILL.md" },
							},
						],
					},
				},
				{
					timestamp: "2026-01-02T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "read",
								arguments: {
									file_path: "/workspace/.leitwerk/skills/review/SKILL.md",
								},
							},
							{
								type: "toolCall",
								name: "read",
								arguments: {
									path: "/managed/agt_1/lease_1/skills/review/references/rules.md",
								},
							},
						],
					},
				},
				{
					timestamp: "2026-01-03T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "read",
								arguments: { path: "/managed/agt_1/lease_1/skills/plan/SKILL.md" },
							},
						],
					},
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		expect(
			await detectSkillInvocations(snapshot, {
				since: "2026-01-01T12:00:00.000Z",
				managedAgentDir: { instanceId: "agt_1", leaseId: "lease_1" },
			}),
		).toEqual([{ skillId: "plan", invokedAt: "2026-01-03T00:00:00.000Z" }]);
	});
});
