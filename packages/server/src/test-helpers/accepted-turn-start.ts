import type { AppContext } from "../app.js";

export function createAcceptedLlmTurn(
	ctx: AppContext | null,
	input: Parameters<AppContext["deps"]["turnRecords"]["create"]>[0] & {
		id: string;
		turnType: "llm";
	},
	options: Parameters<typeof createAcceptedLlmTurnStart>[3] & {
		current?: boolean;
		workerId?: string;
	} = {},
) {
	if (!ctx) throw new Error("Server context not initialized");
	const current = options.current ?? input.status === "running";
	const lease = ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: options.workerId ?? `wkr_${input.id}`,
		state: current ? (input.status === "failed" ? "failed" : "busy") : "exited",
	});
	const start = createAcceptedLlmTurnStart(ctx, input, lease.id, options);
	const record = ctx.deps.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (current) {
		ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return record;
}

export function createAcceptedLlmTurnStart(
	ctx: AppContext,
	input: { id: string; instanceId: string; turnId: string },
	acceptedWorkerLeaseId: string,
	options: {
		id?: string;
		model?: { profileId: string; providerId: string; modelId: string; thinkingLevel: "off" };
		piResourceSnapshotDigest?: string;
		workerRuntimeProfileId?: string;
	} = {},
) {
	return ctx.deps.turnStarts.create({
		id: options.id ?? `tsr_${input.id}`,
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
				model: options.model ?? {
					profileId: "fixture-profile",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: options.piResourceSnapshotDigest ?? "fixture-resource-digest",
				workerRuntimeProfileId: options.workerRuntimeProfileId ?? "local",
				piSettings: {},
			},
			turnRecordId: input.id,
			acceptedWorkerLeaseId,
		},
	});
}
