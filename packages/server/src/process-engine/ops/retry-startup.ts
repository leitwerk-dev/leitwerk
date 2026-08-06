import { generateId } from "../../db/repo-helpers.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { appendProcessEvent, applyProcessPatchField, createWrites } from "../writes/writes.js";

export interface RetryStartupInput {
	instanceId: string;
	startRecordId: string;
	nextTurnModelProfileId?: string | null;
	providerOptions?: Readonly<Record<string, string>>;
}

/** Replaces only the current failed worker start; it never creates a turn attempt. */
export const RetryStartup = defineOperation<
	"retry_startup",
	RetryStartupInput,
	{ startRecordId: string }
>({
	kind: "retry_startup",
	label: "Retry startup",
	decide(ctx, input) {
		if (
			ctx.process.lifecycleStatus !== "error" ||
			ctx.process.currentExecution?.kind !== "worker_start" ||
			ctx.process.currentExecution.id !== input.startRecordId
		) {
			return reject("stale_turn_start", "Startup retry target is no longer current");
		}
		const failed = ctx.deps.turnStarts.getById(input.startRecordId);
		if (
			!failed ||
			(failed.state.kind !== "preparation_failed" && failed.state.kind !== "bootstrap_failed")
		) {
			return reject("retry_target_missing", "Startup retry requires a failed current start");
		}
		const id = generateId("tsr");
		const state =
			failed.state.kind === "bootstrap_failed"
				? { kind: "starting" as const, start: failed.state.start }
				: failed.state;
		const writes = createWrites({
			workerIntent: state.kind === "starting" ? { kind: "restart_worker" } : undefined,
		});
		writes.turnStartWrites.push({
			kind: "create",
			input: {
				id,
				instanceId: failed.instanceId,
				turnId: failed.turnId,
				turnType: failed.turnType,
				proposedTurnRecordId: generateId("trn"),
				startKind: "startup_retry",
				recoveryTurnRecordId: failed.recoveryTurnRecordId,
				continuation: failed.continuation,
				state,
			},
		});
		applyProcessPatchField(writes, ctx.process, "currentExecution", { kind: "worker_start", id });
		applyProcessPatchField(
			writes,
			ctx.process,
			"lifecycleStatus",
			state.kind === "starting" ? "active" : "error",
		);
		appendProcessEvent(writes, ctx.process, {
			eventType: "startup_retry_scheduled",
			level: "info",
			message: "Startup retry scheduled",
			data: { previousStartRecordId: failed.id, startRecordId: id, state: state.kind },
		});
		return accept({
			writes,
			data: { startRecordId: id },
			metadata:
				input.nextTurnModelProfileId !== undefined || input.providerOptions !== undefined
					? {
							...(input.nextTurnModelProfileId !== undefined
								? { nextTurnModelProfileId: input.nextTurnModelProfileId }
								: {}),
							...(input.providerOptions !== undefined
								? { providerOptions: input.providerOptions }
								: {}),
						}
					: undefined,
		});
	},
});
