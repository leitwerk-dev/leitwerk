import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type AutomaticOutcomeBuilder,
	type ExtensionProcessDefinition,
	type ExternalActionSource,
	type FlowAutomaticRunContext,
	flow,
	type ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import {
	commitAndPushWorkBranch,
	type GitIdentity,
	repositoryHasChanges,
} from "./finalization-git.js";
import { RemoteBranchChangedError } from "./finalization-git-internal.js";
import type { RepositoryChangeState } from "./repository-change-state.js";
import {
	ConcurrentRebaseSourceError,
	hasPreparedRebase,
	publishRebase,
	startRebase,
} from "./repository-rebase/git.js";
import { type ConflictEvidence, conflictKey, validateConflict } from "./repository-rebase/index.js";
import { rebasePrompt } from "./repository-rebase/prompt.js";
import {
	type ReconciliationResult,
	reconcilePublicationRepository,
	reconciliationPrompt,
	recordRepositoryPublication,
	repositoryWorktreeIsDirty,
	retainConcurrentRebase,
} from "./repository-reconciliation.js";
import { codingPurposes } from "./settings.js";

export {
	createPullRequestChangeProcess,
	pullRequestPublicationDefaults,
	resolvePullRequestGitIdentity,
} from "./pull-request-publication-internal.js";

/** @public */
export interface PublicationRequest {
	/** @public */
	number: number;

	/** @public */
	html_url: string;

	/** @public */
	merged: boolean;

	/** @public */
	merge_commit_sha?: string | null;
}

/** @public */
export interface PublicationPipeline {
	/** @public */
	number: number;

	/** @public */
	status: string;

	/** @public */
	[key: string]: unknown;
}

/** @public */
export interface PublicationParams {
	/** @public */
	owner: string;

	/** @public */
	repo: string;

	/** @public */
	workBranch: string;

	/** @public */
	baseBranch: string;
}

/** Narrow process params to a resolved repository before publication. @public */
export function requirePublicationParams<P>(params: P): P & PublicationParams {
	const value = asUnknownRecord(params);
	for (const key of ["owner", "repo", "workBranch", "baseBranch"])
		if (typeof value?.[key] !== "string" || !value[key])
			throw new Error("Repository binding is not resolved");
	return params as P & PublicationParams;
}

/** @public */
export type PublicationContext<P> = FlowAutomaticRunContext<P, RepositoryChangeState>;

/** Remote reconciliation has no worker checkout or filesystem access. @public */
export type PublicationReconciliationContext<P> = Pick<
	PublicationContext<P>,
	"process" | "projects" | "params" | "state" | "callIntegrationTool"
>;

/** @public */
export type PublicationEvidence = (
	| {
			/** @public */
			kind: "feedback";

			/** @public */
			feedbackIds: PublicationFeedbackId[];

			/** @public */
			conversationCursor: number;

			/** @public */
			reviewCursor: number;

			/** @public */
			inlineCursor: number;
	  }
	| {
			/** @public */
			kind: "failure";

			/** @public */
			pipeline: PublicationPipeline;
	  }
	| {
			/** @public */
			kind: "conflict";

			/** @public */
			conflict: ConflictEvidence;
	  }
	| {
			/** @public */
			kind: "terminal";

			/** @public */
			request: PublicationRequest;
	  }
	| {
			/** @public */
			kind: "cancelled";
	  }
	| {
			/** @public */
			kind: "observed";
	  }
) & {
	/** @public */
	observationKey?: string;
	/** Current provider source revision. @internal */ remoteHeadSha?: string;
	/** Coordinated repository key. @public */ projectKey?: string;
};

/** @public */
export interface PublicationSource<P> {
	/** @public */
	id: string;

	/** @public */
	kind: "feedback" | "failure" | "conflict" | "terminal" | "cancelled" | "observation";

	/** @public */
	operatorId?: string;

	/** @public */
	label: string;

	/** @public */
	source: ExternalActionSource<P, RepositoryChangeState, unknown>;

	/** @public */
	enabled?(params: P, state: RepositoryChangeState): boolean;

	/** @public */
	read(input: {
		/** @public */
		params: P;

		/** @public */
		state: RepositoryChangeState;

		/** @public */
		event: unknown;
	}): PublicationEvidence;
}

/** @public */
export interface RepositoryChangePublicationAdapter<P> {
	/** Optional server maintenance uses existing business turns and adds no worker positions. @public */
	maintenance?: {
		/** @public */ source: ExternalActionSource<
			P,
			RepositoryChangeState,
			PublicationMaintenanceEvent
		>;
		/** @public */ ownershipTool: string;
		/** @public */ register(
			api: ServerExtensionAPI,
			process: ExtensionProcessDefinition<P, RepositoryChangeState>,
		): void;
	};
	/** @public */
	namespace: string;
	/** Reconcile a single-repository no-change outcome. @public */
	unchanged?(ctx: PublicationContext<P>): Promise<void>;
	/** Optional coordinated repositories; each retains independent publication state. @public */
	repositories?(params: P): readonly {
		/** @internal */
		key: string;
		/** @internal */
		params: P & PublicationParams;
	}[];
	/** Reconcile remote terminal state before new writes or source cancellation. @public */
	observeTerminal?(
		ctx: PublicationContext<P>,
		current: PublicationState,
	): Promise<PublicationRequest | null>;

