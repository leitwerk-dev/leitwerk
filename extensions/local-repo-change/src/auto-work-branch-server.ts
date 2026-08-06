import {
	buildAutoWorkBranch,
	generateAutoWorkBranchRandomHex,
	type ResolveBaseBranchShaInput,
	resolveBaseBranchSha,
} from "@leitwerk-dev/coding/auto-work-branch";
import { trimToNull, type WorkerErrorClass } from "@leitwerk-dev/domain";
import type {
	DeferredProcessActivationSnapshot,
	ProcessEngineLike,
	ServerExtensionLogger,
} from "@leitwerk-dev/process-sdk";
import {
	formatLocalRepoChangeLaunchErrors,
	localRepoChangeLaunchPlanner,
	localRepoChangeProcessId,
} from "./launch-policy.js";
import { type LocalRepoChangeParams, localRepoChangeParamsCodec } from "./params.js";

const PROJECT_KEY = "repo";
const AUTO_BRANCH_SELECTED_EVENT = "local_repo_change.auto_work_branch_selected";
const AUTO_BRANCH_FAILED_EVENT = "local_repo_change.auto_work_branch_failed";
const AUTO_BRANCH_METADATA_NAMESPACE = "localRepoChange";
const AUTO_BRANCH_METADATA_KEY = "autoWorkBranch";
const DEFAULT_PROMPT_FALLBACK_DELAY_MS = 30_000;
const MAX_PREPARATION_ATTEMPTS = 3;

type PromptFallbackTimer = { unref?: () => void };
export type AutoWorkBranchSource = "title" | "prompt_fallback";
export type AutoWorkBranchTriggerReason =
	| "process_created"
	| "title_updated"
	| "startup"
	| "prompt_fallback";

export interface LocalRepoChangeAutoWorkBranchDeps {
	commands: Pick<
		ProcessEngineLike,
		| "getDeferredProcessActivationSnapshots"
		| "activateDeferredProcess"
		| "parkDeferredProcessActivationFailure"
	>;
	logger?: ServerExtensionLogger;
	resolveBaseBranchSha?: (input: ResolveBaseBranchShaInput) => string | Promise<string>;
	createRandomHex?: () => string;
	promptFallbackDelayMs?: number;
	schedulePromptFallback?: (callback: () => void, delayMs: number) => PromptFallbackTimer;
}

