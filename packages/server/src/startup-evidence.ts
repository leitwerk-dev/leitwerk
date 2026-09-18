import type {
	LaunchRun,
	ProcessEvent,
	ProcessInstance,
	ProcessTurnRecord,
	TurnStartRecord,
	WorkerLease,
} from "@leitwerk-dev/domain";
import type {
	ProcessStartupSummary,
	StartupAttemptStepSummary,
	StartupAttemptSummary,
	StartupRecoverySummary,
} from "@leitwerk-dev/protocol";
import { completeLaunchWhenReady, failLaunchRun } from "./launch-pipeline.js";

export interface StartupEvidenceInput {
	process: ProcessInstance;
	turnStarts: readonly TurnStartRecord[];
	leases: readonly WorkerLease[];
	turnRecords: readonly ProcessTurnRecord[];
	events?: readonly ProcessEvent[];
}

export interface StartupEvidence {
	attempts: readonly StartupAttemptSummary[];
	currentAttempt: StartupAttemptSummary | null;
	authoritativeAttemptId: string | null;
	recovery: StartupRecoverySummary | null;
}

export type LaunchTitleState =
	| { status: "pending" }
	| { status: "completed" | "skipped" }
	| { status: "failed"; safeSummary?: string };

const STARTUP_STEP_LABELS = {
	start_worker: "Request worker",
	connect_worker: "Start worker",
	prepare_workspace: "Prepare runtime",
	start_first_turn: "Start first turn",
} as const;

function validObservedAt(value: string | null | undefined, notBefore: string): string | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) && time >= Date.parse(notBefore) ? value : null;
}

export function buildStartupRecovery(
	process: ProcessInstance,
	turnStartsById:
		| ReadonlyMap<string, TurnStartRecord>
		| { getById(id: string): TurnStartRecord | null },
): StartupRecoverySummary | null {
	if (process.lifecycleStatus !== "error" || process.currentExecution?.kind !== "worker_start")
		return null;
	const start =
		"getById" in turnStartsById
			? turnStartsById.getById(process.currentExecution.id)
			: turnStartsById.get(process.currentExecution.id);
	if (
		!start ||
		(start.state.kind !== "preparation_failed" && start.state.kind !== "bootstrap_failed")
	)
		return null;
	const resolvedStart = "start" in start.state ? start.state.start : null;
	return {
		startRecordId: start.id,
		kind: start.state.kind,
		action: start.state.kind === "bootstrap_failed" ? "retry_startup" : "choose_model",
		defaultModelProfileId:
			start.state.kind === "preparation_failed"
				? start.state.requestedModelProfileId
				: resolvedStart?.kind === "llm"
					? resolvedStart.model.profileId
					: null,
		providerOptions:
			start.state.kind === "preparation_failed"
				? { ...start.state.providerOptions }
				: resolvedStart?.kind === "llm"
					? { ...resolvedStart.providerOptions }
					: {},
		title:
			start.state.kind === "bootstrap_failed"
				? "Worker startup failed"
				: "Model preparation failed",
		summary: start.state.safeSummary,
	};
}

