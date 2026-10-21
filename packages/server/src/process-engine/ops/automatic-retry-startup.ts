import type { AutomaticStartupRecoverySummary } from "@leitwerk-dev/domain";
import { automaticStartupRecovery, startupRetryState } from "../../startup-retry-policy.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { RetryStartup } from "./retry-startup.js";

/** @internal */
export const AutomaticRetryStartup = defineOperation<
	"automatic_retry_startup",
	{
		instanceId: string;
		startRecordId: string;
		availabilityCause?: "availability_transition" | "startup_reconciliation";
	},
	AutomaticStartupRecoverySummary
>({
	kind: "automatic_retry_startup",
	label: "Automatic startup recovery",
	admission: "new_turn",
	async decide(ctx, input) {
		if (
			ctx.process.lifecycleStatus !== "error" ||
			ctx.process.currentExecution?.kind !== "worker_start" ||
			ctx.process.currentExecution.id !== input.startRecordId
		)
			return reject("stale_turn_start", "Startup recovery target is no longer current");
		const start = ctx.deps.turnStarts.getById(input.startRecordId);
		if (
			!start ||
			(start.state.kind !== "preparation_failed" && start.state.kind !== "bootstrap_failed")
		)
			return reject(
				"retry_target_missing",
				"Automatic recovery requires an unaccepted failed start",
			);
		const retry =
			start.state.automaticRetry ??
			startupRetryState(
				start,
				ctx.deps.turnStarts.listByInstance(ctx.process.id),
				ctx.deps.events.listByInstanceEventTypes(ctx.process.id, ["startup_retry_scheduled"], -1),
			);
		let modelRestored = false;
		if (input.availabilityCause && start.state.kind === "preparation_failed") {
			const evaluation = ctx.deps.processModelPolicy.evaluate({
				kind: "preparation_recovery",
				cause: input.availabilityCause,
				process: ctx.process,
				currentStart: start,
				availability: ctx.deps.getModelAvailabilitySnapshot(),
			});
			modelRestored = evaluation.ok && evaluation.selection !== null;
		}
		const summary = automaticStartupRecovery(start, retry, Date.now(), modelRestored);
		if (summary.status !== "ready") {
			if (start.state.automaticRetry && retry.nextRetryAt === summary.nextRetryAt)
				return accept({ data: summary });
			const metadata = { ...retry, nextRetryAt: summary.nextRetryAt };
			return accept({
				data: summary,
				writes: {
					turnStartWrites: [
						{
							kind: "cas_state",
							id: start.id,
							expectedKind: start.state.kind,
							state: { ...start.state, automaticRetry: metadata },
						},
					],
					// Refresh the recovery projection only when retained metadata changes.
					processPatch: { currentExecution: ctx.process.currentExecution },
					changedFields: ["currentExecution"],
				},
			});
		}
		const decision = await RetryStartup.decide(ctx, {
			...input,
			automaticRetry: { ...retry, starts: retry.starts + 1, nextRetryAt: null },
		});
		if (!decision.ok) return reject(decision.code, decision.message);
		return accept({
			writes: decision.writes,
			metadata: decision.metadata,
			data: {
				...summary,
				starts: retry.starts + 1,
				status: "retried",
				nextRetryAt: null,
				reason: "Worker startup retry requested.",
			},
		});
	},
});
