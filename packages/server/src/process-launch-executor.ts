import type { Actor, ProcessInstance, ProcessProject, ProcessRelation } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import type { SkillSelection } from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import { buildExtensionEventEffect, type PostCommitEffect } from "./effects/post-commit-effect.js";
import { runPostCommitEffectList } from "./effects/post-commit-runner.js";
import type { ExtensionHost } from "./extensions/extension-host.js";
import {
	applyRequiredFutureExecutionTransitionPlan,
	type FutureExecutionTransitionPlan,
} from "./future-execution/transition-planner.js";
import {
	isInternalEngineFailureCode,
	publicInternalEngineFailureMessage,
} from "./process-engine/internal-failures.js";
import type { EngineFailure, ProcessEngine, ProcessEngineLogger } from "./process-engine/types.js";
import type { ProcessTitleGenerator } from "./process-title-generator.js";
import { buildProjectUpdatedEffect } from "./project-mutation-service.js";
import type { WorkerSupervisor } from "./supervisor/worker-supervisor.js";
import type { Broadcaster } from "./ws/broadcast.js";

export type ProcessLaunchExecutionResult =
	| { ok: true; process: ProcessInstance; projects: ProcessProject[]; reused: boolean }
	| {
			ok: false;
			stage: "pre_commit";
			status: number;
			body: Record<string, unknown>;
	  }
	| {
			ok: false;
			stage: "post_commit";
			status: number;
			body: Record<string, unknown>;
			process: ProcessInstance;
			projects: ProcessProject[];
	  };

export interface ProcessLaunchExecutorDeps
	extends Pick<
		RepositoryBundle,
		| "processes"
		| "projects"
		| "processRelations"
		| "skills"
		| "processSkills"
		| "handoffDedupKeys"
		| "futureExecutions"
		| "transaction"
	> {
	broadcaster: Broadcaster;
	commands: ProcessEngine;
	processTitles?: ProcessTitleGenerator;
	extensionHost?: ExtensionHost;
	logger?: ProcessEngineLogger;
	getSupervisor?: () => WorkerSupervisor | undefined;
	repositoryCredentials?: import("./repository-credentials/service.js").RepositoryCredentialService;
}

export type ProcessLaunchRelationInput = Omit<
	ProcessRelation,
	"kind" | "childInstanceId" | "createdAt"
>;

export interface ProcessLaunchOptions {
	actor?: Actor;
	resourceSelections?: readonly SkillSelection[];
	launchIntent?: { launcherInput: Record<string, unknown> };
	launchRunId?: string;
	relation?: ProcessLaunchRelationInput;
}

export type ProcessLaunchPlanExecutor = (
	launchPlan: ProcessLaunchPlan,
	opts?: ProcessLaunchOptions,
) => Promise<ProcessLaunchExecutionResult>;

export interface ProcessLaunchCommit {
	process: ProcessInstance;
	projects: ProcessProject[];
	dedupReused?: boolean;
}

function mapLaunchStartFailure<T>(result: EngineFailure<T>): {
	status: number;
	body: Record<string, unknown>;
} {
	if (isInternalEngineFailureCode(result.code)) {
		return {
			status: 500,
			body: {
				error: publicInternalEngineFailureMessage(result.code, result.stage),
				code: result.code,
			},
		};
	}

	if (result.code === "worker_reconcile_failed") {
		return {
			status: 503,
			body: {
				error: "Process was created, but the worker could not be started cleanly",
				process: result.process,
			},
		};
	}

	if (result.code === "process_not_found") {
		return {
			status: 404,
			body: { error: result.message },
		};
	}

	return {
		status: 400,
		body: {
			error: result.message,
			code: result.code,
			...(result.process ? { process: result.process } : {}),
		},
	};
}

function createLaunchProjects(
	deps: Pick<ProcessLaunchExecutorDeps, "projects">,
	process: ProcessInstance,
	launchPlan: ProcessLaunchPlan,
): ProcessProject[] {
	return launchPlan.projectInputs.map((projectInput) =>
		deps.projects.create({
			instanceId: process.id,
			key: projectInput.key,
			repoLocator: projectInput.repoLocator,
			baseBranch: projectInput.baseBranch,
			workBranch: projectInput.workBranch ?? null,
			externalId: projectInput.externalId ?? null,
			externalUrl: projectInput.externalUrl ?? null,
			metadata: projectInput.metadata ?? null,
		}),
	);
}

function isSqliteConstraintError(error: unknown): boolean {
	const record = error as { code?: unknown; message?: unknown };
	return (
		record?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
		record?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
		(typeof record?.message === "string" &&
			/sqlite_constraint|unique constraint/i.test(record.message))
	);
}

function toLaunchFailureBody(
	error: unknown,
	context: {
		createdProcess: ProcessInstance | null;
		projects: ProcessProject[];
	},
): { ok: false; status: number; body: Record<string, unknown> } {
	const message =
		error instanceof Error ? error.message : "Failed to create process from launch plan";
	return {
		ok: false,
		status: 500,
		body: {
			error: message,
			...(context.createdProcess
				? { process: context.createdProcess, projects: context.projects }
				: {}),
		},
	};
}

