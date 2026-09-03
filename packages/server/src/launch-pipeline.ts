import type {
	LaunchChecklistStep,
	LaunchChecklistStepStatus,
	LaunchRun,
	ProcessInstance,
} from "@leitwerk-dev/domain";
import { SafeLaunchPreparationError } from "@leitwerk-dev/process-sdk";
import type { RepositoryBundle } from "./db/repositories.js";
import type { Broadcaster } from "./ws/broadcast.js";

const CORE_STEPS = [
	["validate_request", "Validate launch request"],
	["resolve_models_skills", "Resolve models and skills"],
	["create_process", "Create process"],
	["choose_title", "Choose process title"],
	["start_worker", "Start worker"],
	["connect_worker", "Connect worker"],
	["prepare_workspace", "Prepare workspace"],
	["start_first_turn", "Start first turn"],
] as const;

const STATUS_RANK: Record<LaunchChecklistStepStatus, number> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
	skipped: 2,
	failed: 2,
};

export const STARTUP_STEP_IDS = [
	"start_worker",
	"connect_worker",
	"prepare_workspace",
	"start_first_turn",
] as const;

export type LaunchStageFailure<TFailure> = {
	safeSummary: string;
	value: TFailure;
};

export type LaunchResolution<TResolved, TFailure> =
	| { kind: "resolved"; value: TResolved }
	| { kind: "skipped" }
	| { kind: "failed"; failure: LaunchStageFailure<TFailure> };

export interface LaunchPipelineCheck {
	id: string;
	label: string;
	run(input: {
		signal: AbortSignal;
		logger: { info(message: string): void; warn(message: string): void };
	}): Promise<void>;
}

export type LaunchCommit<TResult, TFailure> =
	| {
			kind: "committed";
			result: TResult;
			process: ProcessInstance;
			startTurnId: string | null;
			reused: boolean;
	  }
	| {
			kind: "committed_with_reaction_error";
			result: TResult;
			process: ProcessInstance;
			startTurnId: string | null;
			safeSummary: string;
	  }
	| { kind: "failed"; failure: LaunchStageFailure<TFailure> };

export interface LaunchAdapter<TResolved, TPrepared, TResult, TFailure> {
	resolve(): Promise<LaunchResolution<TResolved, TFailure>>;
	preparationChecks?(resolved: TResolved): readonly LaunchPipelineCheck[];
	preparationCheckFailure?(error: unknown, safeSummary: string): TFailure;
	prepare(
		resolved: TResolved,
	): Promise<{ ok: true; value: TPrepared } | { ok: false; failure: LaunchStageFailure<TFailure> }>;
	commit(
		prepared: TPrepared,
		ctx: { launchRunId: string },
	): Promise<LaunchCommit<TResult, TFailure>>;
	unexpectedFailure?(error: unknown): LaunchStageFailure<TFailure>;
}

export type LaunchPipelineRunResult<TResult, TFailure> =
	| { kind: "skipped" }
	| { kind: "failed"; failure: LaunchStageFailure<TFailure> }
	| {
			kind: "committed" | "committed_with_reaction_error";
			result: TResult;
			process: ProcessInstance;
			reused: boolean;
	  };

export interface LaunchPipeline {
	open(input: {
		launcherId: string | null;
		idempotencyKey?: string | null;
		origin: LaunchRun["origin"];
		broadcast?: boolean;
	}): { launchRunId: string; existing: boolean };
	update(id: string, fn: (run: LaunchRun) => LaunchRun): LaunchRun;
	run<TResolved, TPrepared, TResult, TFailure>(
		launchRunId: string,
		adapter: LaunchAdapter<TResolved, TPrepared, TResult, TFailure>,
	): Promise<LaunchPipelineRunResult<TResult, TFailure>>;
}

export function initialLaunchSteps(): LaunchChecklistStep[] {
	return CORE_STEPS.map(([id, label]) => ({ id, label, status: "pending" }));
}

