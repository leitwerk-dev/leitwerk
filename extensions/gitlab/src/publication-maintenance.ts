import {
	applyPublicationEvidence,
	createPublicationSelection,
	type PublicationContext,
	type PublicationEvidence,
	patchPublicationState,
	publicationFinished,
	type RepositoryChangePublicationAdapter,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { conflictKey } from "@leitwerk-dev/coding/repository-rebase";
import type { ExtensionProcessDefinition, ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { type GitLabMaintenanceContext, registerGitLabMaintainedProcess } from "./maintenance.js";
import {
	type GitLabPublicationParams,
	gitlabPublicationEvidenceForRequest,
	gitlabPublicationRequest,
} from "./publication.js";

/** The publication adapter retains repair policy and budgets; maintenance owns its delivery edges. @internal */
export function registerGitLabPublicationMaintenance<P extends GitLabPublicationParams>(
	api: ServerExtensionAPI,
	process: ExtensionProcessDefinition<P, RepositoryChangeState>,
	adapter: RepositoryChangePublicationAdapter<P>,
): void {
	const namespace = (key: string) =>
		adapter.repositories ? `${adapter.namespace}:${key}` : adapter.namespace;
	const current = (ctx: GitLabMaintenanceContext<P, RepositoryChangeState>, key: string) =>
		readPublicationState(ctx.state, namespace(key));
	const params = (ctx: GitLabMaintenanceContext<P, RepositoryChangeState>, key: string) =>
		adapter.repositories?.(ctx.params).find((repository) => repository.key === key)?.params ??
		ctx.params;
	const patch = (
		ctx: GitLabMaintenanceContext<P, RepositoryChangeState>,
		key: string,
		value: Parameters<typeof patchPublicationState>[2],
	) => patchPublicationState(ctx.state, namespace(key), value);
	const selection = createPublicationSelection(() => adapter.namespace);
	const select = (state: RepositoryChangeState, key: string) =>
		adapter.repositories ? selection.select(state, key) : state;
	const repositories = (ctx: GitLabMaintenanceContext<P, RepositoryChangeState>) =>
		adapter.repositories?.(ctx.params) ?? [{ key: "repo", params: ctx.params }];
	const results = (ctx: GitLabMaintenanceContext<P, RepositoryChangeState>) =>
		repositories(ctx).map(({ key }) => ({ key, current: current(ctx, key) }));
	const workerContext = (
		ctx: GitLabMaintenanceContext<P, RepositoryChangeState>,
		key: string,
	): PublicationContext<P> =>
		({
			...ctx,
			params: params(ctx, key),
			state: select(ctx.state, key),
			repo: {
				get: (name: string) => {
					const project = ctx.projects.find(
						(project) => project.key === (name === "repo" ? key : name),
					);
					if (!project) throw new Error("Maintained process project is unavailable");
					return { ...project, fsPath: "", workBranch: project.workBranch ?? project.baseBranch };
				},
			},
			callIntegrationTool: (name: string, args: Record<string, unknown>) =>
				ctx.callIntegrationTool(name, { ...args, projectKey: key }),
		}) as unknown as PublicationContext<P>;
	registerGitLabMaintainedProcess(api, {
		processId: process.id,
		paramsCodec: process.paramsCodec,
		stateCodec: process.stateCodec,
		destinations: {
			feedback: "maintenance_feedback",
			conflict: "maintenance_conflict",
			ci: "maintenance_ci",
		},
		idleTurnId: adapter.ids.deliver,
		currentBinding: (ctx) => (adapter.repositories ? selection.activeKey(ctx.state) : "repo"),
		settings: (ctx, binding) => ({
			cursor: current(ctx, binding.projectKey).conversationCursor,
			quietPeriodMs: 120_000,
			pollInterval: "30s",
		}),
		observe(ctx, binding, observed) {
			const key = binding.projectKey;
			let value = current(ctx, key);
			const p = params(ctx, key);
			if (publicationFinished(value)) return { state: ctx.state };
			if (
				ctx.process.selectedTurnId === adapter.ids.deliver &&
				!ctx.process.currentExecution &&
				!value.delivery.adjustment &&
				!value.delivery.feedbackResult
			) {
				if (value.feedbackIds.length) return { state: select(ctx.state, key), action: "feedback" };
				if (value.conflict && value.repairReason === "rebase")
					return { state: select(ctx.state, key), action: "conflict" };
				if (value.repairPending && value.repairReason === "ci" && value.pipeline)
					return { state: select(ctx.state, key), action: "ci" };
			}
			// Preserve staged legacy evidence without replaying its old Deliver execution.
			let evidence: PublicationEvidence;
			if (value.pendingEvidence) {
				evidence = value.pendingEvidence;
				value = { ...value, pendingEvidence: null };
			} else {
				if (
					value.delivery.adjustment ||
					value.delivery.feedbackResult ||
					value.feedbackIds.length ||
					!value.headSha ||
					!value.prNumber
				)
					return { state: ctx.state };
				let event = observed;
				if (
					!observed.targetIntegrated &&
					observed.mr.sha === value.headSha &&
					observed.targetHead &&
					(observed.mr.has_conflicts ||
						["conflict", "need_rebase"].includes(observed.mr.detailed_merge_status ?? ""))
				) {
					if (
						observed.mr.source_project_id !== binding.projectId ||
						observed.mr.target_project_id !== binding.projectId ||
						observed.mr.source_branch !== p.workBranch ||
						observed.mr.target_branch !== p.baseBranch
					)
						throw new Error("GitLab maintenance branch binding changed");
					const conflict = {
						owner: p.owner,
						repo: p.repo,
						prNumber: value.prNumber,
						headBranch: p.workBranch,
						baseBranch: p.baseBranch,
						headSha: value.headSha,
						baseSha: observed.targetHead,
						url: observed.mr.web_url,
					};
					if (conflictKey(conflict) !== value.lastConflictKey) event = { ...observed, conflict };
				}
				evidence = gitlabPublicationEvidenceForRequest(value, event);
			}
			if (evidence.kind === "terminal")
				return {
					state: patch(ctx, key, {
						delivery: { terminalPullRequest: evidence.request },
					}),
				};
			const dispatch = (action: string, operator = false) => ({
				state: select(
					patch(ctx, key, {
						...applyPublicationEvidence(p, value, evidence, !operator),
						repairPending: !operator,
						// Dispatch does not consume feedback; publication/no-change acknowledgement does.
						...(evidence.kind === "feedback"
							? { conversationCursor: value.conversationCursor }
							: {}),
					}),
					key,
				),
				action,
			});
			if (evidence.kind === "feedback" || evidence.kind === "conflict")
				return dispatch(evidence.kind);
			// Labels, mergeability and target-head changes do not create a new CI failure.
			// Keeping the last pipeline status also admits a retry that runs and fails again.
			if (
				evidence.kind === "failure" &&
				(value.pipeline?.status !== "failed" ||
					value.pipeline.number !== evidence.pipeline.number ||
					(value.pipeline.project_id ?? binding.projectId) !==
						(evidence.pipeline.project_id ?? binding.projectId))
			) {
				const operator = value.ciRecoveryCycles >= 3;
				return dispatch(operator ? "maintenance_operator" : "ci", operator);
			}
			return {
				state: patch(ctx, key, {
					...value,
					observationKey: observed.observationKey,
					pipeline: observed.pipeline
						? { ...observed.pipeline, number: observed.pipeline.id }
						: null,
					...(observed.pipeline?.status === "success" ? { ciRecoveryCycles: 0 } : {}),
				}),
			};
		},
		stopped: (ctx, binding) => {
			const value = current(ctx, binding.projectKey);
			let state = patch(ctx, binding.projectKey, {
				stopped: true,
				prNumber: value.prNumber ?? binding.iid,
				prUrl:
					value.prUrl ??
					ctx.projects.find((project) => project.key === binding.projectKey)?.externalUrl ??
					null,
				repairPending: false,
				feedbackIds: [],
				pendingEvidence: null,
				delivery: { adjustment: null, feedbackResult: null },
			});
			// Adopt an interrupted legacy repair without replaying its consumed CI evidence or budget.
			const activeKey = selection.activeKey(ctx.state);
			if (
				ctx.process.currentExecution &&
				ctx.process.selectedTurnId === adapter.ids.ciRepair &&
				activeKey &&
				activeKey !== binding.projectKey
			)
				state = patch({ ...ctx, state }, activeKey, { repairPending: true });
			return state;
		},
		terminal: (ctx, binding, observed) =>
			patch(ctx, binding.projectKey, {
				repairPending: false,
				pendingEvidence: null,
				delivery: { terminalPullRequest: gitlabPublicationRequest(observed.mr) },
			}),
		messages(ctx, binding) {
			const value = current(ctx, binding.projectKey);
			const outcome = value.delivery.feedbackResult;
			if (!outcome) return [];
			return [
				...new Map(
					value.feedbackIds.map((note) => {
						if (!note.discussionId) throw new Error("GitLab feedback discussion is missing");
						return [
							note.discussionId,
							{
								discussionId: note.discussionId,
								writeKey: `gitlab:${ctx.process.id}:feedback-reply:${note.id}:${value.headSha}:${outcome.published ? "published" : "no-change"}`,
								body: outcome.published
									? `Addressed in ${value.headSha?.slice(0, 8) ?? "the current revision"}.`
									: `No repository change was needed. ${outcome.summary}`,
							},
						];
					}),
				).values(),
			];
		},
		settled(ctx, binding) {
			const value = current(ctx, binding.projectKey);
			if (!value.delivery.feedbackResult) return ctx.state;
			return patch(ctx, binding.projectKey, {
				conversationCursor: Math.max(
					value.conversationCursor,
					...value.feedbackIds.map((note) => note.id),
				),
				feedbackIds: [],
				delivery: { stage: "awaiting", adjustment: null, feedbackResult: null },
			});
		},
		cancelled: (ctx) =>
			Promise.resolve(
				adapter.sourceCancelled?.(
					workerContext(ctx, adapter.repositories?.(ctx.params)[0]?.key ?? "repo"),
				) ?? false,
			),
		completion(ctx) {
			const observed = results(ctx);
			if (!observed.every(({ current }) => publicationFinished(current))) return undefined;
			const changed = observed.filter(({ current }) => !current.noChanges);
			return changed.length > 0 &&
				changed.every(({ current }) => !current.delivery.terminalPullRequest?.merged)
				? "aborted"
				: "completed";
		},
		async complete(ctx) {
			const observed = results(ctx);
			if (adapter.reconcileAll)
				await adapter.reconcileAll(
					workerContext(ctx, observed[0].key),
					observed,
					!observed.every(({ current }) => publicationFinished(current)),
				);
			else
				for (const { key, current } of observed)
					if (current.delivery.terminalPullRequest)
						await adapter.reconcileTerminal(
							workerContext(ctx, key),
							current,
							current.delivery.terminalPullRequest,
						);
		},
	});
}