export function commitProcessLaunch(
	deps: ProcessLaunchExecutorDeps,
	launchPlan: ProcessLaunchPlan,
	futureExecutionPlan?: FutureExecutionTransitionPlan,
	resourceSelections: readonly SkillSelection[] = [],
	launchIntent?: ProcessLaunchOptions["launchIntent"],
	launchRunId?: string,
	relation?: ProcessLaunchRelationInput,
): ProcessLaunchCommit {
	return deps.transaction((repos) => {
		const dedupKey =
			(launchPlan as { handoffDedupKey?: string | null }).handoffDedupKey?.trim() || null;
		const reused = dedupKey ? reuseDeduplicatedCommit(repos, dedupKey, futureExecutionPlan) : null;
		if (reused) {
			if (launchRunId) {
				repos.launchRuns.update(launchRunId, (run) => ({
					...run,
					instanceId: reused.process.id,
					status: "process_created",
				}));
			}
			return reused;
		}

		const commit = createProcessLaunchCommit(
			repos,
			launchPlan,
			dedupKey,
			resourceSelections,
			launchIntent,
			relation,
		);
		if (launchRunId) {
			repos.launchRuns.update(launchRunId, (run) => ({
				...run,
				instanceId: commit.process.id,
				status: "process_created",
			}));
		}
		if (futureExecutionPlan) {
			applyRequiredFutureExecutionTransitionPlan(repos.futureExecutions, futureExecutionPlan);
		}
		return commit;
	});
}

function reuseDeduplicatedCommit(
	repos: Pick<
		ProcessLaunchExecutorDeps,
		"processes" | "projects" | "handoffDedupKeys" | "futureExecutions"
	>,
	dedupKey: string,
	futureExecutionPlan?: FutureExecutionTransitionPlan,
): ProcessLaunchCommit | null {
	const existing = repos.handoffDedupKeys.getByKey(dedupKey);
	const process = existing ? repos.processes.getById(existing.instanceId) : null;
	if (!process) return null;
	if (futureExecutionPlan) {
		applyRequiredFutureExecutionTransitionPlan(repos.futureExecutions, futureExecutionPlan);
	}
	return {
		process,
		projects: repos.projects.listByInstance(process.id),
		dedupReused: true,
	};
}

function createProcessLaunchCommit(
	repos: Pick<
		ProcessLaunchExecutorDeps,
		"processes" | "projects" | "processRelations" | "processSkills" | "handoffDedupKeys"
	>,
	launchPlan: ProcessLaunchPlan,
	dedupKey: string | null,
	resourceSelections: readonly SkillSelection[],
	launchIntent?: ProcessLaunchOptions["launchIntent"],
	relation?: ProcessLaunchRelationInput,
): ProcessLaunchCommit {
	const process = repos.processes.create({
		...launchPlan.processInput,
		...(launchIntent
			? {
					launchIntent: {
						launcherId: launchPlan.launcherId,
						launcherInput: launchIntent.launcherInput,
					},
				}
			: {}),
	});
	const projects = createLaunchProjects({ projects: repos.projects }, process, launchPlan);
	if (relation) {
		repos.processRelations.create({
			...relation,
			childInstanceId: process.id,
		});
	}
	repos.processSkills.attach(process.id, resourceSelections);
	if (dedupKey) {
		repos.handoffDedupKeys.create({
			key: dedupKey,
			instanceId: process.id,
			metadata: {
				launcherId: launchPlan.launcherId,
				processId: launchPlan.processId,
			},
		});
	}
	return { process, projects };
}

export function buildProcessLaunchPostCommitEffects(
	commit: ProcessLaunchCommit,
	launchPlan: ProcessLaunchPlan,
	launchRunId?: string,
): PostCommitEffect[] {
	return [
		{
			kind: "broadcast",
			frame: {
				type: "process.created",
				payload: {
					process: commit.process,
					processId: commit.process.processId,
					launcherId: launchPlan.launcherId,
				},
				instanceId: commit.process.id,
			},
		},
		...commit.projects.map((project) => buildProjectUpdatedEffect(project)),
		{
			kind: "queue_process_title",
			processId: commit.process.id,
			launchPlan,
			...(launchRunId ? { launchRunId } : {}),
		},
		buildExtensionEventEffect(commit.process.id, "process_created", {
			process: commit.process,
			projects: commit.projects,
			launcherId: launchPlan.launcherId,
		}),
	];
}

export async function createProcessFromLaunchPlan(
	deps: ProcessLaunchExecutorDeps,
	launchPlan: ProcessLaunchPlan,
	opts?: ProcessLaunchOptions,
): Promise<ProcessLaunchExecutionResult> {
	return createProcessFromLaunchPlanWithDisposition(deps, launchPlan, opts);
}

