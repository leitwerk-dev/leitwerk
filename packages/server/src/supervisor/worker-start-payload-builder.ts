import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
	ProcessInstance,
	ProcessSemanticEntryRefKey,
	TurnStartRecord,
} from "@leitwerk-dev/domain";
import { parseProductRefsFromStateJsonLenient } from "@leitwerk-dev/domain";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import {
	createIpcMessage,
	type InputDelivery,
	type PiResourceBundle,
	type ServerToWorkerMessage,
	verifyCanonicalPiResourceBundle,
	type WorkerRuntimeSettingsSnapshot,
	type WorkerStartPayload,
} from "@leitwerk-dev/worker-protocol";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ResolvedProviderCredential } from "../model-providers/credentials.js";
import {
	type ProcessActionRegistry,
	resolveTurnIntegrationToolNames,
} from "../process-action-registry.js";
import { getProcessTurnGraph, type ProcessGraphRegistry } from "../process-graph.js";
import { toInputDelivery } from "../process-input-dispatch.js";
import {
	resolveProductTurnResultMarkdown,
	resolveSemanticTurnResultMarkdown,
} from "../turn-result-markdown.js";
import { createWorkerStorageLayout, type WorkerStorageLayout } from "./worker-storage-layout.js";

export interface WorkerStartPayloadBuilderDeps
	extends Pick<
		RepositoryBundle,
		"processes" | "projects" | "inputs" | "turnRecords" | "turnStarts" | "leases" | "events"
	> {
	config: LeitwerkConfig;
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: Pick<ProcessActionRegistry, "getTurnDefinition" | "resolveContextData">;
	storageLayout?: WorkerStorageLayout;
	/**
	 * The sole server-side resource-bundle seam. The resulting canonical bytes are
	 * delivered only in the authenticated `worker.start` message, irrespective of
	 * whether the physical worker is local, Docker, or Kubernetes.
	 */
	resolveResourceBundle?(digest: string): PiResourceBundle | null;
	resolveRepositoryCredentials?(input: {
		process: ProcessInstance;
		projects: ReturnType<RepositoryBundle["projects"]["listByInstance"]>;
	}): import("@leitwerk-dev/worker-protocol").WorkerGitSshCredential[];
	resolveCredential?(
		providerId: string,
		options: Readonly<Record<string, string>>,
	): Pick<ResolvedProviderCredential, "revision" | "values"> | null;
	integrationTools?: {
		declarations(
			names: readonly string[],
			context?: { paramsJson: string | null },
		): import("@leitwerk-dev/worker-protocol").IntegrationToolDeclaration[];
	};
}

export function buildWorkerRuntimeSettingsSnapshot(
	config: LeitwerkConfig,
): WorkerRuntimeSettingsSnapshot {
	return {
		heartbeat_interval: config.workers.heartbeat_interval,
		turn_max_duration: config.workers.turn_max_duration,
		turn_inactivity_timeout: config.workers.turn_inactivity_timeout,
		turn_abort_grace_period: config.workers.turn_abort_grace_period,
	};
}

const TRANSITION_SCOPED_PRODUCT_NAMES = new Set(["input", "message"]);

export function buildWorkerConfigSnapshot(config: LeitwerkConfig): ConfigSnapshot {
	const processConfigs = Object.fromEntries(
		Object.entries(config.process_configs ?? {}).map(([processId, processConfig]) => [
			processId,
			processConfig.pi ? { pi: processConfig.pi } : {},
		]),
	);
	return {
		workers: buildWorkerRuntimeSettingsSnapshot(config),
		pi: config.pi,
		...(Object.keys(processConfigs).length > 0 ? { process_configs: processConfigs } : {}),
	};
}

