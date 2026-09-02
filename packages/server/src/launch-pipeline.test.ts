import { describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createLaunchPipeline } from "./launch-pipeline.js";

function fixture() {
	const repos = createAllRepos(createInMemoryDatabase());
	const broadcaster = { sendDurable: vi.fn() } as never;
	return {
		repos,
		broadcaster,
		pipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
	};
}

function process(repos: ReturnType<typeof createAllRepos>) {
	return repos.processes.create({
		processId: "demo",
		selectedTurnId: null,
		lifecycleStatus: "completed",
	});
}

describe("LaunchPipeline", () => {
	it("opens idempotently and runs ordered preparation before commit", async () => {
		const { pipeline, repos, broadcaster } = fixture();
		const first = pipeline.open({
			launcherId: "demo.ui",
			idempotencyKey: "launch:1",
			origin: "ui",
		});
		const second = pipeline.open({
			launcherId: "demo.ui",
			idempotencyKey: "launch:1",
			origin: "ui",
		});
		const calls: string[] = [];
		const result = await pipeline.run(
			first.launchRunId,
			{},
			{
				async resolve() {
					calls.push("resolve");
					return { kind: "resolved" as const, value: {} };
				},
				preparationChecks() {
					return [
						{
							id: "access",
							label: "Check access",
							async run() {
								calls.push("check");
							},
						},
					];
				},
				async prepare() {
					calls.push("prepare");
					return { ok: true as const, value: {} };
				},
				async commit() {
					calls.push("commit");
					return {
						kind: "committed" as const,
						result: "created",
						process: process(repos),
						startTurnId: null,
						reused: false,
					};
				},
			},
		);

		expect(second).toEqual({ launchRunId: first.launchRunId, existing: true });
		expect(calls).toEqual(["resolve", "check", "prepare", "commit"]);
		expect(result).toMatchObject({ kind: "committed", result: "created" });
		expect(repos.launchRuns.getById(first.launchRunId)).toMatchObject({
			status: "completed",
			steps: expect.arrayContaining([
				expect.objectContaining({ id: "check:access", status: "completed" }),
				expect.objectContaining({ id: "create_process", status: "completed" }),
			]),
		});
		expect(broadcaster.sendDurable).toHaveBeenCalled();
	});

	it("retains a committed process when its reaction fails", async () => {
		const { pipeline, repos } = fixture();
		const opened = pipeline.open({ launcherId: "demo.ui", origin: "ui" });
		const committed = process(repos);
		const result = await pipeline.run(
			opened.launchRunId,
			{},
			{
				async resolve() {
					return { kind: "resolved" as const, value: {} };
				},
				preparationChecks: () => [],
				async prepare() {
					return { ok: true as const, value: {} };
				},
				async commit() {
					return {
						kind: "committed_with_reaction_error" as const,
						result: "reaction_failed",
						process: committed,
						startTurnId: "start",
						safeSummary: "Worker startup failed.",
					};
				},
			},
		);

		expect(result).toMatchObject({
			kind: "committed_with_reaction_error",
			process: { id: committed.id },
		});
		expect(repos.launchRuns.getById(opened.launchRunId)).toMatchObject({
			instanceId: committed.id,
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({
					id: "start_worker",
					status: "failed",
					safeSummary: "Worker startup failed.",
				}),
			]),
		});
	});

	it("maps an unexpected stage exception to the active checklist step", async () => {
		const { pipeline, repos } = fixture();
		const opened = pipeline.open({ launcherId: "demo.ui", origin: "ui" });
		const result = await pipeline.run(
			opened.launchRunId,
			{},
			{
				async resolve() {
					return { kind: "resolved" as const, value: {} };
				},
				preparationChecks: () => [],
				async prepare() {
					throw new Error("secret backend detail");
				},
				async commit() {
					throw new Error("unreachable");
				},
			},
		);

		expect(result.kind).toBe("failed");
		expect(repos.launchRuns.getById(opened.launchRunId)).toMatchObject({
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({
					id: "resolve_models_skills",
					status: "failed",
					safeSummary: "The launch could not be completed. Try again.",
				}),
			]),
		});
	});
});
