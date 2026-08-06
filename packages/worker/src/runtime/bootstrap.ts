import path from "node:path";
import type {
	PreparedTurnStart,
	ProcessInstance,
	ProcessProject,
	WorkerBootstrapReceipt,
} from "@leitwerk-dev/domain";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type {
	RepositoryCredentialRequirement,
	ResolvedProcessPiConfig,
} from "@leitwerk-dev/process-sdk";
import { createTemplateContext, resolveProcessPiConfig } from "@leitwerk-dev/process-sdk/pi-config";
import type { WorkerGitSshCredential, WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import type { InputItem } from "../input-consumer.js";
import {
	resolveManagedPiAgentDir,
	writeManagedPiCredentialFiles,
} from "../managed-pi-agent-dir.js";
import {
	assertManagedPiCredentialFiles,
	buildManagedPiCredentialFiles,
	readAndValidateManagedPiResourceManifest,
} from "../managed-pi-bootstrap.js";
import type { PiTreeHandle, PiTreeHandleFactory, PiTreePlanningSnapshot } from "../pi-adapter.js";
import { materializeCanonicalPiResourceBundle } from "../pi-resource-bundle.js";
import { resolvePreTurnTargetStartSelection } from "../pre-turn-targeted-inputs.js";
import { planTurnTreeExecution } from "../turn-tree-strategy.js";
import {
	buildProcessSnapshotSeed,
	inputDeliveryToItem,
	parseProcessSemanticEntryRefsFromStateJson,
	projectSnapshotsFromPayload,
	readProcessProductRefs,
	readProcessSemanticEntryRefs,
} from "../worker-payloads.js";
import { isLlmWorkerStartPayload } from "../worker-start-payload.js";
import {
	materializeRunRoot,
	planRunRoot,
	type RunRootGitOps,
	repairRunRoot,
	validateRunRoot,
} from "../workspace/run-root.js";
import type { WorkerRuntimeScheduler } from "./adapters.js";

export interface BootstrapWorkerRuntimeDeps {
	instanceId: string;
	payload: WorkerStartPayload;
	piFactory: PiTreeHandleFactory;
	gitOps: RunRootGitOps;
	scheduler: WorkerRuntimeScheduler;
	resolveWorkerProcess?: (
		processId: string,
		opts?: { paramsJson?: string | null; stateJson?: string | null },
	) => ResolvedWorkerProcess | Promise<ResolvedWorkerProcess | undefined> | undefined;
}

export interface AcceptedStartActivationResult {
	piHandle: PiTreeHandle | null;
	diagnostics: string[];
}

export interface PreparedStartActivation {
	startPayload: WorkerStartPayload;
	managedAgentDir: string | null;
	managedModelProfileId: string | null;
	workspaceRoot: string;
	sessionCwd: string;
	processSnapshot: ProcessInstance;
	resolvedPiConfig: ResolvedProcessPiConfig;
}

export interface BootstrapWorkerRuntimeResult {
	startPayload: WorkerStartPayload;
	resolvedWorkerProcess?: ResolvedWorkerProcess;
	projectSnapshots: ProcessProject[];
	processSnapshot: ProcessInstance;
	activation: PreparedStartActivation;
	resolvedPiConfig: ResolvedProcessPiConfig;
	diagnostics: string[];
	readyPayload: {
		resumed: boolean;
		primaryTreeFile: string;
		workspaceRoot: string;
		aggregatedAgentsSources: string[];
		loadedSkills: string[];
		loadedAgentsFiles: Array<{ path: string; sizeBytes: number }>;
		loadedSkillFiles: Array<{ name: string; path: string }>;
		rootEntryId: string | null;
		receipt: WorkerBootstrapReceipt;
	};
	pendingInputs: InputItem[];
	credentialRefresh?: {
		agentDir: string;
		declaredCredentialPaths: readonly string[];
		providerId: string;
		revision: number;
	};
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function withoutCredentialValues(payload: WorkerStartPayload): WorkerStartPayload {
	const withoutRepositoryCredentials = {
		...payload,
		repositoryCredentials: undefined,
	} as WorkerStartPayload;
	if (!isLlmWorkerStartPayload(payload) || !payload.bootstrap.credential) {
		return withoutRepositoryCredentials;
	}
	return {
		...payload,
		repositoryCredentials: undefined,
		bootstrap: {
			...payload.bootstrap,
			credential: { ...payload.bootstrap.credential, values: {} },
		},
	};
}

export function validateRepositoryCredentials(input: {
	credentials: readonly WorkerGitSshCredential[];
	requirements: readonly RepositoryCredentialRequirement[];
	projectKeys: ReadonlySet<string>;
}): void {
	const credentialKeys = new Set<string>();
	for (const credential of input.credentials) {
		if (!input.projectKeys.has(credential.projectKey) || credential.kind !== "git_ssh") {
			throw new Error(`Repository credential does not match project '${credential.projectKey}'`);
		}
		if (credentialKeys.has(credential.projectKey)) {
			throw new Error(`Duplicate repository credential for project '${credential.projectKey}'`);
		}
		credentialKeys.add(credential.projectKey);
	}
	const identities = (items: readonly RepositoryCredentialRequirement[]) =>
		new Set(items.map((item) => `${item.projectKey}:${item.kind}:${item.credentialRef}`));
	const delivered = identities(input.credentials);
	const declared = identities(input.requirements);
	if (delivered.size !== declared.size || [...declared].some((item) => !delivered.has(item))) {
		throw new Error("Delivered repository credentials do not exactly satisfy process requirements");
	}
}

export function shouldPreservePersistedLeafForActiveTurnResume(input: {
	processSnapshot: Pick<ProcessInstance, "selectedTurnId" | "currentExecution" | "metadata">;
	payload: Pick<WorkerStartPayload, "resume" | "turnStart">;
}): boolean {
	if (!input.payload.resume) {
		return false;
	}
	if (!readNonEmptyString(input.processSnapshot.selectedTurnId)) {
		return false;
	}
	if (
		input.processSnapshot.currentExecution?.kind !== "worker_start" ||
		input.processSnapshot.currentExecution.id !== input.payload.turnStart.id ||
		input.payload.turnStart.state.kind !== "accepted" ||
		!readNonEmptyString(input.payload.turnStart.state.turnRecordId)
	) {
		return false;
	}
	if (readNonEmptyString(input.processSnapshot.metadata?.continueFromPiEntryId)) {
		return false;
	}
	if (readNonEmptyString(input.processSnapshot.metadata?.retryForkPiEntryId)) {
		return false;
	}
	return true;
}

type ResumeLeafEntryCandidate = {
	entryId: string;
	source: "continue" | "retry" | "state" | "payload";
};

function resolveResumeLeafEntryCandidates(
	processSnapshot: ProcessInstance,
	payload: WorkerStartPayload,
): ResumeLeafEntryCandidate[] {
	const candidates: ResumeLeafEntryCandidate[] = [];
	const continueFromPiEntryId =
		typeof processSnapshot.metadata?.continueFromPiEntryId === "string"
			? processSnapshot.metadata.continueFromPiEntryId
			: null;
	if (continueFromPiEntryId) {
		candidates.push({ entryId: continueFromPiEntryId, source: "continue" });
	}

	const retryForkPiEntryId =
		typeof processSnapshot.metadata?.retryForkPiEntryId === "string"
			? processSnapshot.metadata.retryForkPiEntryId
			: null;
	if (retryForkPiEntryId && retryForkPiEntryId !== continueFromPiEntryId) {
		candidates.push({ entryId: retryForkPiEntryId, source: "retry" });
	}

	const semanticEntryRefs = parseProcessSemanticEntryRefsFromStateJson(processSnapshot.stateJson);
	const stateLeafId = payload.resume
		? (semanticEntryRefs.currentPrimaryPathLeaf?.entryId ?? null)
		: null;
	if (stateLeafId && stateLeafId !== continueFromPiEntryId && stateLeafId !== retryForkPiEntryId) {
		candidates.push({ entryId: stateLeafId, source: "state" });
	}

	const payloadLeafId = payload.resume ? (payload.resumeLeafEntryId ?? null) : null;
	if (
		payloadLeafId &&
		payloadLeafId !== continueFromPiEntryId &&
		payloadLeafId !== retryForkPiEntryId &&
		payloadLeafId !== stateLeafId
	) {
		candidates.push({ entryId: payloadLeafId, source: "payload" });
	}

	return candidates;
}

function requireResumeLeafEntry(
	candidate: ResumeLeafEntryCandidate,
	entryExists: boolean,
): boolean {
	if (entryExists) return true;
	const subject =
		candidate.source === "continue"
			? "Continuation Pi entry"
			: candidate.source === "retry"
				? "Retry fork Pi entry"
				: null;
	if (subject) {
		throw new Error(
			`${subject} '${candidate.entryId}' was requested but does not exist in the persisted instance tree`,
		);
	}
	return false;
}

function resolvePlanningRootEntryId(
	snapshot: PiTreePlanningSnapshot,
	leafId: string | null,
): string | null {
	const entriesById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	let current = leafId ? entriesById.get(leafId) : undefined;
	const visited = new Set<string>();
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		if (!current.parentId) return current.id;
		current = entriesById.get(current.parentId);
	}
	return snapshot.entries.find((entry) => entry.parentId === null)?.id ?? null;
}

function resolvePlanningLeaf(input: {
	snapshot: PiTreePlanningSnapshot;
	processSnapshot: ProcessInstance;
	payload: WorkerStartPayload;
}): string | null {
	const entryIds = new Set(input.snapshot.entries.map((entry) => entry.id));
	for (const candidate of resolveResumeLeafEntryCandidates(input.processSnapshot, input.payload)) {
		if (requireResumeLeafEntry(candidate, entryIds.has(candidate.entryId)))
			return candidate.entryId;
	}
	return input.snapshot.currentLeafId;
}

function leadingTargetedInputsAfterOrdinaryInputs(inputs: readonly InputItem[]) {
	const firstTargetedIndex = inputs.findIndex((input) => input.target !== null);
	if (firstTargetedIndex < 0) return [];
	const targeted = [];
	for (const input of inputs.slice(firstTargetedIndex)) {
		if (!input.target) break;
		targeted.push({ ...input, target: input.target });
	}
	return targeted;
}

async function prepareFreshLlmTurnStart(input: {
	payload: WorkerStartPayload;
	processSnapshot: ProcessInstance;
	resolvedWorkerProcess: ResolvedWorkerProcess | undefined;
	piFactory: PiTreeHandleFactory;
	sessionCwd: string;
	pendingInputs: readonly InputItem[];
}): Promise<PreparedTurnStart> {
	const turnId = input.payload.turnStart.turnId;
	const definition = input.resolvedWorkerProcess?.turns.get(turnId)?.definition;
	if (!definition || definition.kind !== "llm") {
		throw new Error(`Selected LLM turn '${turnId}' is unavailable during worker bootstrap`);
	}
	const snapshot = await input.piFactory.inspectPrimaryTree({
		treeFile: input.payload.treePaths.primaryTreeFile,
		sessionCwd: input.sessionCwd,
	});
	const entryIds = new Set(snapshot.entries.map((entry) => entry.id));
	const continuation = input.payload.turnStart.continuation;
	if (continuation) {
		requireResumeLeafEntry(
			{ entryId: continuation.continueFromPiEntryId, source: "continue" },
			entryIds.has(continuation.continueFromPiEntryId),
		);
		return {
			pathType: definition.branchType,
			contextMode: definition.context,
			startTarget: { kind: "entry", entryId: continuation.continueFromPiEntryId },
			forkPiEntryId: continuation.continueFromPiEntryId,
		};
	}

	const currentLeafId = resolvePlanningLeaf({
		snapshot,
		processSnapshot: input.processSnapshot,
		payload: input.payload,
	});
	const targetedInputs = leadingTargetedInputsAfterOrdinaryInputs(input.pendingInputs);
	const plan = planTurnTreeExecution({
		turnDef: definition,
		currentLeafId,
		rootEntryId: resolvePlanningRootEntryId(snapshot, currentLeafId),
		semanticEntryRefs:
			readProcessSemanticEntryRefs(input.resolvedWorkerProcess?.state) ??
			parseProcessSemanticEntryRefsFromStateJson(input.processSnapshot.stateJson),
		productRefs: readProcessProductRefs(input.resolvedWorkerProcess?.state),
		entryExists: (entryId) => entryIds.has(entryId),
		preTurnStartSelection: resolvePreTurnTargetStartSelection(targetedInputs),
		hasPreTurnTargetedInputs: targetedInputs.length > 0,
	});
	return {
		pathType: plan.pathType,
		contextMode: definition.context,
		startTarget: plan.startTarget,
		forkPiEntryId: plan.forkPiEntryId,
	};
}

async function restorePrimaryPathLeaf(
	piHandle: PiTreeHandle,
	processSnapshot: ProcessInstance,
	payload: WorkerStartPayload,
): Promise<string[]> {
	if (shouldPreservePersistedLeafForActiveTurnResume({ processSnapshot, payload })) {
		return [];
	}
	const candidates = resolveResumeLeafEntryCandidates(processSnapshot, payload);
	for (const candidate of candidates) {
		if (!requireResumeLeafEntry(candidate, Boolean(piHandle.getEntry(candidate.entryId)))) continue;
		await piHandle.branch(candidate.entryId);
		return [];
	}
	return candidates.length > 0
		? [
				`Worker bootstrap could not restore any requested primary-path leaf candidates (${candidates.map((candidate) => `${candidate.source}:${candidate.entryId}`).join(", ")}). Continuing with the persisted instance-tree leaf.`,
			]
		: [];
}

export async function activatePreparedStart(input: {
	instanceId: string;
	piFactory: PiTreeHandleFactory;
	activation: PreparedStartActivation;
}): Promise<AcceptedStartActivationResult> {
	const prepared = input.activation;
	if (!isLlmWorkerStartPayload(prepared.startPayload)) {
		return { piHandle: null, diagnostics: [] };
	}
	if (!prepared.managedAgentDir) throw new Error("Managed Pi agent directory is unavailable");
	const piHandle = await input.piFactory.createPrimaryTreeHandle({
		instanceId: input.instanceId,
		treeFile: prepared.startPayload.treePaths.primaryTreeFile,
		workspaceRoot: prepared.workspaceRoot,
		sessionCwd: prepared.sessionCwd,
		resume: prepared.startPayload.resume,
		agentDir: prepared.managedAgentDir,
		configSnapshot: prepared.startPayload.configSnapshot,
		modelProfileId: prepared.managedModelProfileId,
		piConfig: prepared.resolvedPiConfig,
	});
	const diagnostics = await restorePrimaryPathLeaf(
		piHandle,
		prepared.processSnapshot,
		prepared.startPayload,
	);
	return { piHandle, diagnostics };
}

export async function bootstrapWorkerRuntime(
	deps: BootstrapWorkerRuntimeDeps,
): Promise<BootstrapWorkerRuntimeResult> {
	const llmPayload = isLlmWorkerStartPayload(deps.payload) ? deps.payload : null;
	const processId = deps.payload.processSnapshot.processId ?? "";
	const paramsJson = deps.payload.processSnapshot.paramsJson ?? null;
	const stateJson = deps.payload.processSnapshot.stateJson ?? null;

	// Try the new worker process resolver first
	const resolvedWorkerProcess = deps.resolveWorkerProcess
		? await deps.resolveWorkerProcess(processId, { paramsJson, stateJson })
		: undefined;

	const projectSnapshots = projectSnapshotsFromPayload(deps.payload.projectSnapshots);
	const repositoryCredentials = deps.payload.repositoryCredentials ?? [];
	const declaredRequirements =
		resolvedWorkerProcess?.repositoryCredentials?.({
			params: resolvedWorkerProcess.params,
			projects: projectSnapshots,
		}) ?? [];
	validateRepositoryCredentials({
		credentials: repositoryCredentials,
		requirements: declaredRequirements,
		projectKeys: new Set(projectSnapshots.map((project) => project.key)),
	});
	deps.gitOps.configureRepositoryCredentials?.(repositoryCredentials);
	const processSnapshot = buildProcessSnapshotSeed(processId, deps.payload.processSnapshot);

	const workspaceRoot = deps.payload.treePaths.workspaceRoot;
	const runRootProjects = projectSnapshots.map((project) => ({
		key: project.key,
		repoLocator: project.repoLocator,
		repoLocatorKind: project.repoLocatorKind,
		baseBranch: project.baseBranch,
		workBranch: project.workBranch ?? "",
	}));
	const plan = planRunRoot(workspaceRoot, deps.instanceId, runRootProjects);

	let aggregatedAgentsMdSources: string[] = [];
	let loadedSkills: string[] = [];

	if (!deps.payload.resume) {
		const materialized = await materializeRunRoot(plan, deps.gitOps);
		aggregatedAgentsMdSources = materialized.aggregatedAgentsMdSources;
		loadedSkills = materialized.loadedSkills;
	} else {
		const validation = await validateRunRoot(workspaceRoot, runRootProjects, deps.gitOps);
		const repaired = await repairRunRoot(workspaceRoot, validation, plan, deps.gitOps);
		aggregatedAgentsMdSources = repaired.aggregatedAgentsMdSources;
		loadedSkills = repaired.loadedSkills;
	}

	const resolvedPiConfig = llmPayload
		? resolveProcessPiConfig({
				processId,
				processPiConfig: resolvedWorkerProcess?.piConfig,
				turns: resolvedWorkerProcess?.turns?.values(),
				configSnapshot: llmPayload.configSnapshot,
				templateContext: createTemplateContext({
					params: resolvedWorkerProcess?.params,
					process: processSnapshot,
					projects: projectSnapshots,
				}),
			})
		: { systemPrompt: "", availableToolNames: [] };

	const sessionCwd = resolvedPiConfig.sessionCwd
		? path.resolve(workspaceRoot, resolvedPiConfig.sessionCwd)
		: workspaceRoot;
	const pendingInputs = (deps.payload.pendingInputs ?? []).map(inputDeliveryToItem);
	const diagnostics: string[] = [];
	let managedAgentDir: string | null = null;
	let credentialRefresh: BootstrapWorkerRuntimeResult["credentialRefresh"];
	let managedModelProfileId: string | null = null;
	let loadedAgentsFiles: Array<{ path: string; sizeBytes: number }> = [];
	let loadedSkillFiles: Array<{ name: string; path: string }> = [];
	let receipt: WorkerBootstrapReceipt;
	if (llmPayload) {
		const start =
			deps.payload.turnStart.state.kind === "starting" ||
			deps.payload.turnStart.state.kind === "accepted"
				? deps.payload.turnStart.state.start
				: null;
		if (!start || start.kind !== "llm")
			throw new Error("LLM worker start lacks resolved LLM inputs");
		const configuredProfile = llmPayload.configSnapshot.pi.model_profiles.find(
			(profile) => profile.id === start.model.profileId,
		);
		if (
			!configuredProfile ||
			configuredProfile.provider !== start.model.providerId ||
			configuredProfile.model_id !== start.model.modelId
		) {
			throw new Error("Resolved LLM start model does not match the worker model catalog");
		}
		managedModelProfileId = start.model.profileId;
		if (start.piResourceSnapshotDigest !== llmPayload.bootstrap.resourceBundle.digest) {
			throw new Error("LLM worker start resource digest does not match the delivered bundle");
		}
		if (
			deps.payload.processSnapshot.selectedTurnModelProfileId !== undefined &&
			deps.payload.processSnapshot.selectedTurnModelProfileId !== null &&
			deps.payload.processSnapshot.selectedTurnModelProfileId !== start.model.profileId
		) {
			throw new Error("Selected model profile does not match the resolved LLM start");
		}
		const root = llmPayload.configSnapshot.pi.agent_dir;
		managedAgentDir = resolveManagedPiAgentDir({
			agentDirRoot: root,
			instanceId: deps.instanceId,
			startOrLeaseId: deps.payload.workerLeaseId,
		});
		await materializeCanonicalPiResourceBundle({
			bundle: Buffer.from(llmPayload.bootstrap.resourceBundle.archiveBase64, "base64"),
			digest: llmPayload.bootstrap.resourceBundle.digest,
			targetDir: managedAgentDir,
		});
		const manifest = await readAndValidateManagedPiResourceManifest({
			agentDir: managedAgentDir,
			resourceDigest: llmPayload.bootstrap.resourceBundle.digest,
			start,
		});
		const deliveredCredential = llmPayload.bootstrap.credential;
		await writeManagedPiCredentialFiles(
			managedAgentDir,
			buildManagedPiCredentialFiles({
				manifest,
				credential: deliveredCredential,
				providerId: start.model.providerId,
			}),
		);
		await assertManagedPiCredentialFiles({
			agentDir: managedAgentDir,
			manifest,
			credential: deliveredCredential,
		});
		const prepared = await deps.piFactory.prepareManagedBootstrap({
			agentDir: managedAgentDir,
			workspaceRoot,
			sessionCwd,
			configSnapshot: llmPayload.configSnapshot,
			piConfig: resolvedPiConfig,
			manifest,
			expectedModel: { providerId: start.model.providerId, modelId: start.model.modelId },
		});
		if (
			prepared.resolvedModel.providerId !== start.model.providerId ||
			prepared.resolvedModel.modelId !== start.model.modelId
		) {
			throw new Error("Prepared Pi model does not match the resolved LLM start");
		}
		diagnostics.push(...prepared.diagnostics);
		loadedAgentsFiles = prepared.loadedAgentsFiles;
		loadedSkillFiles = prepared.loadedSkillFiles;
		const credentialRevision = deliveredCredential?.revision ?? null;
		if (deliveredCredential && credentialRevision !== null) {
			credentialRefresh = {
				agentDir: managedAgentDir,
				declaredCredentialPaths: manifest.declaredCredentialPaths,
				providerId: deliveredCredential.providerId,
				revision: credentialRevision,
			};
		}
		const preparedStart =
			deps.payload.turnStart.state.kind === "accepted"
				? deps.payload.acceptedPreparedStart
				: await prepareFreshLlmTurnStart({
						payload: deps.payload,
						processSnapshot,
						resolvedWorkerProcess,
						piFactory: deps.piFactory,
						sessionCwd,
						pendingInputs,
					});
		if (!preparedStart) {
			throw new Error("Accepted LLM worker start lacks its original prepared tree start");
		}
		receipt = {
			kind: "llm",
			startRecordId: deps.payload.turnStart.id,
			workerLeaseId: deps.payload.workerLeaseId,
			receiptEpoch: deps.payload.workerLeaseId,
			verifiedResourceSnapshotDigest: llmPayload.bootstrap.resourceBundle.digest,
			credentialRevision,
			loadedResourceIds: prepared.loadedResourceIds,
			resolvedModel: { providerId: start.model.providerId, modelId: start.model.modelId },
			preparedStart,
			readyAt: deps.scheduler.now().toISOString(),
		};
	} else {
		receipt = {
			kind: "automatic",
			startRecordId: deps.payload.turnStart.id,
			workerLeaseId: deps.payload.workerLeaseId,
			receiptEpoch: deps.payload.workerLeaseId,
			readyAt: deps.scheduler.now().toISOString(),
		};
	}
	// Pi credentials are file-backed after bootstrap. The complete result and
	// deferred activation must not retain or mutate the IPC credential values.
	const startPayload = withoutCredentialValues(deps.payload);
	const activation: PreparedStartActivation = {
		startPayload,
		managedAgentDir,
		managedModelProfileId,
		workspaceRoot,
		sessionCwd,
		processSnapshot,
		resolvedPiConfig,
	};

	return {
		startPayload,
		resolvedWorkerProcess,
		projectSnapshots,
		processSnapshot,
		activation,
		resolvedPiConfig,
		diagnostics,
		readyPayload: {
			resumed: deps.payload.resume,
			primaryTreeFile: deps.payload.treePaths.primaryTreeFile,
			workspaceRoot: deps.payload.treePaths.workspaceRoot,
			aggregatedAgentsSources: aggregatedAgentsMdSources,
			loadedSkills,
			loadedAgentsFiles,
			loadedSkillFiles,
			rootEntryId: null,
			receipt,
		},
		pendingInputs,
		...(credentialRefresh ? { credentialRefresh } : {}),
	};
}
