import type { LaunchRun, ProcessInstance } from "@leitwerk-dev/domain";
import type { WorkerBootstrapProgressPayload } from "@leitwerk-dev/worker-protocol";
import type { WorkerStartPhase } from "@leitwerk-dev/worker-runners/types";
import {
	completeLaunchWhenReady,
	failLaunchRun,
	finishLaunchRun,
	STARTUP_STEP_IDS,
	transitionLaunchStep,
} from "./launch-pipeline.js";

type StepTransition = {
	id: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	safeSummary?: string;
};

const RUNNER_PHASE_TRANSITIONS: Partial<Record<WorkerStartPhase, readonly StepTransition[]>> = {
	preparing_runtime: [{ id: "start_worker", status: "in_progress" }],
	starting_runtime: [
		{ id: "start_worker", status: "completed" },
		{ id: "connect_worker", status: "in_progress" },
	],
};

const BOOTSTRAP_PHASE_TRANSITIONS: Record<
	WorkerBootstrapProgressPayload["phase"],
	readonly StepTransition[]
> = {
	worker_connected: [{ id: "connect_worker", status: "completed" }],
	preparing_workspace: [
		{ id: "connect_worker", status: "completed" },
		{ id: "prepare_workspace", status: "in_progress" },
	],
	loading_resources: [
		{ id: "connect_worker", status: "completed" },
		{ id: "prepare_workspace", status: "in_progress" },
	],
	preparing_turn: [
		{ id: "prepare_workspace", status: "completed" },
		{ id: "start_first_turn", status: "in_progress" },
	],
};

function applyTransitions(run: LaunchRun, transitions: readonly StepTransition[]): LaunchRun {
	return transitions.reduce(
		(next, transition) =>
			transitionLaunchStep(next, transition.id, transition.status, transition.safeSummary),
		run,
	);
}

function activeStartupStep(run: LaunchRun): string {
	return (
		[...STARTUP_STEP_IDS]
			.reverse()
			.find((id) => run.steps.some((item) => item.id === id && item.status === "in_progress")) ??
		"start_worker"
	);
}

export function observeRunnerPhase(run: LaunchRun, phase: WorkerStartPhase): LaunchRun {
	return {
		...applyTransitions(run, RUNNER_PHASE_TRANSITIONS[phase] ?? []),
		status: "starting",
	};
}

export function observeBootstrapProgress(
	run: LaunchRun,
	phase: WorkerBootstrapProgressPayload["phase"],
): LaunchRun {
	return { ...applyTransitions(run, BOOTSTRAP_PHASE_TRANSITIONS[phase]), status: "starting" };
}

export function observeWorkerReady(run: LaunchRun): LaunchRun {
	return transitionLaunchStep(
		transitionLaunchStep(run, "prepare_workspace", "completed"),
		"start_first_turn",
		"in_progress",
	);
}

export function observeFirstTurnStarted(run: LaunchRun): LaunchRun {
	return completeLaunchWhenReady(transitionLaunchStep(run, "start_first_turn", "completed"));
}

export function observeWorkerFailure(run: LaunchRun, safeSummary: string): LaunchRun {
	return failLaunchRun(run, activeStartupStep(run), safeSummary);
}

export function observeTitle(
	run: LaunchRun,
	status: "completed" | "skipped" | "failed",
	safeSummary?: string,
): LaunchRun {
	return completeLaunchWhenReady(transitionLaunchStep(run, "choose_title", status, safeSummary));
}

export function startupEvidenceScore(run: LaunchRun): number {
	return (
		(run.origin === "startup_retry" ? 100 : 0) +
		run.steps
			.filter((item) => STARTUP_STEP_IDS.includes(item.id as (typeof STARTUP_STEP_IDS)[number]))
			.reduce(
				(score, item) =>
					score +
					(item.status === "completed"
						? 3
						: item.status === "in_progress"
							? 2
							: item.status === "failed"
								? 1
								: 0),
				0,
			)
	);
}

export function reconcileCommittedLaunch(
	run: LaunchRun,
	input: {
		process: ProcessInstance;
		leaseState?: string;
		hasBootstrapReceipt: boolean;
		hasTurn: boolean;
		titleGenerationAvailable: boolean;
		titleJobFailed: boolean;
	},
): LaunchRun {
	let next = transitionLaunchStep(run, "create_process", "completed");
	if (input.leaseState && ["failed", "cleanup", "exited", "absent"].includes(input.leaseState)) {
		return failLaunchRun(
			next,
			activeStartupStep(next),
			"Worker startup stopped before completion. Retry startup from the process page.",
		);
	}
	if (input.leaseState) {
		next = applyTransitions(next, RUNNER_PHASE_TRANSITIONS.starting_runtime ?? []);
		if (input.leaseState !== "spawning") {
			next = applyTransitions(next, BOOTSTRAP_PHASE_TRANSITIONS.worker_connected);
		}
	}
	if (input.hasBootstrapReceipt) {
		next = transitionLaunchStep(next, "prepare_workspace", "completed");
	}
	if (input.hasTurn) next = transitionLaunchStep(next, "start_first_turn", "completed");
	if (input.process.title) {
		next = transitionLaunchStep(next, "choose_title", "completed");
	} else if (!input.titleGenerationAvailable) {
		next = transitionLaunchStep(next, "choose_title", "skipped");
	} else if (input.titleJobFailed) {
		next = transitionLaunchStep(
			next,
			"choose_title",
			"failed",
			"Process started, but a title could not be generated. You can rename it later.",
		);
	}
	return completeLaunchWhenReady({
		...next,
		status: input.leaseState ? "starting" : "process_created",
	});
}

export function cancelLaunchRun(run: LaunchRun): LaunchRun {
	return finishLaunchRun(run, "cancelled");
}
