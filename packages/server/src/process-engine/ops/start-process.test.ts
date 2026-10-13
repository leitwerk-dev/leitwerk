import type { WaitingProcessRestart } from "@leitwerk-dev/process-sdk";
import { expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import { createOwnedTestDeps } from "../../test-helpers/owned-test-deps.js";
import {
	createFixtureHumanTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createProcessEngine } from "../engine.js";
import type { ProcessEngineDeps } from "../types.js";

function fixture() {
	const base = createOwnedTestDeps();
	const definition = createFixtureProcess({
		id: "guarded_restart_process",
		entry: "await_revision",
		turns: {
			await_revision: createFixtureHumanTurn({
				actions: { start: { label: "Start", acceptanceState: "neutral", to: "review" } },
			}),
			review: createFixtureHumanTurn(),
		},
	});
	const deps: ProcessEngineDeps = {
		...base,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createProcessGraphRegistry([definition]),
	};
	const process = deps.processes.create({
		processId: definition.id,
		selectedTurnId: "await_revision",
		lifecycleStatus: "waiting",
		paramsJson: "{}",
		stateJson: '{"sha":"old"}',
	});
	const project = deps.projects.create({
		instanceId: process.id,
		key: "repo",
		repoLocator: "https://code.example.test/team/repo.git",
		baseBranch: "old",
		workBranch: "review",
	});
	const restart: WaitingProcessRestart = {
		expected: {
			turnId: "await_revision",
			paramsJson: process.paramsJson,
			stateJson: process.stateJson,
		},
		stateJson: '{"sha":"new"}',
		project: { key: "repo", expectedBaseBranch: "old", baseBranch: "new" },
	};
	return { deps, process, project, restart };
}

it("commits revision state, repository base, and turn selection together", async () => {
	const f = fixture();
	const engine = createProcessEngine(f.deps);
	expect(await engine.startProcess(f.process.id, "review", { restart: f.restart })).toMatchObject({
		ok: true,
		process: { selectedTurnId: "review", stateJson: f.restart.stateJson },
	});
	expect(f.deps.projects.getByInstanceAndKey(f.process.id, "repo")?.baseBranch).toBe("new");
	expect(await engine.startProcess(f.process.id, "review", { restart: f.restart })).toMatchObject({
		ok: false,
		code: "restart_superseded",
	});
});

it.each([
	{ lifecycleStatus: "active" as const },
	{ lifecycleStatus: "aborted" as const },
	{ selectedTurnId: "review" },
	{ stateJson: '{"sha":"manual"}' },
	{ paramsJson: '{"changed":true}' },
])("rejects a superseded waiting snapshot without writes: %j", async (patch) => {
	const f = fixture();
	f.deps.processes.update(f.process.id, patch);
	const before = f.deps.processes.getById(f.process.id);
	expect(
		await createProcessEngine(f.deps).startProcess(f.process.id, "review", { restart: f.restart }),
	).toMatchObject({ ok: false, code: "restart_superseded" });
	expect(f.deps.processes.getById(f.process.id)).toEqual(before);
	expect(f.deps.projects.getByInstanceAndKey(f.process.id, "repo")?.baseBranch).toBe("old");
});

it("rejects a changed repository base without changing revision state or position", async () => {
	const f = fixture();
	f.deps.projects.update(f.project.id, { baseBranch: "manual" });
	expect(
		await createProcessEngine(f.deps).startProcess(f.process.id, "review", { restart: f.restart }),
	).toMatchObject({ ok: false, code: "restart_superseded" });
	expect(f.deps.processes.getById(f.process.id)?.stateJson).toBe(f.process.stateJson);
	expect(f.deps.processes.getById(f.process.id)?.selectedTurnId).toBe("await_revision");
	expect(f.deps.projects.getByInstanceAndKey(f.process.id, "repo")?.baseBranch).toBe("manual");
});

it("rolls back revision and repository changes when recording fails", async () => {
	const f = fixture();
	let recorded = false;
	const engine = createProcessEngine({
		...f.deps,
		transaction: ((callback: Parameters<typeof f.deps.transaction>[0]) =>
			f.deps.transaction((repos) => {
				callback(repos);
				recorded = true;
				throw new Error("injected recording failure");
			})) as typeof f.deps.transaction,
	});
	expect(await engine.startProcess(f.process.id, "review", { restart: f.restart })).toMatchObject({
		ok: false,
	});
	expect(recorded).toBe(true);
	expect(f.deps.processes.getById(f.process.id)?.stateJson).toBe(f.process.stateJson);
	expect(f.deps.processes.getById(f.process.id)?.selectedTurnId).toBe("await_revision");
	expect(f.deps.projects.getByInstanceAndKey(f.process.id, "repo")?.baseBranch).toBe("old");
});
