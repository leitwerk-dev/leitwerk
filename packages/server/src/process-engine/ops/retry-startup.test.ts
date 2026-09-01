import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import type { DecideContext, ProcessEngineDeps } from "../types.js";
import { RetryStartup } from "./retry-startup.js";

function setup(kind: "bootstrap_failed" | "preparation_failed") {
	const base = createTestDeps();
	const deps: ProcessEngineDeps = {
		...base,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
	};
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "error",
	});
	const start = deps.turnStarts.create({
		id: "tsr_old",
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "llm",
		proposedTurnRecordId: "trn_old",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state:
			kind === "bootstrap_failed"
				? {
						kind,
						start: {
							kind: "llm",
							model: { profileId: "p", providerId: "openai", modelId: "gpt", thinkingLevel: "low" },
							providerOptions: {},
							providerWorkerConfig: null,
							piResourceSnapshotDigest: "d",
							workerRuntimeProfileId: "local",
							piSettings: {},
						},
						failedWorkerLeaseId: null,
						code: "x",
						safeSummary: "x",
					}
				: {
						kind,
						requestedModelProfileId: "p",
						providerOptions: {},
						code: "model_unavailable",
						safeSummary: "x",
					},
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	return {
		deps,
		process,
		context: (): DecideContext => ({
			deps,
			instanceId: process.id,
			process: deps.processes.getById(process.id) ?? process,
		}),
	};
}

describe("RetryStartup", () => {
	it("replaces an LLM bootstrap failure with latest-resource preparation without an attempt", () => {
		const s = setup("bootstrap_failed");
		const d = RetryStartup.decide(s.context(), {
			instanceId: s.process.id,
			startRecordId: "tsr_old",
		});
		expect(d).toMatchObject({ ok: true });
		if (!d.ok) return;
		expect(d.writes.turnStartWrites).toHaveLength(1);
		expect(d.writes.turnStartWrites[0]).toMatchObject({
			kind: "create",
			input: {
				startKind: "startup_retry",
				state: {
					kind: "preparation_failed",
					requestedModelProfileId: "p",
					providerOptions: {},
					code: "model_required",
				},
			},
		});
		expect(d.writes.turnStartWrites[0]).not.toHaveProperty(
			"input.state.start.piResourceSnapshotDigest",
		);
		expect(d.writes.turnRecordWrites).toEqual([]);
		expect(d.writes.processPatch.lifecycleStatus ?? "error").toBe("error");
	});
	it("keeps preparation retry in error and rejects stale IDs", () => {
		const s = setup("preparation_failed");
		const d = RetryStartup.decide(s.context(), {
			instanceId: s.process.id,
			startRecordId: "tsr_old",
		});
		expect(d).toMatchObject({ ok: true });
		if (d.ok) expect(d.writes.processPatch.lifecycleStatus ?? "error").toBe("error");
		expect(
			RetryStartup.decide(s.context(), { instanceId: s.process.id, startRecordId: "other" }),
		).toMatchObject({ ok: false, code: "stale_turn_start" });
	});
});