export function transitionLaunchStep(
	run: LaunchRun,
	id: string,
	status: LaunchChecklistStepStatus,
	safeSummary?: string,
): LaunchRun {
	const timestamp = new Date().toISOString();
	return {
		...run,
		steps: run.steps.map((item) => {
			if (item.id !== id || STATUS_RANK[status] < STATUS_RANK[item.status]) return item;
			if (STATUS_RANK[status] === STATUS_RANK[item.status] && item.status !== status) return item;
			return {
				...item,
				status,
				...(status === "in_progress" && !item.startedAt ? { startedAt: timestamp } : {}),
				...(["completed", "failed", "skipped"].includes(status) && !item.completedAt
					? { completedAt: timestamp }
					: {}),
				...(safeSummary ? { safeSummary } : {}),
			};
		}),
	};
}

export function finishLaunchRun(run: LaunchRun, status: "failed" | "cancelled"): LaunchRun {
	return { ...run, status, completedAt: run.completedAt ?? new Date().toISOString() };
}

export function failLaunchRun(run: LaunchRun, stepId: string, summary: string): LaunchRun {
	const timestamp = new Date().toISOString();
	const transitioned = transitionLaunchStep(run, stepId, "failed", summary);
	return finishLaunchRun(
		{
			...transitioned,
			steps: transitioned.steps.map((step) =>
				step.id === stepId && step.status !== "failed"
					? {
							...step,
							status: "failed",
							startedAt: step.startedAt ?? timestamp,
							completedAt: step.completedAt ?? timestamp,
							safeSummary: summary,
						}
					: step,
			),
		},
		"failed",
	);
}

export function completeCommittedLaunch(
	run: LaunchRun,
	process: ProcessInstance,
	startTurnId: string | null,
	titleGenerationAvailable: boolean | undefined,
	reactionError?: string,
): LaunchRun {
	let next = transitionLaunchStep(run, "resolve_models_skills", "completed");
	next = transitionLaunchStep(next, "create_process", "completed");
	next = transitionLaunchStep(
		next,
		"choose_title",
		process.title ? "completed" : titleGenerationAvailable ? "in_progress" : "skipped",
	);
	if (!startTurnId) {
		for (const id of STARTUP_STEP_IDS) next = transitionLaunchStep(next, id, "skipped");
	}
	next = { ...next, instanceId: process.id, status: "starting" };
	return reactionError
		? failLaunchRun(next, "start_worker", reactionError)
		: completeLaunchWhenReady(next);
}

export function completeLaunchWhenReady(run: LaunchRun): LaunchRun {
	if (run.status === "failed" || run.status === "cancelled") return run;
	const ready = run.steps
		.filter((item) => [...STARTUP_STEP_IDS, "choose_title"].includes(item.id))
		.every((item) => ["completed", "skipped", "failed"].includes(item.status));
	return ready
		? { ...run, status: "completed", completedAt: run.completedAt ?? new Date().toISOString() }
		: { ...run, status: "starting" };
}

function withChecks(run: LaunchRun, checks: readonly LaunchPipelineCheck[]): LaunchRun {
	if (checks.length === 0) return run;
	return {
		...run,
		steps: [
			run.steps[0] as LaunchChecklistStep,
			...checks.map(
				(check) =>
					run.steps.find((item) => item.id === `check:${check.id}`) ?? {
						id: `check:${check.id}`,
						label: check.label,
						status: "pending" as const,
					},
			),
			...run.steps.slice(1).filter((item) => !item.id.startsWith("check:")),
		],
	};
}

function activeStepId(run: LaunchRun): string {
	return run.steps.find((item) => item.status === "in_progress")?.id ?? "validate_request";
}