	/** @public */
	sourceCancelled?(ctx: PublicationReconciliationContext<P>): Promise<boolean>;

	/** @public */
	reconcileAll?(
		ctx: PublicationReconciliationContext<P>,
		results: readonly {
			/** @internal */
			key: string;
			/** @internal */
			current: PublicationState;
		}[],
		cancelled: boolean,
	): Promise<void>;

	/** @public */
	label: string;

	/** @public */
	ids: {
		/** @public */
		deliver: string;

		/** @public */
		feedback: string;

		/** @public */
		ciRepair: string;

		/** @public */
		operator: string;
	};

	/** @public */
	tools: {
		/** @public */
		delivery: readonly string[];

		/** @public */
		feedback: readonly string[];

		/** @public */
		ci: readonly string[];
	};

	/** @public */
	sources: readonly PublicationSource<P>[];

	/** @public */
	identity(ctx: PublicationContext<P>): Promise<GitIdentity>;

	/** @public */
	ensureRequest(ctx: PublicationContext<P>): Promise<PublicationRequest>;

	/** @public */
	reconcileTerminal(
		ctx: PublicationReconciliationContext<P>,
		current: PublicationState,
		request: PublicationRequest,
	): Promise<void>;

	/** @public */
	linkIssue(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;

	/** @public */
	acknowledge(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;

	/** @public */
	reply(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;

	/** @public */
	afterRebase(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;

	/** @public */
	head(ctx: PublicationContext<P>, current: PublicationState): Promise<string>;

	/** @public */
	prompt(kind: "feedback" | "ci", current: PublicationState): string;

	/** @public */
	commitMessage(kind: "feedback" | "ci"): string;
}

/** @public */
export interface PublicationMaintenanceEvent {
	/** @public */
	state: RepositoryChangeState;
}

/** @public */
export interface FeedbackDeliveryResult {
	/** @public */
	published: boolean;
	/** @public */
	summary: string;
}

/** @public */
export type PublicationFeedbackId = {
	/** @public */
	kind: "conversation" | "review" | "inline";

	/** @public */
	id: number;

	/** @public */
	discussionId?: string;
};

/** @public */
type AdjustmentInvocation = {
	/** @public */
	origin: "feedback" | "ci" | "rebase";

	/** @public */
	publishRequired: boolean;
	/** Operator-facing no-change diagnosis retained until delivery. @internal */
	summary?: string;
};

/** @public */
export interface DeliveryState {
	/** Feedback delivery retained until the server acknowledges the batch. @public */
	feedbackResult?: FeedbackDeliveryResult | null;
	/** @public */
	stage: "not_started" | "branch_published" | "pull_request_ready" | "awaiting";

	/** @public */
	issueLinked: boolean;

	/** @public */
	adjustment: AdjustmentInvocation | null;

	/** @public */
	terminalPullRequest: PublicationRequest | null;
}

/** @public */
export interface PublicationState {
	/** Maintenance was stopped for this MR; it remains open and contributes a partial result. @public */ stopped?: boolean;
	/** Repository had no change at first publication. @public */ noChanges?: boolean;

	/** @public */
	lastConflictKey?: string | null;

	/** @public */
	conflict?: ConflictEvidence | null;

	/** @public */
	repairReason?: "feedback" | "ci" | "rebase";
	/** Staged repair retained when another maintained MR interrupts the worker. @public */
	repairPending?: boolean;

	/** @public */
	headSha: string | null;

	/** Baseline retained until the worker reconciles its unpublished delta. @internal */
	workBaselineSha?: string | null;
	/** Historical publication receipt, not an eligibility condition. @internal */
	lastPublishedHeadSha?: string | null;
	/** Combined tree needs validation before publication. @internal */
	reconciliationRequired?: boolean;
	/** Bound automatic reconciliation loops under continuously moving branches. @internal */
	reconciliationCycles?: number;

	/** @public */
	prNumber: number | null;

	/** @public */
	prUrl: string | null;

	/** @public */
	conversationCursor: number;

	/** @public */
	reviewCursor: number;

	/** @public */
	inlineCursor: number;

	/** @public */
	feedbackIds: PublicationFeedbackId[];

	/** @public */
	pipeline: PublicationPipeline | null;

	/** @public */
	ciRecoveryCycles: number;

	/** @public */
	delivery: DeliveryState;

	/** @public */
	observationKey?: string;

	/** @public */
	pendingEvidence?: PublicationEvidence | null;
}

const initialDeliveryState: DeliveryState = {
	stage: "not_started",
	issueLinked: false,
	adjustment: null,
	terminalPullRequest: null,
};

const initialPublicationState: PublicationState = {
	headSha: null,
	prNumber: null,
	prUrl: null,
	conversationCursor: 0,
	reviewCursor: 0,
	inlineCursor: 0,
	feedbackIds: [],
	pipeline: null,
	ciRecoveryCycles: 0,
	delivery: initialDeliveryState,
};

/** @public */
export const publicationObject = (value: unknown) => asUnknownRecord(value) ?? {};

/** Shared coordination metadata for worker publication and server maintenance. @internal */
export function createPublicationSelection(namespace: () => string) {
	return {
		/** @internal */
		activeKey: (state: RepositoryChangeState) =>
			publicationObject(state.extensionState?.[`${namespace()}.coordination`]).activeKey as
				| string
				| undefined,
		/** @internal */
		select: (state: RepositoryChangeState, key: string): RepositoryChangeState => ({
			...state,
			extensionState: {
				...state.extensionState,
				[`${namespace()}.coordination`]: { activeKey: key },
			},
		}),
	};
}

/** @internal */
export const publicationFinished = (current: PublicationState): boolean =>
	!!(current.stopped || current.noChanges || current.delivery.terminalPullRequest);

/** @public */
export function readPublicationState(
	state: RepositoryChangeState,
	namespace: string,
): PublicationState {
	const stored = publicationObject(publicationObject(state.extensionState)[namespace]);
	return {
		...initialPublicationState,
		...stored,
		delivery: {
			...initialDeliveryState,
			...publicationObject(stored.delivery),
		},
	} as PublicationState;
}

/** @public */
export function patchPublicationState(
	state: RepositoryChangeState,
	namespace: string,
	patch: Partial<Omit<PublicationState, "delivery">> & {
		/** @public */
		delivery?: Partial<DeliveryState>;
	},
): RepositoryChangeState {
	const current = readPublicationState(state, namespace);
	return {
		...state,
		extensionState: {
			...state.extensionState,
			[namespace]: {
				...current,
				...patch,
				delivery: { ...current.delivery, ...patch.delivery },
			},
		},
	};
}

/** @public */
export function applyPublicationEvidence(
	params: unknown,
	current: PublicationState,
	evidence: PublicationEvidence,
	countFailure = true,
): PublicationState {
	if (evidence.observationKey !== undefined)
		current = { ...current, observationKey: evidence.observationKey };
	if (evidence.remoteHeadSha && evidence.remoteHeadSha !== current.headSha)
		current = {
			...current,
			workBaselineSha: current.workBaselineSha ?? current.headSha,
			lastPublishedHeadSha: current.lastPublishedHeadSha ?? current.headSha,
			headSha: evidence.remoteHeadSha,
			pipeline: null,
		};
	switch (evidence.kind) {
		case "feedback": {
			const { kind: _, ...batch } = evidence;
			return { ...current, ...batch, repairReason: "feedback" };
		}
		case "failure":
			return {
				...current,
				repairReason: "ci",
				pipeline: evidence.pipeline,
				ciRecoveryCycles: current.ciRecoveryCycles + (countFailure ? 1 : 0),
			};
		case "conflict": {
			const repository = requirePublicationParams(params);
			const conflict = validateConflict(
				evidence.conflict,
				{
					owner: repository.owner,
					repo: repository.repo,
					prNumber: current.prNumber ?? 0,
					headSha: current.headSha ?? "",
					headBranch: repository.workBranch,
					baseBranch: repository.baseBranch,
				},
				current.lastConflictKey,
			);
			return {
				...current,
				conflict,
				lastConflictKey: conflictKey(conflict),
				repairReason: "rebase",
			};
		}
		case "terminal":
			return {
				...current,
				delivery: { ...current.delivery, terminalPullRequest: evidence.request },
			};
		default:
			return current;
	}
}
function deliveryProgress(value: PublicationState, label: string, activeStepId?: string) {
	const delivery = value.delivery;
	const step = (id: string, label: string, done: boolean) => ({
		id,
		label,
		status: (activeStepId === id ? "in_progress" : done ? "completed" : "incomplete") as
			| "in_progress"
			| "completed"
			| "incomplete",
	});
	const adjustmentHandled =
		delivery.adjustment === null && delivery.stage === "awaiting" && value.headSha !== null;
	return {
		title: "Delivery progress",
		steps: [
			step("publish_branch", "Publish work branch", value.headSha !== null),
			step("open_pr", "Create or find pull request", value.prNumber !== null),
			step("link_issue", "Link source issue when applicable", delivery.issueLinked),
			step("publish_adjustment", "Publish an adjustment when applicable", adjustmentHandled),
			step(
				"reply_feedback",
				"Acknowledge or reply to feedback when applicable",
				value.feedbackIds.length === 0,
			),
			step("await_evidence", "Await external evidence", delivery.stage === "awaiting"),
			step(
				"reconcile_terminal",
				"Reconcile terminal pull request",
				delivery.terminalPullRequest !== null,
			),
		],
		...(value.prNumber && value.prUrl
			? {
					links: [
						{
							id: `${label}-pr-${value.prNumber}`,
							label: `${label} #${value.prNumber}`,
							url: value.prUrl,
							kind: "pull_request" as const,
						},
					],
				}
			: {}),
	};
}

/** @public */
export function createRepositoryChangePublication<P>(
	adapter: RepositoryChangePublicationAdapter<P>,
) {
	const ids = adapter.ids;
	const publication = flow.fragment<P, RepositoryChangeState>(`${adapter.namespace}-publication`);
	const { activeKey, select } = createPublicationSelection(() => adapter.namespace);
	const namespace = (state: RepositoryChangeState) =>
		adapter.repositories ? `${adapter.namespace}:${activeKey(state)}` : adapter.namespace;
	const remote = (state: RepositoryChangeState) => readPublicationState(state, namespace(state));
	const repositoryContext = (ctx: PublicationContext<P>): PublicationContext<P> => {
		if (!adapter.repositories) return ctx;
		const selected = adapter
			.repositories(ctx.params)
			.find((repo) => repo.key === activeKey(ctx.state));
		if (!selected) throw new Error("Missing coordinated repository selection");
		return {
			...ctx,
			params: selected.params,
			repo: { ...ctx.repo, get: (key) => ctx.repo.get(key === "repo" ? selected.key : key) },
			callIntegrationTool: (name, args) =>
				ctx.callIntegrationTool(name, { ...args, projectKey: selected.key }),
		};
	};
	const patchRemote = (
		state: RepositoryChangeState,
		patch: Partial<Omit<PublicationState, "delivery">> & { delivery?: Partial<DeliveryState> },
	) => patchPublicationState(state, namespace(state), patch);
	async function commitWorkBranch(
		ctx: PublicationContext<P>,
		commitMessage: string,
		expectedRemoteHead = remote(ctx.state).headSha,
	) {
		const repo = ctx.repo.get("repo");
		const gitIdentity = await adapter.identity(ctx);
		if (adapter.maintenance)
			await ctx.callIntegrationTool(adapter.maintenance.ownershipTool, { projectKey: repo.key });
		return commitAndPushWorkBranch({
			repoPath: repo.fsPath,
			projectKey: repo.key,
			workBranch: repo.workBranch,
			commitMessage,
			gitIdentity,
			expectedRemoteHead,
		});
	}
	const runRepository = async (ctx: PublicationContext<P>) => {
		let current = remote(ctx.state);
		const update = (patch: Parameters<typeof patchRemote>[1]) => {
			current = { ...current, ...patch, delivery: { ...current.delivery, ...patch.delivery } };
		};
		const result = (
			outcome:
				| "awaiting"
				| "feedback_ready"
				| "completed"
				| "aborted"
				| "ci_ready"
				| "conflict_ready"
				| "operator_action",
		) => ({
			outcome,
			params: { nextState: patchRemote(ctx.state, current) },
		});
		if (current.stopped) return result("aborted");
		if (current.pendingEvidence) {
			const evidence = current.pendingEvidence;
			const needsOperator = evidence.kind === "failure" && current.ciRecoveryCycles >= 3;
			current = applyPublicationEvidence(ctx.params, current, evidence, !needsOperator);
			current.pendingEvidence = null;
			if (evidence.kind === "cancelled") return result("aborted");
			if (evidence.kind === "failure")
				return result(needsOperator ? "operator_action" : "ci_ready");
			if (evidence.kind === "conflict") return result("conflict_ready");
		}
		ctx.reportProgress(deliveryProgress(current, adapter.label));
		const reconcile = async (): Promise<ReconciliationResult> => {
			const repo = ctx.repo.get("repo");
			return reconcilePublicationRepository({
				projectKey: repo.key,
				repoPath: repo.fsPath,
				workBranch: repo.workBranch,
				baselineSha: current.workBaselineSha ?? current.headSha ?? undefined,
				gitIdentity: await adapter.identity(ctx),
			});
		};
		const reconcileAgain = () => {
			const cycles = (current.reconciliationCycles ?? 0) + 1;
			update({
				reconciliationRequired: true,
				reconciliationCycles: cycles,
				repairPending: true,
				conflict: null,
				lastConflictKey: null,
				pipeline: null,
				delivery: { adjustment: null, feedbackResult: null },
			});
			return result(cycles > 3 ? "operator_action" : "conflict_ready");
		};

		if (current.delivery.terminalPullRequest) {
			ctx.reportProgress(deliveryProgress(current, adapter.label, "reconcile_terminal"));
			const pr = current.delivery.terminalPullRequest;
			await adapter.reconcileTerminal(ctx, current, pr);
			ctx.reportProgress(deliveryProgress(current, adapter.label));
			return result(pr.merged ? "completed" : "aborted");
		}

		if (
			!current.headSha &&
			(adapter.repositories || adapter.unchanged) &&
			!repositoryHasChanges(
				ctx.repo.get("repo").fsPath,
				ctx.repo.get("repo").baseBranch,
				ctx.repo.get("repo").key,
			)
		) {
			update({ noChanges: true });
			await adapter.unchanged?.(ctx);
			return result("completed");
		}
		let publicationLease = current.headSha;
		if (
			(!current.headSha || current.delivery.adjustment) &&
			current.delivery.adjustment?.origin !== "rebase"
		) {
			const synchronized = await reconcile();
			if (synchronized.changed || synchronized.status === "conflicts") return reconcileAgain();
			// Fetch is authoritative even if the watcher has not observed a developer push yet.
			publicationLease = synchronized.remoteHead;
			if (current.headSha && synchronized.remoteHead && current.headSha !== synchronized.remoteHead)
				update({ headSha: synchronized.remoteHead, workBaselineSha: synchronized.remoteHead });
		}
		if (!current.headSha) {
			ctx.reportProgress(deliveryProgress(current, adapter.label, "publish_branch"));
			let published: { headSha: string };
			try {
				published = await commitWorkBranch(
					ctx,
					ctx.state.finalization.commitMessages?.[ctx.repo.get("repo").key] ??
						ctx.state.finalization.generatedCommitMessage ??
						"",
					publicationLease,
				);
			} catch (error) {
				if (!(error instanceof RemoteBranchChangedError)) throw error;
				return reconcileAgain();
			}
			update({
				headSha: published.headSha,
				workBaselineSha: published.headSha,
				lastPublishedHeadSha: published.headSha,
				reconciliationRequired: false,
				reconciliationCycles: 0,
				pipeline: null,
			});
			recordRepositoryPublication(
				{
					projectKey: ctx.repo.get("repo").key,
					repoPath: ctx.repo.get("repo").fsPath,
					workBranch: ctx.repo.get("repo").workBranch,
					baselineSha: published.headSha,
				},
				published.headSha,
			);
		}

		if (!current.prNumber || !current.prUrl) {
			ctx.reportProgress(deliveryProgress(current, adapter.label, "open_pr"));
			const pr = await adapter.ensureRequest(ctx);
			update({ prNumber: pr.number, prUrl: pr.html_url });
		}

		if (!current.delivery.issueLinked) {
			ctx.reportProgress(deliveryProgress(current, adapter.label, "link_issue"));
			await adapter.linkIssue(ctx, current);
			update({ delivery: { issueLinked: true } });
		}

		if (current.delivery.adjustment) {
			const adjustment = current.delivery.adjustment;
			if (adjustment.origin === "rebase" && !hasPreparedRebase(rebaseInput(ctx)))
				return reconcileAgain();
			let adjustmentPublished = false;
			if (adjustment.publishRequired || adjustment.origin === "rebase" || adapter.maintenance) {
				ctx.reportProgress(deliveryProgress(current, adapter.label, "publish_adjustment"));
				if (adapter.maintenance)
					await ctx.callIntegrationTool(adapter.maintenance.ownershipTool, {
						projectKey: ctx.repo.get("repo").key,
					});
				let published: { headSha: string };
				try {
					published =
						adjustment.origin === "rebase"
							? publishRebase(rebaseInput(ctx))
							: await commitWorkBranch(
									{ ...ctx, state: patchRemote(ctx.state, current) },
									adapter.commitMessage(adjustment.origin),
								);
				} catch (error) {
					if (error instanceof ConcurrentRebaseSourceError) {
						if (error.published) return reconcileAgain();
						const project = ctx.repo.get("repo");
						retainConcurrentRebase({
							projectKey: project.key,
							repoPath: project.fsPath,
							workBranch: project.workBranch,
							baselineSha: error.repair.originalHead,
							rebasedHead: error.repair.headSha,
							targetBase: error.repair.baseSha,
							gitIdentity: await adapter.identity(ctx),
						});
						return reconcileAgain();
					}
					if (!(error instanceof RemoteBranchChangedError)) throw error;
					return reconcileAgain();
				}
				if (adjustment.origin === "rebase") {
					const head = await adapter.head(ctx, current);
					if (head !== published.headSha)
						throw new Error("Pull request head has not caught up with rebase publication");
				}
				adjustmentPublished = published.headSha !== publicationLease;
				update({
					headSha: published.headSha,
					workBaselineSha: published.headSha,
					lastPublishedHeadSha: adjustmentPublished
						? published.headSha
						: current.lastPublishedHeadSha,
					reconciliationRequired: false,
					reconciliationCycles: 0,
					pipeline: published.headSha !== publicationLease ? null : current.pipeline,
				});
				recordRepositoryPublication(
					{
						projectKey: ctx.repo.get("repo").key,
						repoPath: ctx.repo.get("repo").fsPath,
						workBranch: ctx.repo.get("repo").workBranch,
						baselineSha: published.headSha,
					},
					published.headSha,
				);
			}
			if (adjustment.origin === "rebase") await adapter.afterRebase(ctx, current);
			if (adjustment.origin === "feedback" && !adapter.maintenance) {
				ctx.reportProgress(deliveryProgress(current, adapter.label, "reply_feedback"));
				await adapter.reply(ctx, current);
			}
			update({
				...(adjustment.origin === "feedback" && !adapter.maintenance ? { feedbackIds: [] } : {}),
				...(adjustment.origin === "rebase" ? { conflict: null } : {}),
				delivery: {
					adjustment: null,
					...(adjustment.origin === "feedback" && adapter.maintenance
						? {
								feedbackResult: {
									published: adjustmentPublished,
									summary: adjustmentPublished
										? "Review adjustment published"
										: (adjustment.summary ?? "No repository change was required"),
								},
							}
						: {}),
				},
			});
		}

		if (current.feedbackIds.length > 0 && !adapter.maintenance) {
			ctx.reportProgress(deliveryProgress(current, adapter.label, "reply_feedback"));
			await adapter.acknowledge(ctx, current);
			return result("feedback_ready");
		}

		update({ delivery: { stage: "awaiting" } });
		ctx.reportProgress(deliveryProgress(current, adapter.label, "await_evidence"));
		return result("awaiting");
	};
	const delivery = flow
		.automatic<P, RepositoryChangeState>(ids.deliver)
		.description("Deliver")
		.waitFor(({ state, params }) => {
			const states = adapter.repositories
				? adapter.repositories(params).map(({ key }) => select(state, key))
				: [state];
			return states.some((state) => {
				const current = remote(state);
				if (adapter.maintenance)
					return (
						!current.stopped &&
						!current.noChanges &&
						!current.delivery.terminalPullRequest &&
						(current.delivery.stage !== "awaiting" || !!current.delivery.adjustment)
					);
				return (
					current.delivery.stage !== "awaiting" ||
					!!current.pendingEvidence ||
					!!current.delivery.adjustment ||
					current.feedbackIds.length > 0 ||
					!!current.delivery.terminalPullRequest
				);
			});
		})
		.integrationTools(...adapter.tools.delivery)
		.run(async (ctx) => {
			if (!adapter.repositories) return runRepository(ctx);
			let state = ctx.state;
			const repositories = adapter.repositories(ctx.params);
			if (!repositories.length) throw new Error("No repositories are bound");
			const results = () =>
				repositories.map(({ key }) => ({ key, current: remote(select(state, key)) }));
			const finished = () => results().every(({ current }) => publicationFinished(current));
			// Terminal facts take precedence over cancellation, including after interrupted publication.
			const reconcileTerminals = async () => {
				for (const { key } of repositories) {
					state = select(state, key);
					const current = remote(state);
					if (publicationFinished(current)) continue;
					const terminal = await adapter.observeTerminal?.(
						repositoryContext({ ...ctx, state }),
						current,
					);
					if (terminal)
						state = patchRemote(state, {
							prNumber: terminal.number,
							prUrl: terminal.html_url,
							delivery: { terminalPullRequest: terminal },
						});
				}
			};
			await reconcileTerminals();
			let cancelled = false;
			for (const { key } of repositories) {
				state = select(state, key);
				if (publicationFinished(remote(state))) continue;
				if (await adapter.sourceCancelled?.({ ...ctx, state })) {
					await reconcileTerminals();
					cancelled = !finished();
					break;
				}
				const result = await runRepository(repositoryContext({ ...ctx, state }));
				state = result.params.nextState;
				if (!["awaiting", "completed", "aborted"].includes(result.outcome))
					return { ...result, params: { nextState: state } };
			}
			if (cancelled || finished()) {
				await adapter.reconcileAll?.({ ...ctx, state }, results(), cancelled);
				const requests = results().flatMap(({ current }) =>
					current.delivery.terminalPullRequest ? [current.delivery.terminalPullRequest] : [],
				);
				return {
					outcome:
						cancelled || (requests.length > 0 && requests.every((request) => !request.merged))
							? "aborted"
							: "completed",
					params: { nextState: state },
				};
			}
			return { outcome: "awaiting", params: { nextState: state } };
		});
	const outcome = (o: AutomaticOutcomeBuilder<P, RepositoryChangeState>, description: string) =>
		o
			.description(description)
			.object("nextState")
			.state(({ event }) => event.params.nextState as RepositoryChangeState);
	delivery
		.outcome("awaiting", (o) => outcome(o, "Delivery is waiting for external evidence").wait())
		.outcome("completed", (o) => outcome(o, "Merged pull request was reconciled").complete())
		.outcome("aborted", (o) =>
			outcome(o, "Closed pull request was reconciled").lifecycleStatus("aborted"),
		);
	if (!adapter.maintenance)
		delivery.outcome("feedback_ready", (o) =>
			outcome(o, "Pull request feedback is acknowledged and ready for revision").to(ids.feedback),
		);
	for (const [name, target] of [
		["ci_ready", ids.ciRepair],
		["conflict_ready", ids.feedback],
		["operator_action", ids.operator],
	] as const) {
		delivery.outcome(name, (o) => outcome(o, "Route observed delivery evidence").to(target));
	}
	for (const source of adapter.sources) {
		if (adapter.maintenance && source.kind === "observation") continue;
		const attach = (id: string, operator: boolean) =>
			delivery.externalAction(id, source.source, (external) => {
				external
					.label(source.label)
					.when(
						({ params, state }) =>
							(!source.enabled || source.enabled(params, state)) &&
							(source.kind === "cancelled" ||
								(adapter.repositories
									? adapter.repositories(params).map(({ key }) => remote(select(state, key)))
									: [remote(state)]
								).every(
									(current) =>
										current.noChanges ||
										current.delivery.terminalPullRequest ||
										!!(current.headSha && current.prNumber && current.prUrl),
								)) &&
							(source.kind !== "failure" || remote(state).ciRecoveryCycles >= 3 === operator),
					);
				if (source.kind === "cancelled") return external.lifecycleStatus("aborted");
				external.to(
					source.kind === "conflict"
						? ids.feedback
						: source.kind === "failure"
							? operator
								? ids.operator
								: ids.ciRepair
							: ids.deliver,
				);
				return external.effect((input) => {
					const evidence = source.read(input);
					const state =
						adapter.repositories && evidence.projectKey
							? select(input.state, evidence.projectKey)
							: input.state;
					const current = remote(state);
					return {
						state: patchRemote(
							state,
							source.kind === "observation"
								? { pendingEvidence: evidence }
								: applyPublicationEvidence(input.params, current, evidence, !operator),
						),
					};
				});
			});
		attach(source.id, false);
		if (source.kind === "failure") attach(source.operatorId ?? `${source.id}_operator`, true);
	}
	if (adapter.maintenance) {
		for (const [id, target] of [
			["feedback", ids.feedback],
			["conflict", ids.feedback],
			["ci", ids.ciRepair],
			["operator", ids.operator],
		] as const)
			delivery.externalAction(`maintenance_${id}`, adapter.maintenance.source, (action) =>
				action
					.label("Maintain MR")
					.to(target)
					.effect(({ event }) => ({ state: event.state })),
			);
	}
	publication.turn(delivery);
	function rebaseInput(ctx: {
		state: RepositoryChangeState;
		repo: { get(key: string): { fsPath: string; workBranch: string } };
	}) {
		const project = ctx.repo.get(activeKey(ctx.state) ?? "repo");
		const conflict = remote(ctx.state).conflict;
		if (!conflict) throw new Error("Missing conflict evidence");
		return {
			projectKey: activeKey(ctx.state) ?? "repo",
			path: project.fsPath,
			workBranch: project.workBranch,
			conflict,
		};
	}
	function repairReason(state: RepositoryChangeState, kind: "feedback" | "ci") {
		return kind === "feedback" && remote(state).repairReason === "rebase" ? "rebase" : kind;
	}

	function revisionPrompt(kind: "feedback" | "ci") {
		return (ctx: {
			state: RepositoryChangeState;
			prepared?: unknown;
			prompts?: { initial: string };
		}) => {
			const current = remote(ctx.state);
			const repository = adapter.repositories
				? `Repository: ${activeKey(ctx.state)}. Apply changes only to this checkout. `
				: "";
			if (asUnknownRecord(ctx.prepared)?.deferredRebase)
				return `${repository}${reconciliationPrompt}\nThe source branch or retained local work must be reconciled before the target-branch repair. Resolve any source reconciliation, then use changes_ready. Delivery will restore and validate the result before reassessing current target conflicts.`;
			if (current.reconciliationRequired)
				return `${repository}${reconciliationPrompt}\nValidate the reconciled repository, including retained local work, against the requested change and pending feedback: ${JSON.stringify(current.feedbackIds)}. Treat the current remote as authoritative; do not restore deliberately removed code simply to match an older plan. Use changes_ready after validation, even when no further edit is needed, so retained local changes are published. If blocked use cannot_repair.\nOriginal request for context: ${ctx.prompts?.initial ?? "Inspect the current repository and retained request"}`;
			if (repairReason(ctx.state, kind) === "rebase")
				return `${rebasePrompt} Evidence: ${JSON.stringify(current.conflict)}. Call changes_ready or no_changes when verified complete, cannot_repair when blocked.`;
			return `${adapter.repositories ? `Repository: ${activeKey(ctx.state)}. Apply changes only to this checkout. ` : ""}${adapter.prompt(kind, current)}\n\n${reconciliationPrompt}`;
		};
	}

	function revisionTurn(id: string, kind: "feedback" | "ci") {
		const turn = flow
			.llm<P, RepositoryChangeState>(id)
			.description(kind === "feedback" ? "Address Feedback" : "Fix CI")
			.waitFor(({ state }) => {
				const current = remote(state);
				return (
					!current.stopped &&
					!current.delivery.terminalPullRequest &&
					(kind === "feedback"
						? current.feedbackIds.length > 0 ||
							!!current.conflict ||
							!!current.reconciliationRequired
						: current.repairReason === "ci" && current.pipeline !== null)
				);
			})
			.executionPurpose(codingPurposes.implementation)
			.tools("read", "bash", "edit", "write")
			.resolveIntegrationTools((_params, state) =>
				repairReason(state, kind) === "rebase" && !remote(state).reconciliationRequired
					? []
					: adapter.tools[kind],
			)
			.prepare(async (ctx) => {
				const project = ctx.repo.get(activeKey(ctx.state) ?? "repo");
				const current = remote(ctx.state);
				const targetRebase =
					repairReason(ctx.state, kind) === "rebase" && !current.reconciliationRequired;
				// Resume Git's existing target repair; it must not be mistaken for source synchronization.
				if (targetRebase && hasPreparedRebase(rebaseInput(ctx)))
					return { rebase: startRebase(rebaseInput(ctx)) };
				ctx.reportProgress({
					title: "Repository reconciliation",
					steps: [
						{
							id: "reconcile_source",
							label: "Reconcile remote source and retained local work",
							status: "in_progress",
						},
					],
				});
				const reconciliation = reconcilePublicationRepository({
					projectKey: project.key,
					repoPath: project.fsPath,
					workBranch: project.workBranch,
					baselineSha: current.workBaselineSha ?? current.headSha ?? undefined,
					gitIdentity: await adapter.identity(repositoryContext(ctx)),
				});
				ctx.reportProgress({
					title: "Repository reconciliation",
					steps: [
						{
							id: "reconcile_source",
							label:
								reconciliation.status === "conflicts"
									? "Resolve source reconciliation conflicts"
									: "Remote source reconciled",
							status: reconciliation.status === "conflicts" ? "in_progress" : "completed",
						},
					],
				});
				if (targetRebase) {
					if (
						reconciliation.changed ||
						reconciliation.headSha !== current.conflict?.headSha ||
						repositoryWorktreeIsDirty({ projectKey: project.key, repoPath: project.fsPath })
					)
						return { reconciliation, deferredRebase: true };
					return { rebase: startRebase(rebaseInput(ctx)) };
				}
				return { reconciliation };
			})
			.freshPrimary()
			.prompt(revisionPrompt(kind));
		for (const [name, description] of [
			["changes_ready", "Repository changes are ready to publish"],
			["no_changes", "No repository change is required"],
		] as const) {
			turn.outcomeTool(name, (tool) =>
				tool
					.resultSummary()
					.description(description)
					.to(ids.deliver)
					.state(({ ctx, event }) =>
						patchRemote(ctx.state, {
							repairPending: false,
							delivery: {
								// Even no_changes must cross delivery's remote race check. It may
								// have inherited unpublished work or a concurrent developer push.
								adjustment: {
									origin: remote(ctx.state).reconciliationRequired
										? "feedback"
										: repairReason(ctx.state, kind),
									publishRequired:
										name === "changes_ready" || !!remote(ctx.state).reconciliationRequired,
									summary: String(
										event.params?.resultSummary ?? "No repository change was required",
									),
								},
							},
						}),
					),
			);
		}
		return turn.outcomeTool("cannot_repair", (tool) => {
			const outcome = tool.description("The adjustment requires operator action").to(ids.operator);
			return adapter.maintenance
				? outcome.state(({ ctx }) => patchRemote(ctx.state, { repairPending: false }))
				: outcome;
		});
	}

	publication.turn(revisionTurn(ids.feedback, "feedback"));
	publication.turn(revisionTurn(ids.ciRepair, "ci"));
	const maintenanceSource = adapter.maintenance?.source;
	publication.turn({
		id: ids.operator,
		definition: {
			kind: "human",
			description: "Repository repair needs operator action",
			operatorAttention: "required",
			...(maintenanceSource
				? {
						externalActions: Object.fromEntries(
							(["feedback", "conflict"] as const).map((id) => [
								`maintenance_${id}`,
								{
									id: `maintenance_${id}`,
									source: maintenanceSource,
									to: ids.feedback,
									label: "Maintain MR",
									effect: ({ event }: { event: unknown }) => ({
										state: (event as { state: RepositoryChangeState }).state,
									}),
								},
							]),
						),
					}
				: {}),
			actions: {
				retry_repair: {
					label: "Retry repair",
					acceptanceState: "accepted",
					branches: { feedback: { to: ids.feedback }, ci: { to: ids.ciRepair } },
					effect: adapter.maintenance
						? ({ ctx }) => ({ state: patchRemote(ctx.state, { reconciliationCycles: 0 }) })
						: undefined,
					choose: ({ ctx }) =>
						remote(ctx.state).repairReason === "rebase" ||
						remote(ctx.state).repairReason === "feedback" ||
						remote(ctx.state).reconciliationRequired
							? "feedback"
							: "ci",
				},
				resume_waiting: {
					label: "Resume waiting",
					acceptanceState: "accepted",
					to: ids.deliver,
					effect: ({ ctx }) => ({
						state: patchRemote(ctx.state, {
							repairPending: false,
							feedbackIds: [],
							delivery: { adjustment: null },
						}),
					}),
				},
				abort: { label: "Abort process", acceptanceState: "neutral", lifecycleStatus: "aborted" },
			},
		},
	});

	return {
		/** @public */
		entryTurnId: ids.deliver,

		/** @public */
		fragment: publication,

		/** @public */
		happyPath: [ids.deliver],
	};
}
