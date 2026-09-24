import type { ResolvedTurnStart } from "@leitwerk-dev/domain";
import type { AppContext } from "../app.js";

/** @internal */
type AcceptedTurnRepos = Pick<
	AppContext["deps"],
	"processes" | "turnRecords" | "turnStarts" | "leases"
>;

/** @internal */
type AcceptedTurnContext = {
	/** @internal */
	deps: AcceptedTurnRepos;
};

/** Compatibility name for existing LLM fixtures. @internal */
export const createAcceptedLlmTurn = createAcceptedWorkerTurn;
/** Compatibility name for existing LLM starts. @internal */
export const createAcceptedLlmTurnStart = createAcceptedWorkerTurnStart;

/** @internal */
export function createAcceptedWorkerTurn(
	ctx: AcceptedTurnContext | null,
	input: Parameters<AcceptedTurnRepos["turnRecords"]["create"]>[0] & {
		/** @internal */
		id: string;
		/** @internal */
		turnType: "llm" | "automatic";
	},
	options: Parameters<typeof createAcceptedWorkerTurnStart>[3] & {
		/** @internal */
		current?: boolean;
		/** @internal */
		workerId?: string;
	} = {},
) {
	if (!ctx) throw new Error("Server context not initialized");
	const { deps: repos } = ctx;
	const current = options.current ?? input.status === "running";
	const lease = repos.leases.create({
		instanceId: input.instanceId,
		workerId: options.workerId ?? `wkr_${input.id}`,
		state: current ? (input.status === "failed" ? "failed" : "busy") : "exited",
	});
	const start = createAcceptedWorkerTurnStart(ctx, input, lease.id, options);
	const record = repos.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (current) {
		repos.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		repos.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return record;
}

/** @internal */
function createAcceptedWorkerTurnStart(
	ctx: AcceptedTurnContext,
	input: {
		/** @internal */
		turnType?: "llm" | "automatic";
		/** @internal */
		id: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		turnId: string;
	},
	acceptedWorkerLeaseId: string,
	options: {
		/** @internal */
		id?: string;
		/** @internal */
		preparedStart?: Extract<ResolvedTurnStart, { kind: "llm" }>;
		/** @internal */
		model?: {
			/** @internal */
			profileId: string;
			/** @internal */
			providerId: string;
			/** @internal */
			modelId: string;
			/** @internal */
			thinkingLevel: "off";
		};
		/** @internal */
		piResourceSnapshotDigest?: string;
		/** @internal */
		workerRuntimeProfileId?: string;
	} = {},
) {
	return ctx.deps.turnStarts.create({
		id: options.id ?? `tsr_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: input.turnType ?? "llm",
		proposedTurnRecordId: input.id,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start:
				input.turnType === "automatic"
					? { kind: "automatic" }
					: (options.preparedStart ?? {
							kind: "llm",
							model: options.model ?? {
								profileId: "fixture-profile",
								providerId: "fixture-provider",
								modelId: "fixture-model",
								thinkingLevel: "off",
							},
							providerOptions: {},
							providerWorkerConfig: null,
							piResourceSnapshotDigest:
								options.piResourceSnapshotDigest ?? "fixture-resource-digest",
							workerRuntimeProfileId: options.workerRuntimeProfileId ?? "local",
							piSettings: {},
						}),
			turnRecordId: input.id,
			acceptedWorkerLeaseId,
		},
	});
}