interface AutoWorkBranchMetadata extends Record<string, unknown> {
	workBranch: string;
	baseBranch: string;
	baseBranchSha: string;
	randomHex: string;
	prompt: string;
	title: string | null;
	branchSource: AutoWorkBranchSource;
	reason: AutoWorkBranchTriggerReason;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readAutoWorkBranchMetadata(
	metadata: Record<string, unknown> | null,
): AutoWorkBranchMetadata | null {
	const namespace = asRecord(metadata?.[AUTO_BRANCH_METADATA_NAMESPACE]);
	const marker = asRecord(namespace?.[AUTO_BRANCH_METADATA_KEY]);
	const workBranch = trimToNull(marker?.workBranch);
	return workBranch ? ({ ...marker, workBranch } as AutoWorkBranchMetadata) : null;
}

function withAutoWorkBranchMetadata(
	metadata: Record<string, unknown> | null,
	marker: AutoWorkBranchMetadata,
): Record<string, unknown> {
	const next = { ...(metadata ?? {}) };
	next[AUTO_BRANCH_METADATA_NAMESPACE] = {
		...(asRecord(next[AUTO_BRANCH_METADATA_NAMESPACE]) ?? {}),
		[AUTO_BRANCH_METADATA_KEY]: marker,
	};
	return next;
}

function asLaunchInput(snapshot: DeferredProcessActivationSnapshot): Record<string, unknown> {
	const parsed = snapshot.paramsJson ? JSON.parse(snapshot.paramsJson) : {};
	const record = asRecord(parsed) ?? {};
	if (record.launchKind === "requested_change" || record.launchKind === "imported_plan") {
		return record;
	}
	const legacyImportedPlan = trimToNull(record.handoffPlanMarkdown);
	return legacyImportedPlan
		? {
				...record,
				launchKind: "imported_plan",
				importedPlanMarkdown: legacyImportedPlan,
			}
		: { ...record, launchKind: "requested_change" };
}

function serializeParams(params: LocalRepoChangeParams): string {
	return JSON.stringify(localRepoChangeParamsCodec.serialize(params));
}

function isEligible(snapshot: DeferredProcessActivationSnapshot): boolean {
	return (
		snapshot.processId === localRepoChangeProcessId &&
		snapshot.lifecycleStatus === "discovered" &&
		snapshot.selectedTurnId === null
	);
}

function branchSource(
	snapshot: DeferredProcessActivationSnapshot,
	params: LocalRepoChangeParams,
	allowPromptFallback: boolean,
): { text: string; title: string | null; branchSource: AutoWorkBranchSource } | null {
	const title = trimToNull(snapshot.title);
	if (title) return { text: title, title, branchSource: "title" };
	if (!allowPromptFallback) return null;
	const prompt = trimToNull(params.prompt);
	return prompt ? { text: prompt, title: null, branchSource: "prompt_fallback" } : null;
}

function readSnapshot(
	deps: LocalRepoChangeAutoWorkBranchDeps,
	instanceId: string,
): DeferredProcessActivationSnapshot | null {
	const result = deps.commands.getDeferredProcessActivationSnapshots({
		instanceId,
		projectKey: PROJECT_KEY,
	});
	return result.outcome === "ready" ? (result.snapshots[0] ?? null) : null;
}

function currentWorkBranch(
	snapshot: DeferredProcessActivationSnapshot,
	params: LocalRepoChangeParams,
): string | null {
	const paramsBranch = trimToNull(params.workBranch);
	const projectBranch = trimToNull(snapshot.workBranch);
	if (paramsBranch && projectBranch && paramsBranch !== projectBranch) {
		throw new Error(
			`Local repo change has conflicting work branches: params '${paramsBranch}' and project '${projectBranch}'`,
		);
	}
	return projectBranch ?? paramsBranch;
}

function planLaunch(
	snapshot: DeferredProcessActivationSnapshot,
	workBranch: string | null,
): { params: LocalRepoChangeParams; startTurnId: string | null } {
	const resolution = localRepoChangeLaunchPlanner.plan({
		input: { ...asLaunchInput(snapshot), workBranch: workBranch ?? "" },
		metadata: snapshot.processMetadata,
	});
	if (!resolution.ok) {
		throw new Error(
			`Invalid Local Repo Change launch intent: ${formatLocalRepoChangeLaunchErrors(resolution.errors)}`,
		);
	}
	return {
		params: resolution.launchConfig.params,
		startTurnId: resolution.launchConfig.startTurnId ?? null,
	};
}

function activationEvent(marker: AutoWorkBranchMetadata) {
	return {
		eventType: AUTO_BRANCH_SELECTED_EVENT,
		data: marker,
		level: "info" as const,
		message: `Selected automatic work branch '${marker.workBranch}'`,
	};
}

async function parkFailure(
	deps: LocalRepoChangeAutoWorkBranchDeps,
	snapshot: DeferredProcessActivationSnapshot,
	input: {
		reason: AutoWorkBranchTriggerReason;
		message: string;
		errorClass: WorkerErrorClass;
	},
): Promise<void> {
	const result = await deps.commands.parkDeferredProcessActivationFailure(snapshot.instanceId, {
		expected: snapshot,
		errorClass: input.errorClass,
		event: {
			eventType: AUTO_BRANCH_FAILED_EVENT,
			level: "warn",
			message: input.message,
			data: {
				reason: input.reason,
				error: input.message,
				operatorMessage: input.message,
				errorClass: input.errorClass,
			},
		},
	});
	if (!result.ok) {
		deps.logger?.warn?.(
			{ instanceId: snapshot.instanceId, code: result.code, message: result.message },
			"Failed to park local repo change after deferred activation failure",
		);
	}
}

async function reconcileOne(
	deps: LocalRepoChangeAutoWorkBranchDeps,
	instanceId: string,
	reason: AutoWorkBranchTriggerReason,
): Promise<"waiting_for_title" | undefined> {
	const allowPromptFallback = reason === "startup" || reason === "prompt_fallback";
	const resolver = deps.resolveBaseBranchSha ?? resolveBaseBranchSha;

	for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt += 1) {
		const snapshot = readSnapshot(deps, instanceId);
		if (!snapshot || !isEligible(snapshot)) return;
		const durableInput = asLaunchInput(snapshot);
		const initialPlan = planLaunch(
			snapshot,
			trimToNull(snapshot.workBranch) ?? trimToNull(durableInput.workBranch),
		);
		const params = initialPlan.params;
		let workBranch = currentWorkBranch(snapshot, params);
		const legacyMarker = readAutoWorkBranchMetadata(snapshot.processMetadata);
		let marker: AutoWorkBranchMetadata;
		if (workBranch) {
			if (!legacyMarker || legacyMarker.workBranch !== workBranch) return;
			marker = legacyMarker;
		} else {
			const source = branchSource(snapshot, params, allowPromptFallback);
			if (!source) return trimToNull(snapshot.title) ? undefined : "waiting_for_title";
			const baseBranch = trimToNull(snapshot.baseBranch) ?? params.baseBranch;
			const repoLocator = trimToNull(snapshot.repoLocator) ?? params.repoLocator;
			const baseBranchSha = await resolver({ repoLocator, baseBranch });
			const randomHex = deps.createRandomHex?.() ?? generateAutoWorkBranchRandomHex();
			workBranch = buildAutoWorkBranch(source.text, baseBranchSha, randomHex);
			marker = {
				reason,
				workBranch,
				baseBranch,
				baseBranchSha,
				randomHex,
				prompt: params.prompt,
				title: source.title,
				branchSource: source.branchSource,
			};
		}

		const activationPlan = planLaunch(snapshot, workBranch);
		if (!activationPlan.startTurnId) {
			throw new Error("Automatic work branch assignment did not select an entry turn");
		}
		const result = await deps.commands.activateDeferredProcess(instanceId, {
			expected: snapshot,
			workBranch,
			paramsJson: serializeParams(activationPlan.params),
			projectMetadata: withAutoWorkBranchMetadata(snapshot.projectMetadata, marker),
			selectedTurnId: activationPlan.startTurnId,
			event: activationEvent(marker),
		});
		if (result.ok) {
			const outcome = result.data?.outcome;
			if (outcome === "stale") continue;
			if (outcome === "invalid_selected_turn") {
				await parkFailure(deps, snapshot, {
					reason,
					message: `Automatic work branch '${workBranch}' could not select first turn '${activationPlan.startTurnId}'`,
					errorClass: "infrastructure",
				});
			}
			return;
		}
		if (result.stage === "post_commit") {
			deps.logger?.warn?.(
				{ instanceId, code: result.code, message: result.message },
				"Deferred activation committed but a post-commit reaction failed",
			);
			return;
		}
		await parkFailure(deps, snapshot, {
			reason,
			message: `Automatic work branch activation failed: ${result.message ?? result.code ?? "unknown error"}`,
			errorClass: "infrastructure",
		});
		return;
	}