function buildTurnResultMarkdownBySemanticRef(
	process: Pick<ProcessInstance, "id" | "processId" | "selectedTurnId" | "stateJson">,
	deps: Pick<WorkerStartPayloadBuilderDeps, "processGraphs" | "turnRecords">,
): Partial<Record<ProcessSemanticEntryRefKey, string>> | undefined {
	const selectedTurnId = process.selectedTurnId;
	if (!selectedTurnId) {
		return undefined;
	}
	const selectedTurn = getProcessTurnGraph(deps.processGraphs, process.processId, selectedTurnId);
	const requiredRefs = selectedTurn?.requiredSemanticMarkdownRefs ?? [];
	const optionalRefs = selectedTurn?.optionalSemanticMarkdownRefs ?? [];
	if (requiredRefs.length === 0 && optionalRefs.length === 0) {
		return undefined;
	}
	const bySemanticRef: Partial<Record<ProcessSemanticEntryRefKey, string>> = {};
	for (const ref of requiredRefs) {
		const markdown = resolveSemanticTurnResultMarkdown({
			process,
			semanticEntryRefKey: ref,
			turnRecords: deps.turnRecords,
			required: true,
		});
		if (markdown) {
			bySemanticRef[ref] = markdown;
		}
	}
	for (const ref of optionalRefs) {
		if (bySemanticRef[ref]) {
			continue;
		}
		const markdown = resolveSemanticTurnResultMarkdown({
			process,
			semanticEntryRefKey: ref,
			turnRecords: deps.turnRecords,
			required: false,
		});
		if (markdown) {
			bySemanticRef[ref] = markdown;
		}
	}
	return Object.keys(bySemanticRef).length > 0 ? bySemanticRef : undefined;
}

function latestSucceededTurnRecord(
	processId: string,
	deps: Pick<WorkerStartPayloadBuilderDeps, "turnRecords">,
) {
	return (
		[...deps.turnRecords.listByInstance(processId)]
			.reverse()
			.find((record) => record.status === "succeeded") ?? null
	);
}

function isTransitionScopedProductFresh(
	process: Pick<ProcessInstance, "id" | "processId" | "stateJson">,
	productName: string,
	deps: Pick<WorkerStartPayloadBuilderDeps, "processGraphs" | "turnRecords">,
): boolean {
	if (!TRANSITION_SCOPED_PRODUCT_NAMES.has(productName)) {
		return true;
	}
	const productRef = parseProductRefsFromStateJsonLenient(process.stateJson)[productName];
	if (!productRef?.turnRecordId) {
		return true;
	}
	const latestTurnRecord = latestSucceededTurnRecord(process.id, deps);
	if (!latestTurnRecord || productRef.turnRecordId === latestTurnRecord.id) {
		return true;
	}
	const latestTurn = getProcessTurnGraph(
		deps.processGraphs,
		process.processId,
		latestTurnRecord.turnId,
	);
	return latestTurn?.turnType === "human" && latestTurn.reviewProduct === productName;
}

function assertFreshTransitionScopedProduct(
	process: Pick<ProcessInstance, "id" | "processId" | "selectedTurnId" | "stateJson">,
	productName: string,
	deps: Pick<WorkerStartPayloadBuilderDeps, "processGraphs" | "turnRecords">,
): void {
	if (isTransitionScopedProductFresh(process, productName, deps)) {
		return;
	}
	throw new Error(
		`Invalid process state for process '${process.id}': turn '${process.selectedTurnId ?? "null"}' requires transition-scoped product '${productName}', but the latest '${productName}' publication belongs to an earlier transition`,
	);
}

function buildTurnResultMarkdownByProduct(
	process: Pick<ProcessInstance, "id" | "processId" | "selectedTurnId" | "stateJson">,
	deps: Pick<WorkerStartPayloadBuilderDeps, "processGraphs" | "turnRecords">,
): Record<string, string> | undefined {
	const selectedTurnId = process.selectedTurnId;
	if (!selectedTurnId) {
		return undefined;
	}
	const selectedTurn = getProcessTurnGraph(deps.processGraphs, process.processId, selectedTurnId);
	const consumedProducts = selectedTurn?.consumedProducts ?? [];
	const optionalConsumedProducts = selectedTurn?.optionalConsumedProducts ?? [];
	if (consumedProducts.length === 0 && optionalConsumedProducts.length === 0) {
		return undefined;
	}
	const byProduct: Record<string, string> = {};
	for (const productName of consumedProducts) {
		assertFreshTransitionScopedProduct(process, productName, deps);
		byProduct[productName] =
			resolveProductTurnResultMarkdown({
				process,
				productName,
				turnRecords: deps.turnRecords,
				required: true,
			}) ?? "";
	}
	for (const productName of optionalConsumedProducts) {
		if (byProduct[productName]) {
			continue;
		}
		if (!isTransitionScopedProductFresh(process, productName, deps)) {
			continue;
		}
		const markdown = resolveProductTurnResultMarkdown({
			process,
			productName,
			turnRecords: deps.turnRecords,
			required: false,
		});
		if (markdown) {
			byProduct[productName] = markdown;
		}
	}
	return Object.keys(byProduct).length > 0 ? byProduct : undefined;
}

