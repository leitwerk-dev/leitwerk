import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
	PreparedTurnStart,
	ProcessInstance,
	ProcessProject,
	ProcessSemanticEntryRefKey,
} from "@leitwerk-dev/domain";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type { WorkerReadyPayload, WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import type { DevelopmentToolEnvironment } from "../development-tool-environment.js";
import type { WorkerDiagnosticPayload } from "../diagnostics.js";
import type { InputItem } from "../input-consumer.js";
import type { PiTreeHandle, PiTreeHandleFactory } from "../pi-adapter.js";
import type { WorkerSessionSnapshotExchange } from "../session-snapshot-exchange.js";
import { isLlmWorkerStartPayload } from "../worker-start-payload.js";
import type { RunRootGitOps } from "../workspace/run-root.js";
import type { WorkerRuntimeScheduler } from "./adapters.js";
import {
	activatePreparedStart,
	bootstrapWorkerRuntime,
	type PreparedStartActivation,
} from "./bootstrap.js";
import type { WorkerRuntimeSettings } from "./settings.js";

interface PreparedSessionBase {
	processSnapshot: ProcessInstance;
	projectSnapshots: ProcessProject[];
	resolvedWorkerProcess: ResolvedWorkerProcess;
	selectedTurnId: string;
	startRecordId: string;
	proposedTurnRecordId: string;
	acceptedTurnRecordId: string | null;
	startKind: WorkerStartPayload["turnStart"]["startKind"];
	llmPreparation?: NonNullable<WorkerStartPayload["llmPreparation"]>;
	treeFile: string;
	workspaceRoot: string;
	turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
	turnResultMarkdownByProduct?: Record<string, string>;
	settings: WorkerRuntimeSettings;
	integrationTools: NonNullable<WorkerStartPayload["integrationTools"]>;
}

export interface PreparedAutomaticSession extends PreparedSessionBase {
	kind: "automatic";
	piAvailable: false;
	activeModelProfileId: null;
}

export interface PreparedLlmSession extends PreparedSessionBase {
	kind: "llm";
	preparedTurnStart: PreparedTurnStart;
	configSnapshot: Extract<WorkerStartPayload, { bootstrap: { kind: "llm" } }>["configSnapshot"];
	piAvailable: boolean;
	activeModelProfileId: string | null;
}

export type PreparedWorkerSession = PreparedAutomaticSession | PreparedLlmSession;

export interface CredentialRefreshDescriptor {
	agentDir: string;
	declaredCredentialPaths: readonly string[];
	providerId: string;
	revision: number;
}

export interface WorkerBootstrapCompletion {
	session: PreparedWorkerSession;
	pendingInputs: InputItem[];
	readyPayload: WorkerReadyPayload;
	credentialRefresh?: CredentialRefreshDescriptor;
	diagnostics: string[];
}

function validatePreparedSession(input: {
	bootstrapped: Awaited<ReturnType<typeof bootstrapWorkerRuntime>>;
	payload: WorkerStartPayload;
	settings: WorkerRuntimeSettings;
}): PreparedWorkerSession {
	const { bootstrapped, payload, settings } = input;
	const process = bootstrapped.resolvedWorkerProcess;
	if (!process)
		throw new Error(`Worker process '${bootstrapped.processSnapshot.processId}' is unavailable`);
	const selectedTurnId = bootstrapped.processSnapshot.selectedTurnId ?? process.startTurnId;
	const binding = process.turns?.get(selectedTurnId);
	const handler = process.definition.turns.get(selectedTurnId);
	if (!binding || !handler) throw new Error(`Selected turn '${selectedTurnId}' is unavailable`);
	const turnStartState = payload.turnStart.state;
	if (turnStartState.kind !== "starting" && turnStartState.kind !== "accepted") {
		throw new Error(`Worker start '${payload.turnStart.id}' has no prepared turn`);
	}
	const preparedKind =
		turnStartState.kind === "starting" ? turnStartState.start.kind : payload.turnStart.turnType;
	if (binding.definition.kind !== preparedKind) {
		throw new Error(
			`Prepared ${preparedKind} start does not match selected ${binding.definition.kind} turn`,
		);
	}
	const base = {
		processSnapshot: bootstrapped.processSnapshot,
		projectSnapshots: bootstrapped.projectSnapshots,
		resolvedWorkerProcess: process,
		selectedTurnId,
		startRecordId: payload.turnStart.id,
		proposedTurnRecordId: payload.turnStart.proposedTurnRecordId,
		acceptedTurnRecordId:
			payload.turnStart.state.kind === "accepted" ? payload.turnStart.state.turnRecordId : null,
		startKind: payload.turnStart.startKind,
		...(payload.llmPreparation ? { llmPreparation: payload.llmPreparation } : {}),
		treeFile: payload.treePaths.primaryTreeFile,
		workspaceRoot: payload.treePaths.workspaceRoot,
		turnResultMarkdownBySemanticRef: payload.turnResultMarkdownBySemanticRef,
		turnResultMarkdownByProduct: payload.turnResultMarkdownByProduct,
		settings,
		integrationTools: payload.integrationTools ?? [],
	};
	if (binding.definition.kind === "automatic") {
		return { ...base, kind: "automatic", piAvailable: false, activeModelProfileId: null };
	}
	if (!isLlmWorkerStartPayload(payload) || bootstrapped.readyPayload.receipt.kind !== "llm") {
		throw new Error(`Selected LLM turn '${selectedTurnId}' lacks LLM bootstrap resources`);
	}
	const preparedTurnStart = bootstrapped.readyPayload.receipt.preparedStart;
	if (!preparedTurnStart)
		throw new Error(`Selected LLM turn '${selectedTurnId}' lacks a prepared tree start`);
	return {
		...base,
		kind: "llm",
		preparedTurnStart,
		configSnapshot: payload.configSnapshot,
		piAvailable: false,
		activeModelProfileId: bootstrapped.processSnapshot.selectedTurnModelProfileId ?? null,
	};
}

type WorkerLiveResourcesDeps = {
	instanceId: string;
	piFactory: PiTreeHandleFactory;
	gitOps: RunRootGitOps;
	developmentTools: DevelopmentToolEnvironment;
	scheduler: WorkerRuntimeScheduler;
	sessionSnapshots?: WorkerSessionSnapshotExchange;
	resolveWorkerProcess?: (
		processId: string,
		opts?: { paramsJson?: string | null; stateJson?: string | null },
	) => Promise<ResolvedWorkerProcess | undefined> | ResolvedWorkerProcess | undefined;
	progress(payload: WorkerDiagnosticPayload): void;
	diagnosticTrace(text: string): void;
};

/** Private concrete holder for provisional and active live resources. */
export class WorkerLiveResources {
	#piHandle: PiTreeHandle | null = null;
	#activeTurnAbort: AbortController | null = null;
	#toolPreparationAbort: AbortController | null = null;
	#provisional = new Map<string, PreparedStartActivation>();

	constructor(private readonly deps: WorkerLiveResourcesDeps) {}

	get piHandle(): PiTreeHandle | null {
		return this.#piHandle;
	}

	async bootstrap(
		payload: WorkerStartPayload,
		settings: WorkerRuntimeSettings,
	): Promise<WorkerBootstrapCompletion> {
		const toolPreparationAbort = new AbortController();
		this.#toolPreparationAbort = toolPreparationAbort;
		const bootstrapped = await bootstrapWorkerRuntime({
			instanceId: this.deps.instanceId,
			payload,
			piFactory: this.deps.piFactory,
			gitOps: this.deps.gitOps,
			developmentTools: this.deps.developmentTools,
			toolPreparationSignal: toolPreparationAbort.signal,
			scheduler: this.deps.scheduler,
			onToolPreparationProgress: (repositoryKey, phase) =>
				this.deps.progress({
					level: "info",
					code: `development_tools.${phase}`,
					message: `${phase === "installing" ? "Installing" : "Verifying"} development tools for ${repositoryKey}`,
					details: { repositoryKey },
				}),
			onToolDiagnosticTrace: this.deps.diagnosticTrace,
			resolveWorkerProcess: this.deps.resolveWorkerProcess,
		}).finally(() => {
			if (this.#toolPreparationAbort === toolPreparationAbort) this.#toolPreparationAbort = null;
		});
		this.#provisional.set(payload.turnStart.id, bootstrapped.activation);
		return {
			session: validatePreparedSession({ bootstrapped, payload, settings }),
			pendingInputs: bootstrapped.pendingInputs,
			readyPayload: bootstrapped.readyPayload,
			...(bootstrapped.credentialRefresh
				? { credentialRefresh: bootstrapped.credentialRefresh }
				: {}),
			diagnostics: bootstrapped.diagnostics,
		};
	}

	async activate(startRecordId: string, turnRecordId: string, session: PreparedWorkerSession) {
		if (session.proposedTurnRecordId !== turnRecordId) {
			throw new Error("Accepted turn record id does not match the prepared worker start");
		}
		const activation = this.#provisional.get(startRecordId);
		if (!activation) throw new Error("Prepared worker start activation is unavailable");
		this.#provisional.delete(startRecordId);
		const activated = await activatePreparedStart({
			instanceId: this.deps.instanceId,
			piFactory: this.deps.piFactory,
			activation,
		});
		this.#piHandle = activated.piHandle;
		return { diagnostics: activated.diagnostics };
	}

	async uploadSnapshot(
		source: { kind: "automatic" | "llm"; treeFile: string },
		reason: string,
		metadata: { turnRecordId: string | null; required: boolean },
	): Promise<void> {
		if (source.kind === "automatic") return;
		if (!this.deps.sessionSnapshots) throw new Error("Session snapshot exchange is unavailable");
		let lastError: unknown;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const result = await this.deps.sessionSnapshots.uploadSnapshot(source.treeFile, reason, {
					turnRecordId: metadata.turnRecordId,
				});
				if (result.kind === "uploaded") return;
				if (!metadata.required) return;
				throw new Error(`Session snapshot upload returned ${result.kind}`);
			} catch (error) {
				lastError = error;
				this.deps.progress({
					level: "warn",
					code: "session_snapshot.upload_failed",
					message: `Session snapshot upload failed: ${error instanceof Error ? error.message : String(error)}`,
					details: { attempt, reason },
				});
				if (attempt < 3) await this.deps.scheduler.sleep(100 * attempt);
			}
		}
		if (!metadata.required) return;
		throw new Error(
			`Mandatory session snapshot upload failed before ${reason}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}

	async runTurn<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#activeTurnAbort) throw new Error("A selected turn is already active");
		const controller = new AbortController();
		this.#activeTurnAbort = controller;
		try {
			return await operation(controller.signal);
		} finally {
			if (this.#activeTurnAbort === controller) this.#activeTurnAbort = null;
		}
	}

	abortToolPreparation(): boolean {
		if (!this.#toolPreparationAbort) return false;
		this.#toolPreparationAbort.abort();
		return true;
	}

	abortActiveTurn(): boolean {
		if (!this.#activeTurnAbort) return false;
		this.#activeTurnAbort.abort();
		return true;
	}

	async abortTurn(): Promise<void> {
		await this.#piHandle?.abortTurn();
	}

	async cleanup(): Promise<void> {
		this.#provisional.clear();
		await this.#piHandle?.close();
		this.#piHandle = null;
		this.deps.gitOps.cleanupRepositoryCredentials?.();
	}
}

/** Reads one credential sample. Values are transient command-result data. */
export async function sampleCredentialFiles(
	descriptor: CredentialRefreshDescriptor,
): Promise<{ values: Record<string, string>; fingerprint: string }> {
	const values: Record<string, string> = {};
	for (const credentialPath of descriptor.declaredCredentialPaths) {
		const json = JSON.parse(await readFile(path.join(descriptor.agentDir, credentialPath), "utf8"));
		if (!json || typeof json !== "object" || Array.isArray(json)) {
			throw new Error(`Credential file '${credentialPath}' must contain a JSON object`);
		}
		if (credentialPath === "auth.json") {
			const selected = (json as Record<string, unknown>)[descriptor.providerId];
			if (selected && typeof selected === "object" && !Array.isArray(selected)) {
				for (const [key, value] of Object.entries(selected as Record<string, unknown>)) {
					if (key === "key" && typeof value === "string") values.apiKey = value;
					else if (["string", "number", "boolean"].includes(typeof value))
						values[key] = String(value);
				}
			}
		} else {
			Object.assign(
				values,
				Object.fromEntries(Object.entries(json).filter(([, value]) => typeof value === "string")),
			);
		}
	}
	const fingerprint = JSON.stringify(
		Object.keys(values)
			.sort()
			.map((key) => [key, values[key]]),
	);
	return { values, fingerprint };
}
