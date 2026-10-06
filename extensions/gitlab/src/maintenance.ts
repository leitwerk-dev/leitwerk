import { asUnknownRecord, type ProcessInstance, type ProcessProject } from "@leitwerk-dev/domain";
import type { ExternalWrites } from "@leitwerk-dev/external-writes";
import {
	bindExternalWrites,
	type ExternalWriteLogRepoLike,
} from "@leitwerk-dev/external-writes/internal";
import {
	type Codec,
	type CoreServerSetupDeps,
	createCapabilityToken,
	type ExternalActionSource,
	type ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { GitLabIntegration } from "./capability.js";
import { type GitLabFeedback, type GitLabObservation, observeMergeRequest } from "./client.js";
import {
	type GitLabDeliveryObservation,
	gitLabFeedbackReadyAt,
	observationKey,
	pendingGitLabFeedback,
} from "./external.js";
import {
	ensureGitLabMaintenanceLabels,
	GITLAB_ACTIVE_LABEL,
	gitLabActivationStatus,
	readGitLabLabels,
} from "./maintenance-labels.js";
import { ensureGitLabComment, ensureGitLabSeenReaction, resolveGitLabBinding } from "./tools.js";

/** @public */
export const GITLAB_MAINTAINED_KIND = "@leitwerk-dev/gitlab.maintained";
/** Source for edges declared by a maintained process; no polling code belongs in the process. @public */
export function gitlabMaintenanceSource<P, S>(): ExternalActionSource<
	P,
	S,
	GitLabMaintenanceEvent<S>
> {
	return {
		kind: GITLAB_MAINTAINED_KIND,
		label: "GitLab MR maintenance",
		config: {},
		inputMode: "none",
		resolve: ({ params, state, projects }) => ({ params, state, projects }),
	};
}
/** @public */
export interface GitLabMaintenanceEvent<S> {
	/** @public */
	state: S;
}
/** @public */
export interface GitLabMaintenanceDestinations {
	/** @public */
	feedback: string;
	/** @public */
	conflict: string;
	/** @public */
	ci: string;
}
/** @public */
export interface GitLabMaintainedBinding {
	/** Process repository key. @public */ projectKey: string;
	/** @public */ profile: string;
	/** @public */ projectId: number;
	/** @public */ iid: number;
	/** Pinned installation. @public */ origin?: string;
}
/** @public */
export interface GitLabMaintenanceSettings {
	/** Consumed cursor; advance only after publication or a no-change result. @public */ cursor?: number;
	/** @public */ since?: string;
	/** @public */ quietPeriodMs?: number;
	/** @public */ pollInterval?: string;
	/** Original activation boundary, when adopting a receipt. @public */ activationAfter?: number;
	/** Existing activation receipt key, retained on upgrade. @public */ activationWriteKey?: string;
}
/** @public */
export interface GitLabMaintenanceContext<P, S> {
	/** @public */ readonly process: ProcessInstance;
	/** @public */ readonly projects: readonly ProcessProject[];
	/** @public */ readonly params: P;
	/** @public */ readonly state: S;
	/** @public */ readonly now: number;
	/** @public */ readonly signal: AbortSignal;
	/** @public */ readonly externalWrites: ExternalWrites;
	/** Project-bound operations on the server, using the durable external-write log. @public */
	callIntegrationTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
/** @public */
export interface GitLabMaintenanceDecision<S> {
	/** @public */ state: S;
	/** Destination key, or an additional recovery action declared by the process. @public */ action?: string;
	/** Process-specific event fields supplied to its external edge. @public */ event?: Record<
		string,
		unknown
	>;
}
/** @public */
export interface GitLabMaintenanceMessage {
	/** @public */ writeKey: string;
	/** @public */ body: string;
	/** @public */ discussionId?: string;
}
/** @public */
export interface GitLabMaintainedProcess<
	P,
	S,
	O extends GitLabObservation = GitLabDeliveryObservation,
> {
	/** @public */ processId: string;
	/** @public */ paramsCodec: Codec<P>;
	/** @public */ stateCodec: Codec<S>;
	/** External edge identities for business work. @public */ destinations: GitLabMaintenanceDestinations;
	/** Defaults to gitlabMaintenanceSource. @public */ sourceKind?: string;
	/** Defaults to each project's GitLab metadata. @public */ bindings?(
		ctx: GitLabMaintenanceContext<P, S>,
	): readonly GitLabMaintainedBinding[];
	/** @public */ settings?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): GitLabMaintenanceSettings;
	/** Optional process-specific admission and diagnostic reads. @public */ assess?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): Promise<O>;
	/** Process-specific routing/scope admission for work, reactions and replies. @public */
	eligible?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
		observation: O,
	): boolean;
	/** Recheck process-specific write authorization before mutations. @public */
	canWrite?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): Promise<boolean>;
	/** Optional bounded infrastructure retry; repair budgets remain process policy. @public */
	retry?: GitLabMaintenanceRetry;
	/** Pure repair policy; shared maintenance supplies settled feedback and observations. @public */
	observe(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
		observation: O & GitLabDeliveryObservation,
	): GitLabMaintenanceDecision<S>;
	/** Persist a stopped binding in business results. @public */ stopped?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): S;
	/** Persist merge/closure in business results. @public */ terminal?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
		observation: GitLabObservation,
	): S;
	/** Existing gated business position used when in-flight work is superseded. @public */ idleTurnId: string;
	/** Binding for the selected repair or operator decision; unrelated idle work stays selected. @public */
	currentBinding?(ctx: GitLabMaintenanceContext<P, S>): string | undefined;
	/** Durable replies/exhaustion messages; mechanical delivery stays in the shared server. @public */ messages?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): readonly GitLabMaintenanceMessage[];
	/** Clear an acknowledged no-change or published batch. Called only after all messages are durable. @public */ settled?(
		ctx: GitLabMaintenanceContext<P, S>,
		binding: GitLabMaintainedBinding,
	): S;
	/** Optional cancellation of the source request, checked during running work and operator waits. @public */
	cancelled?(ctx: GitLabMaintenanceContext<P, S>): Promise<boolean>;
	/** Pure completion policy; ownership ends before remote completion writes. @public */
	completion?(
		ctx: GitLabMaintenanceContext<P, S>,
		records: Readonly<Record<string, GitLabMaintenanceRecord>>,
	): "completed" | "aborted" | undefined;
	/** Durable terminal writes; retried after completion without allocating a worker. @public */
	complete?(
		ctx: GitLabMaintenanceContext<P, S>,
		records: Readonly<Record<string, GitLabMaintenanceRecord>>,
	): Promise<void>;
}
/** @public */
export interface GitLabMaintenanceRetry {
	/** Maximum automatic retries per failed business execution. @public */
	maxAttempts: number;
}
/** Durable activation and observation, kept separately from worker-owned outcome snapshots. @public */
export interface GitLabMaintenanceRecord {
	/** @public */ binding: GitLabMaintainedBinding;
	/** @public */ after: number;
	/** @public */ status: "active" | "stopped" | "merged" | "closed";
	/** @public */ cursor: number;
	/** @public */ pendingFeedback: GitLabFeedback[];
	/** @public */ observation?: GitLabDeliveryObservation;
	/** @public */ refreshError?: string;
}
/** @public */
export interface GitLabMaintenance {
	/** @public */ register<P, S, O extends GitLabObservation>(
		policy: GitLabMaintainedProcess<P, S, O>,
	): void;
	/** Recheck remote ownership immediately before publication, replies or reactions. @public */
	assertOwnership(instanceId: string, projectKey: string, signal?: AbortSignal): Promise<void>;
	/** @public */ ownsProcess(processId: string): boolean;
}
/** @public */
export const gitlabMaintenance = createCapabilityToken<GitLabMaintenance>(
	"@leitwerk-dev/gitlab.maintenance",
);
/** Register a typed process policy through the existing capability registry. @public */
export function registerGitLabMaintainedProcess<P, S, O extends GitLabObservation>(
	api: ServerExtensionAPI,
	policy: GitLabMaintainedProcess<P, S, O>,
): void {
	const service = api.require(gitlabMaintenance);
	if (Array.isArray(service)) throw new Error("GitLab maintenance must be singular");
	service.register(policy);
}
/** @internal */
export const maintenanceRecords = (
	process: ProcessInstance,
): Record<string, GitLabMaintenanceRecord> =>
	(asUnknownRecord(process.metadata?.gitlabMaintenance) ?? {}) as Record<
		string,
		GitLabMaintenanceRecord
	>;