function resolveLlmPreparation(
	start: TurnStartRecord,
	deps: Pick<WorkerStartPayloadBuilderDeps, "events">,
): WorkerStartPayload["llmPreparation"] {
	const sourceTurnRecordId =
		start.state.kind === "accepted"
			? start.state.turnRecordId
			: start.startKind === "continue"
				? start.recoveryTurnRecordId
				: null;
	if (!sourceTurnRecordId) return undefined;
	const events = deps.events.listByInstanceTurnRecordEventTypes(
		start.instanceId,
		sourceTurnRecordId,
		["turn.prepared"],
	);
	const event = events.at(-1);
	if (!event || !("data" in event.data)) return undefined;
	return { sourceTurnRecordId, data: event.data.data };
}

export function createWorkerStartPayloadBuilder(deps: WorkerStartPayloadBuilderDeps) {
	const storageLayout = deps.storageLayout ?? createWorkerStorageLayout(deps.config);

	function buildProjectSnapshots(instanceId: string) {
		return deps.projects.listByInstance(instanceId).map((project) => ({
			key: project.key,
			repoLocator: project.repoLocator,
			repoLocatorKind: project.repoLocatorKind,
			baseBranch: project.baseBranch,
			workBranch: project.workBranch ?? project.baseBranch,
			externalId: project.externalId,
			externalUrl: project.externalUrl,
			metadata: project.metadata,
			pipelineStatus: project.pipelineStatus,
			createdAt: project.createdAt,
			updatedAt: project.updatedAt,
		}));
	}

	function buildWorkerRuntimeContextSnapshot(process: ProcessInstance, start: TurnStartRecord) {
		const turnResultMarkdownBySemanticRef = buildTurnResultMarkdownBySemanticRef(process, deps);
		const turnResultMarkdownByProduct = buildTurnResultMarkdownByProduct(process, deps);
		const prepared =
			start.state.kind === "starting" ||
			start.state.kind === "accepted" ||
			start.state.kind === "bootstrap_failed"
				? start.state.start
				: null;
		const preparedLlm = prepared?.kind === "llm" ? prepared : null;
		return {
			processSnapshot: {
				...process,
				selectedTurnModelProfileId: preparedLlm?.model.profileId ?? null,
				selectedTurnModelKind: preparedLlm?.modelSelectionProvenance?.kind ?? null,
				selectedTurnModelSource: preparedLlm?.modelSelectionProvenance?.source ?? null,
			},
			projectSnapshots: buildProjectSnapshots(process.id),
			...(turnResultMarkdownBySemanticRef ? { turnResultMarkdownBySemanticRef } : {}),
			...(turnResultMarkdownByProduct ? { turnResultMarkdownByProduct } : {}),
		};
	}

	function buildPendingInputsSnapshot(instanceId: string): InputDelivery[] {
		return deps.inputs.listUnconsumed(instanceId).map(toInputDelivery);
	}

	return {
		buildStartMessage(instanceId: string, workerId: string): ServerToWorkerMessage | null {
			const process = deps.processes.getById(instanceId);
			if (!process) {
				return null;
			}
			const lease = deps.leases.getByInstance(instanceId);
			const startId =
				process.currentExecution?.kind === "worker_start" ? process.currentExecution.id : null;
			const start = startId ? deps.turnStarts.getById(startId) : null;
			if (!lease || lease.workerId !== workerId || !start || start.instanceId !== instanceId) {
				return null;
			}
			const acceptedRunningTurn =
				start.state.kind === "accepted" &&
				deps.turnRecords.getById(start.state.turnRecordId)?.status === "running";
			if (start.state.kind !== "starting" && !acceptedRunningTurn) return null;
			const acceptedLease =
				start.state.kind === "accepted"
					? deps.leases.getById(start.state.acceptedWorkerLeaseId)
					: null;
			const acceptedPreparedStart =
				acceptedLease?.bootstrapReceipt?.kind === "llm"
					? acceptedLease.bootstrapReceipt.preparedStart
					: null;
			const treePaths = storageLayout(instanceId);
			const pendingInputs = buildPendingInputsSnapshot(instanceId);
			const llmPreparation =
				start.turnType === "llm" ? resolveLlmPreparation(start, deps) : undefined;
			const resumeLeafEntryId = treePaths.resume
				? (deps.turnRecords.getLatestSucceededPrimaryByInstance(instanceId)?.resultPiEntryId ??
					null)
				: null;
			const contextSnapshot = buildWorkerRuntimeContextSnapshot(process, start);
			const repositoryCredentials =
				deps.resolveRepositoryCredentials?.({
					process,
					projects: deps.projects.listByInstance(process.id),
				}) ?? [];
			const bootstrap = resolveBootstrap(start, deps);
			const integrationToolNames = resolveTurnIntegrationToolNames(
				deps.processActionRegistry,
				process,
				start.turnId,
			);
			const integrationTools =
				integrationToolNames.length > 0
					? deps.integrationTools?.declarations(integrationToolNames, {
							paramsJson: process.paramsJson,
						})
					: undefined;
			if (integrationToolNames.length > 0 && !integrationTools) {
				throw new Error(`Integration tools are unavailable for turn '${start.turnId}'`);
			}
			const payloadBase = {
				...contextSnapshot,
				workerLeaseId: lease.id,
				turnStart: start,
				...(start.state.kind === "accepted" ? { acceptedPreparedStart } : {}),
				pendingInputs,
				treePaths: {
					primaryTreeFile: treePaths.primaryTreeFile,
					workspaceRoot: treePaths.workspaceRoot,
					piResourceBundlesDir: treePaths.piResourceBundlesDir,
				},
				resume: treePaths.resume,
				workerRuntimeSettings: buildWorkerRuntimeSettingsSnapshot(deps.config),
				developmentTools: {
					runner:
						deps.config.workers.runner === "local" ? ("local" as const) : ("isolated" as const),
					miseCommand:
						deps.config.workers.runner === "local"
							? deps.config.development_tools.local.mise_command
							: "/usr/local/bin/mise",
					installTimeoutMs: parseDurationMs(
						deps.config.development_tools.install_timeout,
						30 * 60 * 1_000,
						{ allowHours: true },
					),
					processStorageRoot:
						deps.config.workers.runner === "local"
							? treePaths.workspaceRoot
							: path.dirname(treePaths.workspaceRoot),
				},
				...(treePaths.resume ? { resumeLeafEntryId } : {}),
				...(llmPreparation ? { llmPreparation } : {}),
				...(repositoryCredentials.length > 0 ? { repositoryCredentials } : {}),
				...(integrationTools && integrationTools.length > 0 ? { integrationTools } : {}),
			};
			const payload: WorkerStartPayload =
				bootstrap.kind === "llm"
					? {
							...payloadBase,
							bootstrap,
							configSnapshot: buildWorkerConfigSnapshot(deps.config),
						}
					: { ...payloadBase, bootstrap };

			return createIpcMessage<ServerToWorkerMessage>({
				type: "worker.start",
				instanceId,
				workerId,
				messageId: randomUUID(),
				payload,
			});
		},
	};
}

