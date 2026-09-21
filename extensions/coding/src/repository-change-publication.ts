import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type ExternalActionSource,
	type FlowAutomaticRunContext,
	flow,
} from "@leitwerk-dev/process-sdk";
import {
	type ConflictEvidence,
	conflictKey,
	validateConflict,
} from "@leitwerk-dev/repository-rebase";
import { publishRebase, startRebase } from "@leitwerk-dev/repository-rebase/git";
import { rebasePrompt } from "@leitwerk-dev/repository-rebase/prompt";
import { commitAndPushWorkBranch, type GitIdentity } from "./finalization-git.js";
import type { RepositoryChangeState } from "./repository-change-state.js";

export interface PublicationRequest {
	number: number;
	html_url: string;
	merged: boolean;
	merge_commit_sha?: string | null;
}
export interface PublicationPipeline {
	number: number;
	status: string;
	[key: string]: unknown;
}
export interface PublicationParams {
	owner: string;
	repo: string;
	workBranch: string;
	baseBranch: string;
}
export type PublicationContext<P> = FlowAutomaticRunContext<P, RepositoryChangeState>;
export type PublicationEvidence = (
	| {
			kind: "feedback";
			feedbackIds: PublicationFeedbackId[];
			conversationCursor: number;
			reviewCursor: number;
			inlineCursor: number;
	  }
	| { kind: "failure"; pipeline: PublicationPipeline }
	| { kind: "conflict"; conflict: ConflictEvidence }
	| { kind: "terminal"; request: PublicationRequest }
	| { kind: "cancelled" }
	| { kind: "observed" }
) & { observationKey?: string };
export interface PublicationSource<P> {
	id: string;
	kind: "feedback" | "failure" | "conflict" | "terminal" | "cancelled" | "observation";
	operatorId?: string;
	label: string;
	source: ExternalActionSource<P, RepositoryChangeState, unknown>;
	enabled?(params: P): boolean;
	read(input: { params: P; state: RepositoryChangeState; event: unknown }): PublicationEvidence;
}
export interface RepositoryChangePublicationAdapter<P extends PublicationParams> {
	namespace: string;
	label: string;
	ids: { deliver: string; feedback: string; ciRepair: string; operator: string };
	tools: { delivery: readonly string[]; feedback: readonly string[]; ci: readonly string[] };
	sources: readonly PublicationSource<P>[];
	identity(ctx: PublicationContext<P>): Promise<GitIdentity>;
	ensureRequest(ctx: PublicationContext<P>): Promise<PublicationRequest>;
	reconcileTerminal(
		ctx: PublicationContext<P>,
		current: PublicationState,
		request: PublicationRequest,
	): Promise<void>;
	linkIssue(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;
	acknowledge(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;
	reply(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;
	afterRebase(ctx: PublicationContext<P>, current: PublicationState): Promise<void>;
	head(ctx: PublicationContext<P>, current: PublicationState): Promise<string>;
	prompt(kind: "feedback" | "ci", current: PublicationState): string;
	commitMessage(kind: "feedback" | "ci"): string;
}
export type PublicationFeedbackId = {
	kind: "conversation" | "review" | "inline";
	id: number;
	discussionId?: string;
};
type AdjustmentInvocation = {
	origin: "feedback" | "ci" | "rebase";
	publishRequired: boolean;
};

export interface DeliveryState {
	stage: "not_started" | "branch_published" | "pull_request_ready" | "awaiting";
	issueLinked: boolean;
	adjustment: AdjustmentInvocation | null;
	terminalPullRequest: PublicationRequest | null;
}

export interface PublicationState {
	lastConflictKey?: string | null;
	conflict?: ConflictEvidence | null;
	repairReason?: "feedback" | "ci" | "rebase";
	headSha: string | null;
	prNumber: number | null;
	prUrl: string | null;
	conversationCursor: number;
	reviewCursor: number;
	inlineCursor: number;
	feedbackIds: PublicationFeedbackId[];
	pipeline: PublicationPipeline | null;
	ciRecoveryCycles: number;
	delivery: DeliveryState;
	observationKey?: string;
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

export const publicationObject = (value: unknown) => asUnknownRecord(value) ?? {};

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

export function patchPublicationState(
	state: RepositoryChangeState,
	namespace: string,
	patch: Partial<Omit<PublicationState, "delivery">> & { delivery?: Partial<DeliveryState> },
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

export function applyPublicationEvidence(
	params: PublicationParams,
	current: PublicationState,
	evidence: PublicationEvidence,
	countFailure = true,
): PublicationState {
	if (evidence.observationKey !== undefined)
		current = { ...current, observationKey: evidence.observationKey };
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
			const conflict = validateConflict(
				evidence.conflict,
				{
					owner: params.owner,
					repo: params.repo,
					prNumber: current.prNumber ?? 0,
					headSha: current.headSha ?? "",
					headBranch: params.workBranch,
					baseBranch: params.baseBranch,
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

export function createRepositoryChangePublication<P extends PublicationParams>(
	adapter: RepositoryChangePublicationAdapter<P>,
) {
	const applyEvidence = applyPublicationEvidence;
	const ids = adapter.ids;
	const publication = flow.fragment<P, RepositoryChangeState>(`${adapter.namespace}-publication`);
	const remote = (state: RepositoryChangeState) => readPublicationState(state, adapter.namespace);
	const patchRemote = (
		state: RepositoryChangeState,
		patch: Partial<Omit<PublicationState, "delivery">> & { delivery?: Partial<DeliveryState> },
	) => patchPublicationState(state, adapter.namespace, patch);
	async function commitWorkBranch(ctx: PublicationContext<P>, commitMessage: string) {
		const repo = ctx.repo.get("repo");
		return commitAndPushWorkBranch({
			repoPath: repo.fsPath,
			workBranch: repo.workBranch,
			commitMessage,
			gitIdentity: await adapter.identity(ctx),
		});
	}
	const delivery = flow
		.automatic<P, RepositoryChangeState>(ids.deliver)
		.description("Deliver")
		.integrationTools(...adapter.tools.delivery)
		.run(async (ctx) => {
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
			if (current.pendingEvidence) {
				const evidence = current.pendingEvidence;
				const needsOperator = evidence.kind === "failure" && current.ciRecoveryCycles >= 3;
				current = applyEvidence(ctx.params, current, evidence, !needsOperator);
				current.pendingEvidence = null;
				if (evidence.kind === "cancelled") return result("aborted");
				if (evidence.kind === "failure")
					return result(needsOperator ? "operator_action" : "ci_ready");
				if (evidence.kind === "conflict") return result("conflict_ready");
			}
			ctx.reportProgress(deliveryProgress(current, adapter.label));

			if (current.delivery.terminalPullRequest) {
				ctx.reportProgress(deliveryProgress(current, adapter.label, "reconcile_terminal"));
				const pr = current.delivery.terminalPullRequest;
				await adapter.reconcileTerminal(ctx, current, pr);
				ctx.reportProgress(deliveryProgress(current, adapter.label));
				return result(pr.merged ? "completed" : "aborted");
			}

			if (!current.headSha) {
				ctx.reportProgress(deliveryProgress(current, adapter.label, "publish_branch"));
				const published = await commitWorkBranch(
					ctx,
					ctx.state.finalization.generatedCommitMessage ?? "",
				);
				update({ headSha: published.headSha, pipeline: null });
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
				if (adjustment.publishRequired || adjustment.origin === "rebase") {
					ctx.reportProgress(deliveryProgress(current, adapter.label, "publish_adjustment"));
					const published =
						adjustment.origin === "rebase"
							? publishRebase(rebaseInput(ctx))
							: await commitWorkBranch(ctx, adapter.commitMessage(adjustment.origin));
					if (adjustment.origin === "rebase") {
						const head = await adapter.head(ctx, current);
						if (head !== published.headSha)
							throw new Error("Pull request head has not caught up with rebase publication");
					}
					update({ headSha: published.headSha, pipeline: null });
				}
				if (adjustment.origin === "rebase") await adapter.afterRebase(ctx, current);
				if (adjustment.origin === "feedback") {
					ctx.reportProgress(deliveryProgress(current, adapter.label, "reply_feedback"));
					await adapter.reply(ctx, current);
				}
				update({
					...(adjustment.origin === "feedback" ? { feedbackIds: [] } : {}),
					delivery: { adjustment: null },
				});
			}

			if (current.feedbackIds.length > 0) {
				ctx.reportProgress(deliveryProgress(current, adapter.label, "reply_feedback"));
				await adapter.acknowledge(ctx, current);
				return result("feedback_ready");
			}

			update({ delivery: { stage: "awaiting" } });
			ctx.reportProgress(deliveryProgress(current, adapter.label, "await_evidence"));
			return result("awaiting");
		})
		.outcome("awaiting", (outcome) =>
			outcome
				.description("Delivery is waiting for external evidence")
				.object("nextState")
				.wait()
				.state(({ event }) => event.params.nextState as RepositoryChangeState),
		)
		.outcome("feedback_ready", (outcome) =>
			outcome
				.description("Pull request feedback is acknowledged and ready for revision")
				.object("nextState")
				.to(ids.feedback)
				.state(({ event }) => event.params.nextState as RepositoryChangeState),
		)
		.outcome("completed", (outcome) =>
			outcome
				.description("Merged pull request was reconciled")
				.object("nextState")
				.complete()
				.state(({ event }) => event.params.nextState as RepositoryChangeState),
		)
		.outcome("aborted", (outcome) =>
			outcome
				.description("Closed pull request was reconciled")
				.object("nextState")
				.lifecycleStatus("aborted")
				.state(({ event }) => event.params.nextState as RepositoryChangeState),
		);
	for (const [outcome, target] of [
		["ci_ready", ids.ciRepair],
		["conflict_ready", ids.feedback],
		["operator_action", ids.operator],
	] as const) {
		delivery.outcome(outcome, (o) =>
			o
				.description("Route observed delivery evidence")
				.object("nextState")
				.to(target)
				.state(({ event }) => event.params.nextState as RepositoryChangeState),
		);
	}
	for (const source of adapter.sources) {
		const attach = (id: string, operator: boolean) =>
			delivery.externalAction(id, source.source, (external) => {
				external
					.label(source.label)
					.when(
						({ params, state }) =>
							(!source.enabled || source.enabled(params)) &&
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
					const current = remote(input.state);
					return {
						state: patchRemote(
							input.state,
							source.kind === "observation"
								? { pendingEvidence: evidence }
								: applyEvidence(input.params, current, evidence, !operator),
						),
					};
				});
			});
		attach(source.id, false);
		if (source.kind === "failure") attach(source.operatorId ?? `${source.id}_operator`, true);
	}
	publication.turn(delivery);
	function rebaseInput(ctx: {
		state: RepositoryChangeState;
		repo: { get(key: string): { fsPath: string; workBranch: string } };
	}) {
		const project = ctx.repo.get("repo");
		const conflict = remote(ctx.state).conflict;
		if (!conflict) throw new Error("Missing conflict evidence");
		return { projectKey: "repo", path: project.fsPath, workBranch: project.workBranch, conflict };
	}
	function repairReason(state: RepositoryChangeState, kind: "feedback" | "ci") {
		return kind === "feedback" && remote(state).repairReason === "rebase" ? "rebase" : kind;
	}

	function revisionPrompt(kind: "feedback" | "ci") {
		return (ctx: { state: RepositoryChangeState }) => {
			const current = remote(ctx.state);
			if (repairReason(ctx.state, kind) === "rebase")
				return `${rebasePrompt} Evidence: ${JSON.stringify(current.conflict)}. Call changes_ready or no_changes when verified complete, cannot_repair when blocked.`;
			return adapter.prompt(kind, current);
		};
	}

	function revisionTurn(id: string, kind: "feedback" | "ci") {
		const turn = flow
			.llm<P, RepositoryChangeState>(id)
			.description(kind === "feedback" ? "Address Feedback" : "Fix CI")
			.tools("read", "bash", "edit", "write")
			.resolveIntegrationTools((_params, state) =>
				repairReason(state, kind) === "rebase" ? [] : adapter.tools[kind],
			)
			.prepare((ctx) =>
				repairReason(ctx.state, kind) === "rebase" ? startRebase(rebaseInput(ctx)) : {},
			)
			.freshPrimary()
			.prompt(revisionPrompt(kind));
		for (const [name, description, publishRequired] of [
			["changes_ready", "Repository changes are ready to publish", true],
			["no_changes", "No repository change is required", false],
		] as const) {
			turn.outcomeTool(name, (tool) =>
				tool
					.resultSummary()
					.description(description)
					.to(ids.deliver)
					.state(({ ctx }) =>
						patchRemote(ctx.state, {
							delivery: { adjustment: { origin: repairReason(ctx.state, kind), publishRequired } },
						}),
					),
			);
		}
		return turn.outcomeTool("cannot_repair", (tool) =>
			tool.description("The adjustment requires operator action").to(ids.operator),
		);
	}

	publication.turn(revisionTurn(ids.feedback, "feedback"));
	publication.turn(revisionTurn(ids.ciRepair, "ci"));
	publication.turn({
		id: ids.operator,
		definition: {
			kind: "human",
			description: "Repository repair needs operator action",
			operatorAttention: "required",
			actions: {
				retry_repair: {
					label: "Retry repair",
					acceptanceState: "accepted",
					branches: { feedback: { to: ids.feedback }, ci: { to: ids.ciRepair } },
					choose: ({ ctx }) =>
						remote(ctx.state).repairReason === "rebase" ||
						remote(ctx.state).repairReason === "feedback"
							? "feedback"
							: "ci",
				},
				resume_waiting: {
					label: "Resume waiting",
					acceptanceState: "accepted",
					to: ids.deliver,
					effect: ({ ctx }) => ({
						state: patchRemote(ctx.state, {
							feedbackIds: [],
							delivery: { adjustment: null },
						}),
					}),
				},
				abort: { label: "Abort process", acceptanceState: "neutral", lifecycleStatus: "aborted" },
			},
		},
	});

	return { entryTurnId: ids.deliver, fragment: publication, happyPath: [ids.deliver] };
}