/** Interprets startup exclusively from durable process, start, lease, and turn evidence. */
export function buildStartupEvidence(input: StartupEvidenceInput): StartupEvidence {
	const orderedStarts = [...input.turnStarts].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
	);
	const turnStartsById = new Map(orderedStarts.map((start) => [start.id, start]));
	const leasesByStartRecordId = new Map(
		input.leases
			.filter((lease) => lease.turnStartRecordId)
			.map((lease) => [lease.turnStartRecordId as string, lease]),
	);
	const leasesById = new Map(input.leases.map((lease) => [lease.id, lease]));
	const turnRecordsById = new Map(input.turnRecords.map((record) => [record.id, record]));
	const firstAcceptedIndex = orderedStarts.findIndex((start) => start.state.kind === "accepted");
	const currentStartId =
		input.process.currentExecution?.kind === "worker_start"
			? input.process.currentExecution.id
			: null;
	const startupStarts = orderedStarts.filter(
		(_start, index) => firstAcceptedIndex < 0 || index <= firstAcceptedIndex,
	);
	const attempts: StartupAttemptSummary[] = startupStarts.map((start, index) => {
		const stateLeaseId =
			start.state.kind === "accepted"
				? start.state.acceptedWorkerLeaseId
				: start.state.kind === "bootstrap_failed"
					? start.state.failedWorkerLeaseId
					: null;
		const lease =
			(stateLeaseId ? leasesById.get(stateLeaseId) : null) ??
			leasesByStartRecordId.get(start.id) ??
			null;
		const connectedAt = lease
			? validObservedAt(lease.connectedAt ?? lease.bootstrapReceipt?.readyAt, lease.startedAt)
			: null;
		const workspaceAt = lease
			? validObservedAt(
					lease.workspacePreparationStartedAt ?? lease.bootstrapReceipt?.readyAt,
					connectedAt ?? lease.startedAt,
				)
			: null;
		const readyAt = lease
			? validObservedAt(
					lease.readyAt ?? lease.bootstrapReceipt?.readyAt,
					workspaceAt ?? lease.startedAt,
				)
			: null;
		const acceptedState = start.state.kind === "accepted" ? start.state : null;
		const acceptedTurnCandidate = acceptedState
			? turnRecordsById.get(acceptedState.turnRecordId)
			: undefined;
		const acceptedTurn =
			acceptedTurnCandidate &&
			acceptedTurnCandidate.turnStartRecordId === start.id &&
			acceptedTurnCandidate.acceptedWorkerLeaseId === acceptedState?.acceptedWorkerLeaseId
				? acceptedTurnCandidate
				: null;
		const firstTurnAt =
			acceptedTurn && readyAt ? validObservedAt(acceptedTurn.startedAt, readyAt) : null;
		const succeeded = Boolean(lease && readyAt && firstTurnAt && start.state.kind === "accepted");
		const failed =
			start.state.kind === "preparation_failed" || start.state.kind === "bootstrap_failed";
		const status: StartupAttemptSummary["status"] = succeeded
			? "succeeded"
			: failed
				? "failed"
				: start.state.kind === "superseded" ||
						input.process.lifecycleStatus === "aborted" ||
						input.process.lifecycleStatus === "completed" ||
						(start.id !== currentStartId && index < startupStarts.length - 1)
					? "superseded"
					: "starting";
		const queued =
			status === "starting" &&
			!lease &&
			input.events?.some(
				(event) =>
					event.eventType === "worker_capacity_queued" && event.data.startRecordId === start.id,
			);
		const queueSummary =
			"Waiting for worker capacity; starts automatically when a slot is available.";
		const failedStepId: StartupAttemptStepSummary["id"] = !lease
			? "start_worker"
			: !connectedAt
				? "connect_worker"
				: !readyAt
					? "prepare_workspace"
					: "start_first_turn";
		const phases = [
			["start_worker", queued ? queueSummary : "Resolve the turn and request its worker."],
			["connect_worker", "Allocate storage, schedule and start the worker, then connect."],
			["prepare_workspace", "Prepare the workspace, tools and model provider."],
			["start_first_turn", "Accept the turn and hand it to the worker."],
		] as const;
		const allocatedAt = lease?.startedAt ?? null;
		const boundaries = [
			start.createdAt,
			allocatedAt,
			lease?.connectedAt ?? null,
			readyAt,
			firstTurnAt,
		];
		const observations = [allocatedAt, connectedAt, readyAt, firstTurnAt];
		const stoppedAt =
			failed || start.state.kind === "superseded"
				? start.updatedAt
				: status === "superseded"
					? (startupStarts[index + 1]?.createdAt ??
						input.process.closedAt ??
						input.process.updatedAt ??
						start.updatedAt)
					: null;
		const steps = phases.map(
			([id, detail], phase): StartupAttemptStepSummary => ({
				id,
				label:
					queued && id === "start_worker" ? "Waiting for worker capacity" : STARTUP_STEP_LABELS[id],
				status: (phase === 0 ? Boolean(lease) : Boolean(observations[phase]))
					? "completed"
					: status === "superseded"
						? "superseded"
						: failed && id === failedStepId
							? "failed"
							: id === failedStepId && status === "starting"
								? "in_progress"
								: "pending",
				occurredAt: observations[phase] ?? null,
				startedAt: boundaries[phase] ?? null,
				endedAt: boundaries[phase + 1] ?? (id === failedStepId ? stoppedAt : null),
				detail,
			}),
		);
		return {
			startRecordId: start.id,
			workerLeaseId: lease?.id ?? null,
			status,
			startedAt: start.createdAt,
			readyAt,
			durationMs:
				lease && readyAt ? Math.max(0, Date.parse(readyAt) - Date.parse(start.createdAt)) : null,
			summary:
				start.state.kind === "preparation_failed" || start.state.kind === "bootstrap_failed"
					? start.state.safeSummary
					: queued
						? queueSummary
						: null,
			recoveredByStartRecordId: null,
			steps,
		};
	});
	const recoveredAttempts = attempts.map((attempt, index) => {
		if (attempt.status !== "failed") return attempt;
		const recoveryAttempt = attempts
			.slice(index + 1)
			.find((candidate) => candidate.status === "succeeded");
		return recoveryAttempt
			? {
					...attempt,
					status: "recovered" as const,
					recoveredByStartRecordId: recoveryAttempt.startRecordId,
				}
			: attempt;
	});
	const authoritative = recoveredAttempts.findLast((attempt) => attempt.status === "succeeded");
	const currentAttempt =
		(currentStartId
			? recoveredAttempts.find((attempt) => attempt.startRecordId === currentStartId)
			: undefined) ??
		recoveredAttempts.at(-1) ??
		null;
	return {
		attempts: recoveredAttempts,
		currentAttempt,
		authoritativeAttemptId: authoritative?.startRecordId ?? null,
		recovery: buildStartupRecovery(input.process, turnStartsById),
	};
}