/** One server service owns all registered processes, including running work and operator waits. @internal */
export function createGitLabMaintenance(
	api: ServerExtensionAPI,
	deps: CoreServerSetupDeps,
	integration: GitLabIntegration,
	now: () => number = Date.now,
): GitLabMaintenance & {
	/** @internal */
	poll(): Promise<ReturnType<typeof emptyPollResult>>;
} {
	const policies = new Map<string, GitLabMaintainedProcess<unknown, unknown>>();
	const due = new Map<string, { at: number; failures: number; inputs: string }>();
	const completionDue = new Map<string, { at: number; failures: number }>();
	const workKey = (process: ProcessInstance) =>
		JSON.stringify([
			process.paramsJson,
			process.stateJson,
			process.planRevision,
			process.selectedTurnId,
			process.lifecycleStatus,
			process.currentExecution,
		]);
	const repo = deps.externalWrites as ExternalWriteLogRepoLike;
	const context = (
		process: ProcessInstance,
		policy: GitLabMaintainedProcess<unknown, unknown>,
	): GitLabMaintenanceContext<unknown, unknown> => ({
		process,
		projects: deps.projects.listByInstance(process.id),
		params: policy.paramsCodec.parse(JSON.parse(process.paramsJson ?? "null")),
		state: policy.stateCodec.parse(JSON.parse(process.stateJson ?? "null")),
		now: now(),
		signal: AbortSignal.timeout(30_000),
		externalWrites: bindExternalWrites(repo, process.id),
		callIntegrationTool: (name, args) => {
			if (!deps.callIntegrationTool)
				throw new Error("Server maintenance operations are unavailable");
			return deps.callIntegrationTool(
				process,
				String(args.projectKey ?? "repo"),
				name,
				args,
				AbortSignal.timeout(30_000),
			);
		},
	});
	const bindings = (
		ctx: GitLabMaintenanceContext<unknown, unknown>,
		policy: GitLabMaintainedProcess<unknown, unknown>,
	) =>
		policy.bindings?.(ctx) ??
		ctx.projects.flatMap((project) => {
			if (!asUnknownRecord(project.metadata?.gitlab)?.iid) return [];
			return [
				{
					projectKey: project.key,
					...resolveGitLabBinding({ process: ctx.process, project }, integration),
					origin: asUnknownRecord(project.metadata?.gitlab)?.origin as string | undefined,
				},
			];
		});
	const completionStatus = (
		ctx: GitLabMaintenanceContext<unknown, unknown>,
		policy: GitLabMaintainedProcess<unknown, unknown>,
		records: Record<string, GitLabMaintenanceRecord>,
	) => {
		if (policy.completion) return policy.completion(ctx, records);
		return bindings(ctx, policy).every(
			(binding) => records[binding.projectKey] && records[binding.projectKey].status !== "active",
		)
			? Object.values(records).some((record) => record.status === "merged")
				? ("completed" as const)
				: ("aborted" as const)
			: undefined;
	};
	const live = (process: ProcessInstance) =>
		!["completed", "aborted"].includes(process.lifecycleStatus);
	const unchangedWork = (fresh: ProcessInstance, expected: ProcessInstance) =>
		fresh.paramsJson === expected.paramsJson &&
		fresh.stateJson === expected.stateJson &&
		fresh.planRevision === expected.planRevision &&
		fresh.selectedTurnId === expected.selectedTurnId &&
		fresh.lifecycleStatus === expected.lifecycleStatus &&
		JSON.stringify(fresh.currentExecution) === JSON.stringify(expected.currentExecution);
	const same = (expected: ProcessInstance) => {
		const fresh = deps.processes.getById(expected.id);
		return (
			!!fresh &&
			fresh.paramsJson === expected.paramsJson &&
			fresh.stateJson === expected.stateJson &&
			fresh.planRevision === expected.planRevision &&
			fresh.selectedTurnId === expected.selectedTurnId &&
			fresh.lifecycleStatus === expected.lifecycleStatus &&
			JSON.stringify(fresh.metadata?.gitlabMaintenance) ===
				JSON.stringify(expected.metadata?.gitlabMaintenance) &&
			JSON.stringify(fresh.currentExecution) === JSON.stringify(expected.currentExecution)
		);
	};
	const service: GitLabMaintenance = {
		register(policy) {
			if (
				policy.retry &&
				(!Number.isInteger(policy.retry.maxAttempts) || policy.retry.maxAttempts < 0)
			)
				throw new Error("GitLab maintenance retries must be a nonnegative integer");
			if (policies.has(policy.processId))
				throw new Error(`Duplicate GitLab maintenance policy '${policy.processId}'`);
			policies.set(
				policy.processId,
				policy as unknown as GitLabMaintainedProcess<unknown, unknown>,
			);
		},
		ownsProcess: (processId) => policies.has(processId),
		async assertOwnership(instanceId, projectKey, signal) {
			let process = deps.processes.getById(instanceId);
			if (!process || !live(process)) throw new Error("GitLab maintenance ownership ended");
			const policy = policies.get(process.processId);
			if (!policy) return;
			let ctx = context(process, policy);
			const binding = bindings(ctx, policy).find((item) => item.projectKey === projectKey);
			if (!binding) return; // Initial publication has not created its MR yet.
			let record = maintenanceRecords(process)[projectKey];
			if (record && record.status !== "active")
				throw new Error("GitLab maintenance ownership ended");
			const client = integration.client(binding.profile);
			if (binding.origin && binding.origin !== client.baseUrl)
				throw new Error("GitLab installation changed");
			let labels = await readGitLabLabels(client, binding.projectId, binding.iid, signal);
			const settings = policy.settings?.(ctx, binding) ?? {};
			const activationKey =
				settings.activationWriteKey ?? `gitlab:active:${process.id}:${projectKey}:${binding.iid}`;
			if (!record) {
				if (repo.hasDedupKey(activationKey) && !labels.mr.labels.includes(GITLAB_ACTIVE_LABEL))
					throw new Error("GitLab maintenance ownership ended");
				record = {
					binding,
					after: settings.activationAfter ?? labels.events.at(-1)?.id ?? 0,
					status: "active",
					cursor: settings.cursor ?? 0,
					pendingFeedback: [],
				};
				const saved = await deps.commands.applyProcessObservation(process.id, {
					expected: process,
					projectsJson: JSON.stringify(ctx.projects),
					metadata: { gitlabMaintenance: { ...maintenanceRecords(process), [projectKey]: record } },
					preserveUpdatedAt: true,
				});
				if (!saved.ok) throw new Error("GitLab maintenance ownership changed");
				process = deps.processes.getById(instanceId);
				if (!process || !live(process)) throw new Error("GitLab maintenance ownership ended");
				const adopted = process;
				await ensureGitLabMaintenanceLabels({
					client,
					writes: ctx.externalWrites,
					projectId: binding.projectId,
					iid: binding.iid,
					after: record.after,
					status: "active",
					writeKey: activationKey,
					guard: async () => same(adopted),
					signal,
				});
				labels = await readGitLabLabels(client, binding.projectId, binding.iid, signal);
				ctx = context(process, policy);
			}
			const after = record.after;
			if (
				!same(process) ||
				labels.mr.state !== "opened" ||
				gitLabActivationStatus(after, labels) === "removed" ||
				!labels.mr.labels.includes(GITLAB_ACTIVE_LABEL)
			)
				throw new Error("GitLab maintenance ownership ended");
			if (policy.canWrite && !(await policy.canWrite(ctx, binding)))
				throw new Error("GitLab maintenance writes are suspended by process policy");
		},
	};
	api.provide(gitlabMaintenance, service);
	const polling = deps.polling.create({
		id: "gitlab-maintenance",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5000,
		async pollOnce() {
			const result = emptyPollResult();
			for (const snapshot of deps.processes.listAll()) {
				const policy = policies.get(snapshot.processId);
				if (!policy) continue;
				let ctx = context(snapshot, policy);
				for (const binding of bindings(ctx, policy)) {
					const key = `${snapshot.id}:${binding.projectKey}`;
					const previous = due.get(key);
					if (previous && previous.at > now() && previous.inputs === workKey(snapshot)) continue;
					try {
						const process = deps.processes.getById(snapshot.id);
						if (!process) continue;
						ctx = context(process, policy);
						const settings = policy.settings?.(ctx, binding) ?? {};
						const known = maintenanceRecords(process)[binding.projectKey];
						if (
							known &&
							known.status !== "active" &&
							process.metadata?.gitlabMaintenanceCompleted &&
							repo.hasDedupKey(
								`gitlab:${known.status}:${process.id}:${binding.projectKey}:${binding.iid}`,
							)
						)
							continue;
						const client = integration.client(binding.profile);
						if (binding.origin && client.baseUrl !== binding.origin)
							throw new Error("GitLab installation changed");
						const labels = await readGitLabLabels(
							client,
							binding.projectId,
							binding.iid,
							ctx.signal,
						);
						const records = structuredClone(maintenanceRecords(process));
						let record = records[binding.projectKey];
						if (record && JSON.stringify(record.binding) !== JSON.stringify(binding))
							throw new Error("Maintained MR binding changed");
						if (!record)
							record = records[binding.projectKey] = {
								binding,
								after: settings.activationAfter ?? labels.events.at(-1)?.id ?? 0,
								status: "active",
								cursor: settings.cursor ?? 0,
								pendingFeedback: [],
							};
						record.cursor = Math.max(record.cursor, settings.cursor ?? 0);
						const activationKey =
							settings.activationWriteKey ??
							`gitlab:active:${process.id}:${binding.projectKey}:${binding.iid}`;
						let stopped = false;
						let state = ctx.state;
						if (record.status === "active") {
							if (labels.mr.state !== "opened") {
								record.status = labels.mr.state === "merged" ? "merged" : "closed";
								state = policy.terminal?.(ctx, binding, { mr: labels.mr, pipeline: null }) ?? state;
								stopped = true;
								// Recovery does not need a living worker or an enabled discovery watcher.
							} else if (
								!live(process) ||
								gitLabActivationStatus(record.after, labels) === "removed" ||
								(repo.hasDedupKey(activationKey) && !labels.mr.labels.includes(GITLAB_ACTIVE_LABEL))
							) {
								record.status = "stopped";
								state = policy.stopped?.(ctx, binding) ?? state;
								stopped = true;
							}
						}
						delete record.refreshError;
						const terminalStatus =
							stopped && live(process)
								? completionStatus({ ...ctx, state }, policy, records)
								: undefined;
						const saved = await deps.commands.applyProcessObservation(process.id, {
							expected: process,
							projectsJson: JSON.stringify(ctx.projects),
							metadata: { gitlabMaintenance: records },
							...(state !== ctx.state ? { state } : {}),
							...(terminalStatus ? { lifecycleStatus: terminalStatus } : {}),
							...(stopped &&
							!terminalStatus &&
							live(process) &&
							(process.currentExecution ||
								(process.selectedTurnId !== policy.idleTurnId &&
									(!policy.currentBinding || policy.currentBinding(ctx) === binding.projectKey)))
								? {
										interrupt: {
											turnId: policy.idleTurnId,
											reason: "MR maintenance ownership ended",
										},
									}
								: {}),
							preserveUpdatedAt: !stopped,
						});
						if (!saved.ok) continue;
						let fresh = deps.processes.getById(process.id);
						if (!fresh) continue;
						await ensureGitLabMaintenanceLabels({
							client,
							writes: ctx.externalWrites,
							projectId: binding.projectId,
							iid: binding.iid,
							after: record.after,
							status: record.status,
							writeKey:
								record.status === "active"
									? activationKey
									: `gitlab:${record.status}:${process.id}:${binding.projectKey}:${binding.iid}`,
							guard: async () => same(fresh as ProcessInstance),
							signal: ctx.signal,
						});
						if (!live(fresh) || record.status !== "active") {
							due.set(key, {
								at: now() + parseDurationMs(settings.pollInterval ?? "30s", 30_000),
								failures: 0,
								inputs: workKey(deps.processes.getById(process.id) ?? process),
							});
							continue;
						}
						ctx = context(fresh, policy);
						const observation = policy.assess
							? await policy.assess(ctx, binding)
							: await observeMergeRequest(client, binding.projectId, binding.iid, ctx.signal);
						const eligible = policy.eligible?.(ctx, binding, observation) ?? true;
						const feedback = eligible
							? pendingGitLabFeedback(
									"feedback" in observation
										? ((observation.feedback as GitLabFeedback[]) ?? [])
										: await client.listMergeRequestFeedback(
												binding.projectId,
												binding.iid,
												ctx.signal,
											),
									Math.max(record.cursor, settings.cursor ?? 0),
									settings.since,
								)
							: [];
						for (const note of feedback) {
							await service.assertOwnership(fresh.id, binding.projectKey, ctx.signal);
							await ensureGitLabSeenReaction({
								client,
								writes: ctx.externalWrites,
								instanceId: fresh.id,
								projectId: binding.projectId,
								iid: binding.iid,
								noteId: note.id,
								signal: ctx.signal,
								beforeWrite: () =>
									service.assertOwnership(fresh?.id ?? "", binding.projectKey, ctx.signal),
							});
						}
						const ready = gitLabFeedbackReadyAt(feedback, settings.quietPeriodMs ?? 120_000);
						const targetIntegrated =
							observation.targetHead &&
							client.getMergeBase &&
							observation.mr.source_project_id === observation.mr.target_project_id &&
							(observation.mr.has_conflicts ||
								["conflict", "need_rebase"].includes(observation.mr.detailed_merge_status ?? ""))
								? (
										await client.getMergeBase(
											observation.mr.source_project_id,
											[observation.mr.sha, observation.targetHead],
											ctx.signal,
										)
									).id === observation.targetHead
								: false;
						const observed = {
							...observation,
							targetIntegrated,
							projectKey: binding.projectKey,
							observationKey: observationKey(observation),
							feedback: ready !== null && ready <= now() ? feedback : [],
						};
						const decision = policy.observe(ctx, binding, observed);
						record.observation = observed;
						record.pendingFeedback = feedback;
						const observedRecords = { ...maintenanceRecords(fresh), [binding.projectKey]: record };
						const updated = await deps.commands.applyProcessObservation(fresh.id, {
							expected: fresh,
							projectsJson: JSON.stringify(ctx.projects),
							metadata: { gitlabMaintenance: observedRecords },
							...(!fresh.currentExecution && decision.state !== ctx.state && !decision.action
								? { state: decision.state }
								: {}),
							preserveUpdatedAt: true,
						});
						if (!updated.ok) continue;
						fresh = deps.processes.getById(process.id);
						if (!fresh) continue;
						if (
							eligible &&
							decision.action &&
							fresh.lifecycleStatus === "waiting" &&
							unchangedWork(fresh, ctx.process)
						) {
							const destination =
								policy.destinations[decision.action as keyof typeof policy.destinations] ??
								decision.action;
							const armed = deps.externalSources
								.listArmed(policy.sourceKind ?? GITLAB_MAINTAINED_KIND)
								.find(
									(item) => item.instanceId === process.id && item.externalActionId === destination,
								);
							if (armed) {
								await service.assertOwnership(fresh.id, binding.projectKey, ctx.signal);
								const fired = await deps.externalSources.fire({
									instanceId: fresh.id,
									armingId: armed.id,
									generation: armed.generation,
									event: { ...decision.event, state: decision.state },
									mergeKey: `${binding.projectKey}:${observed.observationKey}:${feedback.map((note) => note.id)}`,
								});
								if (!fired.ok) continue;
							}
						}
						fresh = deps.processes.getById(process.id);
						if (!fresh || !live(fresh)) continue;
						ctx = context(fresh, policy);
						for (const message of eligible ? (policy.messages?.(ctx, binding) ?? []) : []) {
							await service.assertOwnership(fresh.id, binding.projectKey, ctx.signal);
							await ensureGitLabComment({
								client,
								writes: ctx.externalWrites,
								instanceId: fresh.id,
								projectId: binding.projectId,
								iid: binding.iid,
								...message,
								signal: ctx.signal,
								beforeWrite: () =>
									service.assertOwnership(fresh?.id ?? "", binding.projectKey, ctx.signal),
							});
						}
						const settledState = eligible
							? (policy.settled?.(ctx, binding) ?? ctx.state)
							: ctx.state;
						if (!fresh.currentExecution && settledState !== ctx.state)
							await deps.commands.applyProcessObservation(fresh.id, {
								expected: fresh,
								state: settledState,
							});
						fresh = deps.processes.getById(process.id);
						if (
							fresh &&
							eligible &&
							policy.retry &&
							fresh.lifecycleStatus === "error" &&
							fresh.currentExecution
						) {
							const retry = asUnknownRecord(fresh.metadata?.gitlabMaintenanceRetry) ?? {};
							const attempts = Number(retry.attempts ?? 0);
							if (retry.executionId !== fresh.currentExecution.id) {
								await deps.commands.applyProcessObservation(fresh.id, {
									expected: fresh,
									metadata: {
										gitlabMaintenanceRetry: {
											attempts,
											executionId: fresh.currentExecution.id,
											nextAt: now() + Math.min(300_000, 30_000 * 2 ** attempts),
											attempted: false,
										},
									},
									preserveUpdatedAt: true,
								});
							} else if (
								!retry.attempted &&
								attempts < policy.retry.maxAttempts &&
								Number(retry.nextAt) <= now()
							) {
								await service.assertOwnership(fresh.id, binding.projectKey, ctx.signal);
								const saved = await deps.commands.applyProcessObservation(fresh.id, {
									expected: fresh,
									metadata: {
										gitlabMaintenanceRetry: { ...retry, attempts: attempts + 1, attempted: true },
									},
								});
								if (saved.ok) await deps.commands.retryProcess(fresh.id);
							}
						} else if (
							fresh?.lifecycleStatus === "waiting" &&
							!fresh.currentExecution &&
							fresh.selectedTurnId === policy.idleTurnId &&
							fresh.metadata?.gitlabMaintenanceRetry
						) {
							await deps.commands.applyProcessObservation(fresh.id, {
								expected: fresh,
								metadata: { gitlabMaintenanceRetry: null },
								preserveUpdatedAt: true,
							});
						}
						due.set(key, {
							at: now() + parseDurationMs(settings.pollInterval ?? "30s", 30_000),
							failures: 0,
							inputs: workKey(deps.processes.getById(process.id) ?? process),
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : "GitLab maintenance unavailable";
						const failures = (previous?.failures ?? 0) + 1;
						due.set(key, {
							at: now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
							failures,
							inputs: workKey(deps.processes.getById(snapshot.id) ?? snapshot),
						});
						const fresh = deps.processes.getById(snapshot.id);
						if (fresh) {
							const records = structuredClone(maintenanceRecords(fresh));
							if (records[binding.projectKey]) {
								records[binding.projectKey].refreshError = message;
								await deps.commands.applyProcessObservation(fresh.id, {
									expected: fresh,
									metadata: { gitlabMaintenance: records },
								});
							}
						}
						result.errors.push(`${key}:${message}`);
					}
				}
				let current = deps.processes.getById(snapshot.id);
				if (
					current &&
					!current.metadata?.gitlabMaintenanceCompleted &&
					bindings(context(current, policy), policy).length
				) {
					try {
						ctx = context(current, policy);
						const records = maintenanceRecords(current);
						const schedule = completionDue.get(current.id);
						const pureStatus = completionStatus(ctx, policy, records);
						if (
							schedule &&
							schedule.at > now() &&
							(schedule.failures > 0 || (!pureStatus && live(current)))
						)
							continue;
						const status =
							pureStatus ??
							(live(current) && (await policy.cancelled?.(ctx)) ? "aborted" : undefined);
						if (status && live(current)) {
							const ended = await deps.commands.applyProcessObservation(current.id, {
								expected: current,
								lifecycleStatus: status,
							});
							if (!ended.ok) continue;
							current = deps.processes.getById(current.id);
						}
						if (current && (status || !live(current))) {
							await policy.complete?.(context(current, policy), maintenanceRecords(current));
							await deps.commands.applyProcessObservation(current.id, {
								expected: current,
								metadata: { gitlabMaintenanceCompleted: true },
							});
						}
						completionDue.set(snapshot.id, { at: now() + 30_000, failures: 0 });
					} catch (error) {
						const failures = (completionDue.get(snapshot.id)?.failures ?? 0) + 1;
						completionDue.set(snapshot.id, {
							at: now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
							failures,
						});
						result.errors.push(
							`${snapshot.id}:${error instanceof Error ? error.message : "Completion delivery unavailable"}`,
						);
					}
				}
			}
			return result;
		},
	});
	return { ...service, /** @internal */ poll: () => polling.poll() };
}