export function createLaunchPipeline(deps: {
	launchRuns: RepositoryBundle["launchRuns"];
	broadcaster: Broadcaster;
	titleGenerationAvailable?: boolean;
	logger?: { info(message: string): void; warn(message: string): void };
}): LaunchPipeline {
	const logger = deps.logger ?? { info() {}, warn() {} };
	function broadcast(run: LaunchRun): void {
		deps.broadcaster.sendDurable(
			"launch.updated",
			{ launchRunId: run.id, instanceId: run.instanceId },
			run.instanceId ?? undefined,
		);
	}
	function mutate(id: string, fn: (run: LaunchRun) => LaunchRun): LaunchRun {
		const run = deps.launchRuns.update(id, fn);
		if (!run) throw new Error(`Launch run '${id}' does not exist`);
		broadcast(run);
		return run;
	}
	function fail<T>(id: string, stepId: string, failure: LaunchStageFailure<T>) {
		mutate(id, (run) => failLaunchRun(run, stepId, failure.safeSummary));
		return { kind: "failed" as const, failure };
	}

	return {
		open(input) {
			const existing = input.idempotencyKey
				? deps.launchRuns.getByIdempotencyKey(input.idempotencyKey)
				: null;
			if (existing) return { launchRunId: existing.id, existing: true };
			const { broadcast: shouldBroadcast = true, ...createInput } = input;
			const run = deps.launchRuns.create({ ...createInput, steps: initialLaunchSteps() });
			if (shouldBroadcast) broadcast(run);
			return { launchRunId: run.id, existing: false };
		},

		update: mutate,

		async run<TResolved, TPrepared, TResult, TFailure>(
			launchRunId: string,
			adapter: LaunchAdapter<TResolved, TPrepared, TResult, TFailure>,
		): Promise<LaunchPipelineRunResult<TResult, TFailure>> {
			try {
				mutate(launchRunId, (run) => transitionLaunchStep(run, "validate_request", "in_progress"));
				const resolution = await adapter.resolve();
				if (resolution.kind === "skipped") {
					mutate(launchRunId, (run) =>
						finishLaunchRun(transitionLaunchStep(run, "validate_request", "skipped"), "cancelled"),
					);
					return { kind: "skipped" };
				}
				if (resolution.kind === "failed")
					return fail(launchRunId, "validate_request", resolution.failure);
				mutate(launchRunId, (run) => transitionLaunchStep(run, "validate_request", "completed"));

				const checks = adapter.preparationChecks?.(resolution.value) ?? [];
				mutate(launchRunId, (run) => withChecks(run, checks));
				const controller = new AbortController();
				for (const check of checks) {
					const id = `check:${check.id}`;
					mutate(launchRunId, (run) => transitionLaunchStep(run, id, "in_progress"));
					try {
						await check.run({ signal: controller.signal, logger });
						mutate(launchRunId, (run) => transitionLaunchStep(run, id, "completed"));
					} catch (error) {
						controller.abort();
						const safeSummary =
							error instanceof SafeLaunchPreparationError
								? error.safeSummary
								: "The preparation check did not complete. Verify access and try again.";
						return fail(launchRunId, id, {
							safeSummary,
							value: adapter.preparationCheckFailure
								? adapter.preparationCheckFailure(error, safeSummary)
								: (error as TFailure),
						});
					}
				}

				mutate(launchRunId, (run) =>
					transitionLaunchStep(run, "resolve_models_skills", "in_progress"),
				);
				const prepared = await adapter.prepare(resolution.value);
				if (!prepared.ok) return fail(launchRunId, "resolve_models_skills", prepared.failure);
				mutate(launchRunId, (run) => {
					let next = transitionLaunchStep(run, "resolve_models_skills", "completed");
					next = transitionLaunchStep(next, "create_process", "in_progress");
					return next;
				});
				const committed = await adapter.commit(prepared.value, { launchRunId });
				if (committed.kind === "failed")
					return fail(launchRunId, "create_process", committed.failure);
				mutate(launchRunId, (run) =>
					completeCommittedLaunch(
						run,
						committed.process,
						committed.startTurnId,
						deps.titleGenerationAvailable,
						committed.kind === "committed_with_reaction_error" ? committed.safeSummary : undefined,
					),
				);
				return {
					kind: committed.kind,
					result: committed.result,
					process: committed.process,
					reused: committed.kind === "committed" ? committed.reused : false,
				};
			} catch (error) {
				const run = deps.launchRuns.getById(launchRunId);
				const failure = adapter.unexpectedFailure?.(error) ?? {
					safeSummary: "The launch could not be completed. Try again.",
					value: error as TFailure,
				};
				return fail(launchRunId, run ? activeStepId(run) : "validate_request", failure);
			}
		},
	};
}