export function presentProcessStartupSummary(evidence: StartupEvidence): ProcessStartupSummary {
	return {
		authoritativeAttemptId: evidence.authoritativeAttemptId,
		attempts: [...evidence.attempts],
		recovery: evidence.recovery,
	};
}

function projectStep(
	run: LaunchRun,
	id: string,
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped",
	occurredAt: string | null,
	safeSummary?: string,
): LaunchRun {
	return {
		...run,
		steps: run.steps.map((step) => {
			if (step.id !== id) return step;
			const {
				startedAt: previousStartedAt,
				completedAt: previousCompletedAt,
				safeSummary: _previousSafeSummary,
				...base
			} = step;
			const terminal = status === "completed" || status === "failed" || status === "skipped";
			return {
				...base,
				status,
				...(status !== "pending"
					? { startedAt: occurredAt ?? previousStartedAt ?? run.updatedAt ?? run.createdAt }
					: {}),
				...(terminal
					? { completedAt: occurredAt ?? previousCompletedAt ?? run.updatedAt ?? run.createdAt }
					: {}),
				...(safeSummary ? { safeSummary } : {}),
			};
		}),
	};
}

/** Projects a launch checklist from canonical durable evidence, never from an incoming worker event. */
export function projectLaunchRunStartup(
	run: LaunchRun,
	evidence: StartupEvidence,
	titleState: LaunchTitleState,
): LaunchRun {
	if (run.status === "cancelled") return run;
	const wasFailed = run.status === "failed";
	let next = run;
	const attempt = evidence.currentAttempt;
	if (!wasFailed) {
		for (const id of [
			"start_worker",
			"connect_worker",
			"prepare_workspace",
			"start_first_turn",
		] as const) {
			const step = attempt?.steps.find((candidate) => candidate.id === id);
			if (!step) {
				const existing = next.steps.find((candidate) => candidate.id === id);
				if (existing?.status !== "skipped") next = projectStep(next, id, "pending", null);
				continue;
			}
			const status = step.status === "superseded" ? "pending" : step.status;
			next = projectStep(
				next,
				id,
				status,
				step.occurredAt,
				status === "failed"
					? (attempt?.summary ??
							"Worker startup stopped before completion. Retry startup from the process page.")
					: id === "start_worker" && attempt?.summary
						? attempt.summary
						: undefined,
			);
		}
		next = {
			...next,
			steps: next.steps.map((item) => {
				const phase = attempt?.steps.find((candidate) => candidate.id === item.id);
				if (!phase) return item;
				const { startedAt: _start, completedAt: _end, ...rest } = item;
				return {
					...rest,
					label: phase.label,
					...(phase.startedAt ? { startedAt: phase.startedAt } : {}),
					...(phase.endedAt ? { completedAt: phase.endedAt } : {}),
				};
			}),
		};
		const failedStep = attempt?.steps.find((step) => step.status === "failed");
		if (failedStep) {
			next = failLaunchRun(
				next,
				failedStep.id,
				attempt?.summary ??
					"Worker startup stopped before completion. Retry startup from the process page.",
			);
		}
	}
	const projectedTitleStatus = titleState.status === "pending" ? "in_progress" : titleState.status;
	next = projectStep(
		next,
		"choose_title",
		projectedTitleStatus,
		null,
		titleState.status === "failed" ? titleState.safeSummary : undefined,
	);
	if (wasFailed || next.status === "failed") {
		return { ...next, status: "failed", completedAt: run.completedAt ?? next.completedAt };
	}
	return completeLaunchWhenReady({
		...next,
		status: attempt ? "starting" : "process_created",
	});
}
