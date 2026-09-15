import type { AppContext } from "@leitwerk-dev/server";

type AcceptedLlmTurnFixtureInput = Parameters<AppContext["deps"]["turnRecords"]["create"]>[0] & {
	id: string;
	turnType: "llm";
};

export function createAcceptedLlmTurn(
	ctx: AppContext | null,
	input: AcceptedLlmTurnFixtureInput,
	piResourceSnapshotDigest = "system-fixture-digest",
) {
	if (!ctx) throw new Error("Server context not initialized");
	const running = input.status === "running";
	const lease = ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_fixture_${input.id}`,
		state: running ? "busy" : "exited",
	});
	const start = ctx.deps.turnStarts.create({
		id: `tsr_fixture_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.id,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: input.modelProfileId ?? "test",
					providerId: "test",
					modelId: "test",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest,
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: input.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const turnRecord = ctx.deps.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (running) {
		ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return turnRecord;
}
