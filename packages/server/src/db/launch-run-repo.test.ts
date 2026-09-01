import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

describe("launch run repository", () => {
	it("persists checklist progress with compare-and-set revisions", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const created = repos.launchRuns.create({
			launcherId: "demo.launcher",
			origin: "ui",
			steps: [{ id: "validate", label: "Validate", status: "pending" }],
		});
		expect(created.id).toMatch(/^lnr_/);
		const firstStep = created.steps[0];
		if (!firstStep) throw new Error("Expected launch step");
		const updated = repos.launchRuns.compareAndSet(
			{
				...created,
				steps: [{ ...firstStep, status: "completed" }],
			},
			created.revision,
		);
		expect(updated).toMatchObject({ revision: 1, steps: [{ status: "completed" }] });
		expect(repos.launchRuns.compareAndSet(created, created.revision)).toBeNull();
	});

	it("keeps replay payloads outside the launch read model", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const run = repos.launchRuns.create({ launcherId: "demo", origin: "ui", steps: [] });
		repos.launchRuns.saveReplay(run.id, { launcherInput: { repository: "team/service" } });

		expect(repos.launchRuns.getById(run.id)).not.toHaveProperty("launcherInput");
		expect(repos.launchRuns.getReplay(run.id)).toEqual({
			launcherInput: { repository: "team/service" },
		});
		repos.launchRuns.deleteReplay(run.id);
		expect(repos.launchRuns.getReplay(run.id)).toBeNull();
	});

	it("lists historical attempts for a process", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const process = repos.processes.create({
			processId: "demo",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		const run = repos.launchRuns.create({ launcherId: null, origin: "startup_retry", steps: [] });
		repos.launchRuns.update(run.id, (current) => ({ ...current, instanceId: process.id }));
		expect(repos.launchRuns.listByInstance(process.id)).toHaveLength(1);
	});
});