export async function createScheduledProcessFromLaunchPlan(
	deps: ProcessLaunchExecutorDeps,
	launchPlan: ProcessLaunchPlan,
	futureExecutionPlan: FutureExecutionTransitionPlan,
	opts?: ProcessLaunchOptions,
): Promise<ProcessLaunchExecutionResult> {
	return createProcessFromLaunchPlanWithDisposition(deps, launchPlan, opts, futureExecutionPlan);
}

function recoverDeduplicatedCommit(
	deps: ProcessLaunchExecutorDeps,
	dedupKey: string,
	futureExecutionPlan?: FutureExecutionTransitionPlan,
): ProcessLaunchCommit | null {
	return deps.transaction((repos) => reuseDeduplicatedCommit(repos, dedupKey, futureExecutionPlan));
}

function launchStartFailure(
	commit: ProcessLaunchCommit,
	result: EngineFailure<unknown>,
): ProcessLaunchExecutionResult {
	const failure = mapLaunchStartFailure(result);
	const process = result.process ?? commit.process;
	return {
		ok: false,
		stage: "post_commit",
		status: failure.status,
		body: {
			...failure.body,
			process: failure.body.process ?? process,
			projects: commit.projects,
		},
		process,
		projects: commit.projects,
	};
}

async function createProcessFromLaunchPlanWithDisposition(
	deps: ProcessLaunchExecutorDeps,
	launchPlan: ProcessLaunchPlan,
	opts?: ProcessLaunchOptions,
	futureExecutionPlan?: FutureExecutionTransitionPlan,
): Promise<ProcessLaunchExecutionResult> {
	let resourceSelections = opts?.resourceSelections;
	if (!resourceSelections && launchPlan.skillIds) {
		try {
			resourceSelections = deps.skills.resolveActive(launchPlan.skillIds);
		} catch (error) {
			return {
				ok: false,
				stage: "pre_commit",
				status: 400,
				body: { error: error instanceof Error ? error.message : String(error) },
			};
		}
	}
	if (deps.repositoryCredentials) {
		try {
			deps.repositoryCredentials.validateLaunch({
				processId: launchPlan.processId,
				paramsJson: launchPlan.processInput.paramsJson,
				projects: launchPlan.projectInputs,
			});
		} catch (error) {
			return {
				ok: false,
				stage: "pre_commit",
				status: 400,
				body: { error: error instanceof Error ? error.message : String(error) },
			};
		}
	}
	let commit: ProcessLaunchCommit;
	try {
		commit = commitProcessLaunch(
			deps,
			launchPlan,
			futureExecutionPlan,
			resourceSelections,
			opts?.launchIntent,
			opts?.launchRunId,
			opts?.relation,
		);
	} catch (error) {
		const dedupKey =
			(launchPlan as { handoffDedupKey?: string | null }).handoffDedupKey?.trim() || null;
		const recovered =
			dedupKey && isSqliteConstraintError(error)
				? recoverDeduplicatedCommit(deps, dedupKey, futureExecutionPlan)
				: null;
		if (!recovered) {
			return {
				...toLaunchFailureBody(error, { createdProcess: null, projects: [] }),
				stage: "pre_commit",
			};
		}
		commit = recovered;
	}

	try {
		if (!commit.dedupReused) {
			const postCommit = await runPostCommitEffectList(
				{
					broadcaster: deps.broadcaster,
					getSupervisor: deps.getSupervisor ?? (() => undefined),
					processTitles: deps.processTitles,
					extensionHost: deps.extensionHost,
				},
				buildProcessLaunchPostCommitEffects(commit, launchPlan, opts?.launchRunId),
				{},
				{ logger: deps.logger, operationKind: "process_launch", stage: "post_commit" },
				{ reportBestEffortFailures: futureExecutionPlan !== undefined },
			);
			if (!postCommit.ok) {
				return {
					ok: false,
					stage: "post_commit",
					status: postCommit.code === "worker_reconcile_failed" ? 503 : 500,
					body: { error: postCommit.message, process: commit.process, projects: commit.projects },
					process: commit.process,
					projects: commit.projects,
				};
			}
		}

		const shouldStart =
			Boolean(launchPlan.startTurnId) &&
			(!commit.dedupReused ||
				(commit.process.lifecycleStatus === "discovered" &&
					commit.process.selectedTurnId === null));
		if (!shouldStart || !launchPlan.startTurnId) {
			return {
				ok: true,
				process: commit.process,
				projects: commit.projects,
				reused: commit.dedupReused === true,
			};
		}
		const started = await deps.commands.startProcess(
			commit.process.id,
			launchPlan.startTurnId,
			opts,
		);
		return started.ok
			? {
					ok: true,
					process: started.process,
					projects: commit.projects,
					reused: commit.dedupReused === true,
				}
			: launchStartFailure(commit, started);
	} catch (error) {
		const failure = toLaunchFailureBody(error, {
			createdProcess: commit.process,
			projects: commit.projects,
		});
		return {
			...failure,
			stage: "post_commit",
			process: commit.process,
			projects: commit.projects,
		};
	}
}
