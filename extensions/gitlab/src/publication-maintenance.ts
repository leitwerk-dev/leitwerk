import {
	applyPublicationEvidence,
	type PublicationContext,
	type PublicationEvidence,
	type PublicationParams,
	type PublicationRequest,
	type PublicationState,
	patchPublicationState,
	type RepositoryChangePublicationAdapter,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { conflictKey } from "@leitwerk-dev/coding/repository-rebase";
import type { ExtensionProcessDefinition, ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import type { GitLabDeliveryObservation } from "./external.js";
import { type GitLabMaintenanceContext, registerGitLabMaintainedProcess } from "./maintenance.js";
import {
	type GitLabPublicationParams,
	gitlabPublicationEvidenceForRequest,
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
		value: Partial<PublicationState>,
	) => patchPublicationState(ctx.state, namespace(key), value);
	const select = (state: RepositoryChangeState, key: string): RepositoryChangeState =>
		adapter.repositories
			? {
					...state,
					extensionState: {
						...state.extensionState,
						[`${adapter.namespace}.coordination`]: { activeKey: key },
					},
				}
			: state;
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
	const request = (observation: GitLabDeliveryObservation): PublicationRequest => ({
		number: observation.mr.iid,
		html_url: observation.mr.web_url,
		merged: observation.mr.state === "merged",
		merge_commit_sha: observation.mr.merge_commit_sha,
	});
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
		currentBinding: (ctx) =>
			adapter.repositories
				? (
						ctx.state.extensionState?.[`${adapter.namespace}.coordination`] as
							| { activeKey?: string }
							| undefined
					)?.activeKey
				: "repo",
		settings: (ctx, binding) => ({
			cursor: current(ctx, binding.projectKey).conversationCursor,
			quietPeriodMs: 120_000,
			pollInterval: "30s",
		}),
		observe(ctx, binding, observed) {
			const key = binding.projectKey;
			let value = current(ctx, key);
			const p = params(ctx, key);
			if (value.stopped || value.delivery.terminalPullRequest || value.noChanges)
				return { state: ctx.state };
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
						delivery: { ...value.delivery, terminalPullRequest: evidence.request },
					}),
				};
			if (evidence.kind === "feedback") {
				const applied = applyPublicationEvidence(p as PublicationParams, value, evidence);
				// Dispatching work does not consume the batch. Publication/no-change acknowledgement does.
				applied.conversationCursor = value.conversationCursor;
				applied.repairPending = true;
				return { state: select(patch(ctx, key, applied), key), action: "feedback" };
			}
			if (evidence.kind === "conflict")
				return {
					state: select(
						patch(ctx, key, {
							...applyPublicationEvidence(p, value, evidence),
							repairPending: true,
						}),
						key,
					),
					action: "conflict",
				};
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
				return {
					state: select(
						patch(ctx, key, {
							...applyPublicationEvidence(p, value, evidence, !operator),
							repairPending: !operator,
						}),
						key,
					),
					action: operator ? "maintenance_operator" : "ci",
				};
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
				delivery: {
					...current(ctx, binding.projectKey).delivery,
					adjustment: null,
					feedbackResult: null,
				},
			});
			// Adopt an interrupted legacy repair without replaying its consumed CI evidence or budget.
			const activeKey = (
				ctx.state.extensionState?.[`${adapter.namespace}.coordination`] as
					| { activeKey?: string }
					| undefined
			)?.activeKey;
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
				delivery: {
					...current(ctx, binding.projectKey).delivery,
					terminalPullRequest: request(observed),
				},
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
				delivery: { ...value.delivery, stage: "awaiting", adjustment: null, feedbackResult: null },
			});
		},
		cancelled: (ctx) =>
			Promise.resolve(
				adapter.sourceCancelled?.(
					workerContext(ctx, adapter.repositories?.(ctx.params)[0]?.key ?? "repo"),
				) ?? false,
			),
		completion(ctx) {
			const repositories = adapter.repositories?.(ctx.params) ?? [
				{ key: "repo", params: ctx.params },
			];
			const results = repositories.map(({ key }) => ({ key, current: current(ctx, key) }));
			const finished = results.every(
				({ current }) =>
					current.noChanges || current.stopped || current.delivery.terminalPullRequest,
			);
			if (!finished) return undefined;
			const changed = results.filter(({ current }) => !current.noChanges);
			return changed.length > 0 &&
				changed.every(({ current }) => !current.delivery.terminalPullRequest?.merged)
				? "aborted"
				: "completed";
		},
		async complete(ctx) {
			const repositories = adapter.repositories?.(ctx.params) ?? [
				{ key: "repo", params: ctx.params },
			];
			const results = repositories.map(({ key }) => ({ key, current: current(ctx, key) }));
			if (adapter.reconcileAll)
				await adapter.reconcileAll(
					workerContext(ctx, repositories[0].key),
					results,
					!results.every(
						({ current }) =>
							current.noChanges || current.stopped || current.delivery.terminalPullRequest,
					),
				);
			else
				for (const { key, current } of results)
					if (current.delivery.terminalPullRequest)
						await adapter.reconcileTerminal(
							workerContext(ctx, key),
							current,
							current.delivery.terminalPullRequest,
						);
		},
	});
}