	const snapshot = readSnapshot(deps, instanceId);
	if (snapshot && isEligible(snapshot)) {
		await parkFailure(deps, snapshot, {
			reason,
			message: "Automatic work branch inputs changed repeatedly during preparation",
			errorClass: "git_error",
		});
	}
}

export function createLocalRepoChangeAutoWorkBranchCoordinator(
	deps: LocalRepoChangeAutoWorkBranchDeps,
) {
	const pendingPromptFallbacks = new Set<string>();
	const flights = new Map<
		string,
		{ promise: Promise<void>; dirty: boolean; reason: AutoWorkBranchTriggerReason }
	>();

	function schedulePromptFallback(instanceId: string): void {
		if (pendingPromptFallbacks.has(instanceId)) return;
		pendingPromptFallbacks.add(instanceId);
		const delayMs = Math.max(
			0,
			Math.trunc(deps.promptFallbackDelayMs ?? DEFAULT_PROMPT_FALLBACK_DELAY_MS),
		);
		const callback = () => {
			pendingPromptFallbacks.delete(instanceId);
			void reconcile(instanceId, "prompt_fallback");
		};
		const timer = deps.schedulePromptFallback
			? deps.schedulePromptFallback(callback, delayMs)
			: (setTimeout(callback, delayMs) as PromptFallbackTimer);
		timer.unref?.();
	}

	function reconcile(instanceId: string, reason: AutoWorkBranchTriggerReason): Promise<void> {
		const running = flights.get(instanceId);
		if (running) {
			running.dirty = true;
			running.reason = reason;
			return running.promise;
		}
		const state = { promise: Promise.resolve(), dirty: false, reason };
		state.promise = (async () => {
			try {
				do {
					state.dirty = false;
					const runReason = state.reason;
					try {
						const outcome = await reconcileOne(deps, instanceId, runReason);
						if (outcome === "waiting_for_title") schedulePromptFallback(instanceId);
					} catch (error) {
						const message = `Automatic work branch selection failed: ${
							error instanceof Error ? error.message : String(error)
						}`;
						const snapshot = readSnapshot(deps, instanceId);
						if (snapshot && isEligible(snapshot)) {
							await parkFailure(deps, snapshot, {
								reason: runReason,
								message,
								errorClass: "git_error",
							});
						}
						deps.logger?.warn?.(
							{ instanceId, err: message },
							"Failed to select automatic local repo change work branch",
						);
					}
				} while (state.dirty);
			} finally {
				flights.delete(instanceId);
			}
		})();
		flights.set(instanceId, state);
		return state.promise;
	}

	return {
		reconcile,
		async reconcileAll(): Promise<void> {
			const result = deps.commands.getDeferredProcessActivationSnapshots({
				processId: localRepoChangeProcessId,
				projectKey: PROJECT_KEY,
			});
			if (result.outcome !== "ready") return;
			for (const snapshot of result.snapshots) await reconcile(snapshot.instanceId, "startup");
		},
	};
}