function resolveBootstrap(
	start: TurnStartRecord,
	deps: WorkerStartPayloadBuilderDeps,
): WorkerStartPayload["bootstrap"] {
	if (start.turnType === "automatic") return { kind: "automatic" };
	if (
		(start.state.kind !== "starting" && start.state.kind !== "accepted") ||
		start.state.start.kind !== "llm"
	) {
		throw new Error(`LLM start '${start.id}' has no resolved LLM inputs`);
	}
	const bundle = deps.resolveResourceBundle?.(start.state.start.piResourceSnapshotDigest) ?? null;
	if (bundle && bundle.digest !== start.state.start.piResourceSnapshotDigest) {
		throw new Error(
			`Pi resource bundle resolver returned '${bundle.digest}' for requested digest '${start.state.start.piResourceSnapshotDigest}'`,
		);
	}
	// Cache implementations normally verify on insertion. Recheck at this IPC
	// boundary so an alternate resolver cannot turn a runner path into a
	// filesystem or network-bundle bypass.
	if (bundle) verifyCanonicalPiResourceBundle(bundle.bytes, bundle.digest);
	const credential =
		deps.resolveCredential?.(
			start.state.start.model.providerId,
			start.state.start.providerOptions,
		) ?? null;
	return {
		kind: "llm",
		resourceBundle: {
			digest: start.state.start.piResourceSnapshotDigest,
			...(bundle ? { archiveBase64: Buffer.from(bundle.bytes).toString("base64") } : {}),
		},
		credential: credential
			? {
					providerId: start.state.start.model.providerId,
					revision: credential.revision,
					values: credential.values,
				}
			: null,
	};
}
