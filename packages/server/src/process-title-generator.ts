import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type ProcessInstance, trimToNull } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan, ProcessTitleSourceField } from "@leitwerk-dev/process-sdk";
import { expandPiAgentDir } from "@leitwerk-dev/process-sdk/pi-config";
import { createDurableWsFrame, parseFutureLaunchPayloadJson } from "@leitwerk-dev/protocol";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { LeitwerkConfig } from "./config/config-types.js";
import type { ProcessTitleJob, RepositoryBundle } from "./db/repositories.js";
import type { ExtensionHost } from "./extensions/extension-host.js";
import type { LaunchCoordinator } from "./launch-coordinator.js";
import { normalizeProcessTitleInput, truncateTextAtWordBoundary } from "./launch-title.js";
import type { Broadcaster } from "./ws/broadcast.js";

export const TITLE_SYSTEM_PROMPT = `You write concise operator-facing titles for process instances.
Return only the title text.
Keep it short, specific, and easy to scan in a sidebar.
Do not use quotes, markdown, bullets, or prefixes like Title:.`;

const MAX_SOURCE_VALUE_LENGTH = 240;
const MAX_SOURCE_FIELDS = 6;
const DEFAULT_TITLE_GENERATION_POLL_INTERVAL_MS = 1_000;
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

type ProcessTitleRepos = Pick<RepositoryBundle, "futureExecutions" | "processes" | "titleJobs">;

export interface ProcessTitleLogger {
	warn(message: string, details?: Record<string, unknown>): void;
}

export interface ProcessTitleGenerator {
	start?(): Promise<void>;
	queueProcessTitleGeneration(input: {
		processId: string;
		launchPlan: ProcessLaunchPlan;
		launchRunId?: string;
	}): void;
	queueFutureExecutionTitleGeneration(input: {
		futureExecutionId: string;
		launchPlan: ProcessLaunchPlan;
		expectedPayloadJson?: string;
	}): void;
	close?(): Promise<void>;
}

interface ProcessTitleRuntimeDiagnosticSummary {
	type?: string;
	message: string;
}

interface ProcessTitleProviderOptions {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs: number;
}

export type FutureExecutionTitleApplier = (input: {
	futureExecutionId: string;
	expectedPayloadJson: string;
	title: string;
}) => Promise<
	| { kind: "applied" }
	| { kind: "applied_with_reaction_error"; error: string; code: string }
	| { kind: "superseded" }
	| { kind: "failed"; error: string }
>;

export interface ProcessTitleGeneratorRuntimeDeps {
	generateTitle(input: {
		expandedAgentDir: string;
		provider: string;
		modelId: string;
		prompt: string;
		maxTokens: number;
		providerOptions: ProcessTitleProviderOptions;
	}): Promise<string>;
	defer(work: () => void): { unref?(): void };
	now(): Date;
	pollIntervalMs: number;
}

export interface ProcessTitleRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

type GeneratedTitleAttemptResult = { ok: true; title: string } | { ok: false; error: string };

type TitleTargetState =
	| { kind: "ready" }
	| { kind: "superseded" }
	| { kind: "failed"; error: string };

type ApplyGeneratedTitleResult =
	| {
			kind: "applied";
			postCommit?: () => Promise<void>;
	  }
	| { kind: "superseded" }
	| { kind: "failed"; error: string };

type FutureExecutionTitleJobTarget =
	| { ok: true; futureExecutionId: string; expectedPayloadJson: string }
	| { ok: false; error: string };

function getFutureExecutionTitleJobTarget(job: ProcessTitleJob): FutureExecutionTitleJobTarget {
	if (!job.futureExecutionId) {
		return { ok: false, error: "Process title job is missing futureExecutionId" };
	}
	if (!job.expectedPayloadJson) {
		return { ok: false, error: "Future-execution title job is missing expectedPayloadJson" };
	}
	return {
		ok: true,
		futureExecutionId: job.futureExecutionId,
		expectedPayloadJson: job.expectedPayloadJson,
	};
}

export function normalizeProcessTitle(value: string | null | undefined): string | null {
	const trimmed = trimToNull(value);
	if (!trimmed) {
		return null;
	}
	const withoutPrefix = trimmed
		.replace(/^title\s*[:-]\s*/i, "")
		.replace(/^[•*-]\s*/, "")
		.trim();
	const withoutQuotes = withoutPrefix.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
	if (!withoutQuotes) {
		return null;
	}
	return normalizeProcessTitleInput(withoutQuotes);
}

function normalizeSourceValue(value: string): string | null {
	const trimmed = trimToNull(value);
	if (!trimmed) {
		return null;
	}
	return truncateTextAtWordBoundary(trimmed.replace(/\s+/g, " "), MAX_SOURCE_VALUE_LENGTH);
}

export function buildProcessTitleSourceFields(
	launchPlan: ProcessLaunchPlan,
): ProcessTitleSourceField[] {
	const normalized: ProcessTitleSourceField[] = [];
	const seen = new Set<string>();
	for (const field of launchPlan.titleSourceFields ?? []) {
		if (normalized.length >= MAX_SOURCE_FIELDS) {
			break;
		}
		const label = trimToNull(field.label) ?? `Field ${normalized.length + 1}`;
		const value = normalizeSourceValue(field.value);
		if (!value) {
			continue;
		}
		const dedupeKey = `${label}\n${value}`;
		if (seen.has(dedupeKey)) {
			continue;
		}
		seen.add(dedupeKey);
		normalized.push({ label, value });
	}
	return normalized;
}

export function buildProcessTitlePrompt(launchPlan: ProcessLaunchPlan): string | null {
	const fields = buildProcessTitleSourceFields(launchPlan);
	if (fields.length === 0) {
		return null;
	}
	const promptLines = [
		`Process id: ${launchPlan.processId}`,
		...(launchPlan.processInput.externalId
			? [`External reference: ${launchPlan.processInput.externalId}`]
			: []),
		"Launcher-defined title source fields:",
		...fields.map((field) => `- ${field.label}: ${field.value}`),
		"",
		"Return a concise title of 3 to 8 words.",
	];
	return promptLines.join("\n");
}

function applyNormalizedTitle(
	launchPlan: ProcessLaunchPlan,
	title: string | null,
): ProcessLaunchPlan {
	return {
		...launchPlan,
		processInput: {
			...launchPlan.processInput,
			title,
		},
	};
}

function normalizeLaunchPlanTitle(launchPlan: ProcessLaunchPlan): ProcessLaunchPlan {
	return applyNormalizedTitle(
		launchPlan,
		normalizeProcessTitleInput(launchPlan.processInput.title),
	);
}

function isTitleModelAllowedForProcess(
	config: LeitwerkConfig,
	processId: string,
	modelProfileId: string,
): boolean {
	const allowedProfiles = config.process_configs?.[processId]?.allowed_model_profiles;
	return !allowedProfiles || allowedProfiles.includes(modelProfileId);
}

function collectProcessTitleRuntimeDiagnostics(
	services: AgentSessionServices,
): ProcessTitleRuntimeDiagnosticSummary[] {
	const extensionLoadDiagnostics = services.resourceLoader
		.getExtensions()
		.errors.map(({ path: extensionPath, error }) => ({
			type: "error",
			message: `Extension '${extensionPath}' failed to load: ${error}`,
		}));
	return [...services.diagnostics, ...extensionLoadDiagnostics];
}

function formatProcessTitleRuntimeDiagnostics(
	diagnostics: readonly ProcessTitleRuntimeDiagnosticSummary[],
): string {
	const messages = diagnostics
		.filter((diagnostic) => diagnostic.type === undefined || diagnostic.type === "error")
		.map((diagnostic) => diagnostic.message.trim())
		.filter((message) => message.length > 0);
	if (messages.length === 0) {
		return "";
	}
	return ` Pi extension diagnostics: ${messages.join("; ")}`;
}

let piAgentDirEnvQueue = Promise.resolve();

async function withPiAgentDirEnv<T>(agentDir: string, work: () => Promise<T>): Promise<T> {
	let release: () => void = () => {};
	const previousWork = piAgentDirEnvQueue;
	piAgentDirEnvQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previousWork;

	const previous = process.env[PI_AGENT_DIR_ENV];
	process.env[PI_AGENT_DIR_ENV] = agentDir;
	try {
		return await work();
	} finally {
		if (previous === undefined) {
			delete process.env[PI_AGENT_DIR_ENV];
		} else {
			process.env[PI_AGENT_DIR_ENV] = previous;
		}
		release();
	}
}

function createDefaultRuntimeDeps(): ProcessTitleGeneratorRuntimeDeps {
	let runtimePromise:
		| Promise<{
				services: AgentSessionServices;
				diagnostics: ProcessTitleRuntimeDiagnosticSummary[];
		  }>
		| undefined;

	return {
		async generateTitle(input) {
			runtimePromise ??= withPiAgentDirEnv(input.expandedAgentDir, async () => {
				const services = await createAgentSessionServices({
					cwd: input.expandedAgentDir,
					agentDir: input.expandedAgentDir,
					resourceLoaderOptions: {
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						systemPrompt: TITLE_SYSTEM_PROMPT,
						appendSystemPrompt: [],
					},
				});
				services.settingsManager.applyOverrides({
					compaction: { enabled: false },
					retry: { enabled: false, provider: input.providerOptions },
				});
				return {
					services,
					diagnostics: collectProcessTitleRuntimeDiagnostics(services),
				};
			});

			const { services, diagnostics } = await runtimePromise.catch((error) => {
				runtimePromise = undefined;
				throw error;
			});
			const model = services.modelRuntime.getModel(input.provider, input.modelId);
			if (!model) {
				throw new Error(
					`Configured provider/model '${input.provider}/${input.modelId}' was not available in the Pi model registry${formatProcessTitleRuntimeDiagnostics(diagnostics)}`,
				);
			}

			return await withPiAgentDirEnv(input.expandedAgentDir, async () => {
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.inMemory(input.expandedAgentDir),
					model: { ...model, maxTokens: Math.min(input.maxTokens, model.maxTokens) },
					thinkingLevel: "off",
					noTools: "all",
				});
				try {
					await session.prompt(input.prompt, { expandPromptTemplates: false });
					const message = session.messages.at(-1);
					if (message?.role !== "assistant") {
						throw new Error("Title generation returned no assistant message");
					}
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						throw new Error(
							message.errorMessage ??
								`Title generation ended with stopReason '${message.stopReason}'`,
						);
					}
					return message.content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n")
						.trim();
				} finally {
					session.dispose();
				}
			});
		},
		defer(work) {
			return setImmediate(work);
		},
		now() {
			return new Date();
		},
		pollIntervalMs: DEFAULT_TITLE_GENERATION_POLL_INTERVAL_MS,
	};
}

export function buildProcessTitleRetryPolicy(config: LeitwerkConfig): ProcessTitleRetryPolicy {
	return {
		maxAttempts: Math.max(1, Math.trunc(config.pi.process_title_generation.retry.max_attempts)),
		baseDelayMs: parseDurationMs(config.pi.process_title_generation.retry.base_delay, 5_000, {
			allowHours: true,
		}),
		maxDelayMs: parseDurationMs(config.pi.process_title_generation.retry.max_delay, 300_000, {
			allowHours: true,
		}),
	};
}

export function computeProcessTitleRetryDelayMs(
	attemptCount: number,
	policy: ProcessTitleRetryPolicy,
): number {
	const exponent = Math.max(0, Math.trunc(attemptCount) - 1);
	const scaledDelay = policy.baseDelayMs * 2 ** exponent;
	return Math.max(1, Math.min(policy.maxDelayMs, scaledDelay));
}

class DefaultProcessTitleGenerator implements ProcessTitleGenerator {
	private readonly configuredProfileId: string | null;
	private readonly retryPolicy: ProcessTitleRetryPolicy;
	private readonly expandedAgentDir: string;
	private readonly pendingOperations = new Set<Promise<void>>();
	private readonly pollIntervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private tickInProgress = false;
	private tickScheduled = false;
	private closed = false;

	constructor(
		private readonly config: LeitwerkConfig,
		private readonly repos: ProcessTitleRepos,
		private readonly broadcaster: Broadcaster,
		private readonly logger?: ProcessTitleLogger,
		private readonly runtime: ProcessTitleGeneratorRuntimeDeps = createDefaultRuntimeDeps(),
		private readonly extensionHost?: ExtensionHost,
		private readonly futureExecutionTitleApplier?: FutureExecutionTitleApplier,
		private readonly getLaunchCoordinator?: () => LaunchCoordinator | undefined,
	) {
		this.configuredProfileId = trimToNull(config.pi.process_title_generation.model_profile);
		this.retryPolicy = buildProcessTitleRetryPolicy(config);
		this.expandedAgentDir = expandPiAgentDir(config.pi.agent_dir);
		this.pollIntervalMs = Math.max(1, Math.trunc(runtime.pollIntervalMs));
	}

	async start(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.ensurePollingStarted();
		this.requestImmediateTick();
		await Promise.resolve();
	}

	queueProcessTitleGeneration(input: {
		processId: string;
		launchPlan: ProcessLaunchPlan;
		launchRunId?: string;
	}): void {
		if (this.closed) {
			return;
		}
		const queued = this.buildQueuedJobBase(input.launchPlan);
		if (!queued) {
			if (!input.launchPlan.processInput.title) {
				this.getLaunchCoordinator?.()?.observeTitle(
					input.processId,
					"skipped",
					undefined,
					input.launchRunId,
				);
			}
			return;
		}
		this.repos.titleJobs.enqueueProcessJob({
			processInstanceId: input.processId,
			processDefinitionId: queued.processDefinitionId,
			launchRunId: input.launchRunId,
			modelProfileId: queued.modelProfileId,
			prompt: queued.prompt,
			maxAttempts: this.retryPolicy.maxAttempts,
			nextRunAt: this.runtime.now().toISOString(),
		});
		this.ensurePollingStarted();
		this.requestImmediateTick();
	}

	queueFutureExecutionTitleGeneration(input: {
		futureExecutionId: string;
		launchPlan: ProcessLaunchPlan;
		expectedPayloadJson?: string;
	}): void {
		if (this.closed) {
			return;
		}
		const queued = this.buildQueuedJobBase(input.launchPlan);
		if (!queued) {
			return;
		}
		const expectedPayloadJson =
			typeof input.expectedPayloadJson === "string"
				? input.expectedPayloadJson
				: this.repos.futureExecutions.getById(input.futureExecutionId)?.payloadJson;
		if (!expectedPayloadJson) {
			return;
		}
		this.repos.titleJobs.enqueueFutureExecutionJob({
			futureExecutionId: input.futureExecutionId,
			processDefinitionId: queued.processDefinitionId,
			modelProfileId: queued.modelProfileId,
			prompt: queued.prompt,
			expectedPayloadJson,
			maxAttempts: this.retryPolicy.maxAttempts,
			nextRunAt: this.runtime.now().toISOString(),
		});
		this.ensurePollingStarted();
		this.requestImmediateTick();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await Promise.allSettled(this.pendingOperations);
	}

	private buildQueuedJobBase(
		launchPlan: ProcessLaunchPlan,
	): { processDefinitionId: string; modelProfileId: string; prompt: string } | null {
		const normalizedLaunchPlan = normalizeLaunchPlanTitle(launchPlan);
		if (normalizedLaunchPlan.processInput.title || !this.configuredProfileId) {
			return null;
		}
		if (
			!isTitleModelAllowedForProcess(
				this.config,
				normalizedLaunchPlan.processId,
				this.configuredProfileId,
			)
		) {
			this.logger?.warn(
				"Skipping process title generation because the configured model profile is not allowed for this process",
				{
					processId: normalizedLaunchPlan.processId,
					modelProfileId: this.configuredProfileId,
				},
			);
			return null;
		}
		const prompt = buildProcessTitlePrompt(normalizedLaunchPlan);
		if (!prompt) {
			return null;
		}
		return {
			processDefinitionId: normalizedLaunchPlan.processId,
			modelProfileId: this.configuredProfileId,
			prompt,
		};
	}

	private ensurePollingStarted(): void {
		if (this.closed || this.timer) {
			return;
		}
		this.timer = setInterval(() => {
			this.trackOperation(this.tick());
		}, this.pollIntervalMs);
		this.timer.unref?.();
	}

	private requestImmediateTick(): void {
		if (this.closed || this.tickScheduled) {
			return;
		}
		this.tickScheduled = true;
		const handle = this.runtime.defer(() => {
			this.tickScheduled = false;
			if (this.closed) {
				return;
			}
			this.trackOperation(this.tick());
		});
		handle.unref?.();
	}

	private trackOperation(promise: Promise<void>): void {
		this.pendingOperations.add(promise);
		void promise.finally(() => {
			this.pendingOperations.delete(promise);
		});
	}

	private async tick(): Promise<void> {
		if (this.closed || this.tickInProgress) {
			return;
		}
		this.tickInProgress = true;
		try {
			while (!this.closed) {
				const job = this.claimDueJob();
				if (!job) {
					return;
				}
				try {
					await this.performJob(job);
				} catch (error) {
					this.logger?.warn("Process title generation job failed unexpectedly", {
						jobId: job.id,
						targetKind: job.targetKind,
						processDefinitionId: job.processDefinitionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} finally {
			this.tickInProgress = false;
		}
	}

	private claimDueJob(): ProcessTitleJob | null {
		for (const job of this.repos.titleJobs.listDuePending(this.runtime.now().toISOString(), 1)) {
			const running = this.repos.titleJobs.markRunning(job.id);
			if (running) {
				return running;
			}
		}
		return null;
	}

	private async performJob(job: ProcessTitleJob): Promise<void> {
		const targetState = this.getTargetState(job);
		if (targetState.kind === "superseded") {
			this.repos.titleJobs.markSuperseded(job.id);
			return;
		}
		if (targetState.kind === "failed") {
			if (this.repos.titleJobs.markFailed(job.id, targetState.error)) {
				this.updateLaunchTitleStep(
					job.processInstanceId,
					"failed",
					"Process started, but title generation is unavailable. You can rename it later.",
					job.launchRunId,
				);
			}
			return;
		}

		const generated = await this.generateTitle(job);
		if (!this.isJobStillRunning(job.id)) {
			return;
		}
		if (!generated.ok) {
			this.handleFailedAttempt(job.id, generated.error);
			return;
		}

		const applied =
			job.targetKind === "process"
				? this.applyProcessTitle(job, generated.title)
				: await this.applyFutureExecutionTitle(job, generated.title);
		if (applied.kind === "superseded") {
			this.repos.titleJobs.markSuperseded(job.id);
			return;
		}
		if (applied.kind === "failed") {
			this.handleFailedAttempt(job.id, applied.error);
			return;
		}
		if (!this.repos.titleJobs.markCompleted(job.id)) {
			return;
		}
		if (job.targetKind === "process") {
			this.updateLaunchTitleStep(job.processInstanceId, "completed", undefined, job.launchRunId);
		}
		await applied.postCommit?.();
	}

	private getTargetState(job: ProcessTitleJob): TitleTargetState {
		if (job.targetKind === "process") {
			if (!job.processInstanceId) {
				return { kind: "failed", error: "Process title job is missing processInstanceId" };
			}
			const process = this.repos.processes.getById(job.processInstanceId);
			if (!process || normalizeProcessTitleInput(process.title)) {
				return { kind: "superseded" };
			}
			return { kind: "ready" };
		}

		const target = getFutureExecutionTitleJobTarget(job);
		if (!target.ok) return { kind: "failed", error: target.error };
		const execution = this.repos.futureExecutions.getById(target.futureExecutionId);
		if (!execution || execution.kind !== "launch") {
			return { kind: "superseded" };
		}
		if (execution.payloadJson !== target.expectedPayloadJson) {
			return { kind: "superseded" };
		}
		const parsedPayload = parseFutureLaunchPayloadJson(execution.payloadJson);
		if (!parsedPayload.ok) {
			return {
				kind: "failed",
				error: parsedPayload.error,
			};
		}
		if (normalizeProcessTitleInput(parsedPayload.value.launchPlan.processInput.title)) {
			return { kind: "superseded" };
		}
		return { kind: "ready" };
	}

	private applyProcessTitle(job: ProcessTitleJob, title: string): ApplyGeneratedTitleResult {
		if (!job.processInstanceId) {
			return { kind: "failed", error: "Process title job is missing processInstanceId" };
		}
		const updated = this.repos.processes.setGeneratedTitleIfBlank(job.processInstanceId, title);
		if (!updated) {
			return { kind: "superseded" };
		}
		return {
			kind: "applied",
			postCommit: async () => {
				this.broadcaster.broadcast(
					createDurableWsFrame({
						type: "process.updated",
						payload: {
							process: { title: updated.title },
							changedFields: ["title"],
						},
						instanceId: updated.id,
					}),
				);
				await this.emitProcessUpdated(updated, ["title"]);
			},
		};
	}

	private async applyFutureExecutionTitle(
		job: ProcessTitleJob,
		title: string,
	): Promise<ApplyGeneratedTitleResult> {
		const target = getFutureExecutionTitleJobTarget(job);
		if (!target.ok) return { kind: "failed", error: target.error };
		if (!this.futureExecutionTitleApplier) {
			return { kind: "failed", error: "Future-execution title applier is unavailable" };
		}
		const applied = await this.futureExecutionTitleApplier({
			futureExecutionId: target.futureExecutionId,
			expectedPayloadJson: target.expectedPayloadJson,
			title,
		});
		if (applied.kind === "superseded" || applied.kind === "failed") return applied;
		if (applied.kind === "applied_with_reaction_error") {
			this.logger?.warn("Generated future-execution title committed with a reaction error", {
				futureExecutionId: target.futureExecutionId,
				code: applied.code,
				error: applied.error,
			});
		}
		return { kind: "applied" };
	}

	private async emitProcessUpdated(
		process: ProcessInstance,
		changedFields: readonly string[],
	): Promise<void> {
		try {
			await this.extensionHost?.emit("process_updated", {
				instanceId: process.id,
				process,
				changedFields,
			});
		} catch (error) {
			this.logger?.warn("Process title extension event handler failed", {
				instanceId: process.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async generateTitle(job: ProcessTitleJob): Promise<GeneratedTitleAttemptResult> {
		const configuredProfile = this.config.pi.model_profiles.find(
			(profile) => profile.id === job.modelProfileId,
		);
		if (!configuredProfile) {
			return {
				ok: false,
				error: `Configured model profile '${job.modelProfileId}' could not be resolved`,
			};
		}

		try {
			const title = await this.runtime.generateTitle({
				expandedAgentDir: this.expandedAgentDir,
				provider: configuredProfile.provider,
				modelId: configuredProfile.model_id,
				prompt: job.prompt,
				maxTokens: 48,
				providerOptions: this.getProviderRequestOptions(),
			});
			const normalizedTitle = normalizeProcessTitle(title);
			if (!normalizedTitle) {
				return { ok: false, error: "Title generation returned empty title text" };
			}
			return { ok: true, title: normalizedTitle };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private getProviderRequestOptions(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
	} {
		const providerRetry = this.config.pi.retry.provider;
		return {
			...(providerRetry.timeout
				? {
						timeoutMs: parseDurationMs(providerRetry.timeout, 0, {
							allowHours: true,
						}),
					}
				: {}),
			...(providerRetry.max_retries !== null && providerRetry.max_retries !== undefined
				? { maxRetries: providerRetry.max_retries }
				: {}),
			maxRetryDelayMs: parseDurationMs(providerRetry.max_retry_delay ?? "60s", 60_000, {
				allowHours: true,
			}),
		};
	}

	private updateLaunchTitleStep(
		processInstanceId: string | null,
		status: "completed" | "skipped" | "failed",
		safeSummary?: string,
		launchRunId?: string | null,
	): void {
		if (!processInstanceId) return;
		this.getLaunchCoordinator?.()?.observeTitle(
			processInstanceId,
			status,
			safeSummary,
			launchRunId,
		);
	}

	private isJobStillRunning(jobId: string): boolean {
		return this.repos.titleJobs.getById(jobId)?.status === "running";
	}

	private handleFailedAttempt(jobId: string, error: string): void {
		const current = this.repos.titleJobs.getById(jobId);
		if (!current || current.status !== "running") {
			return;
		}
		if (current.attemptCount >= current.maxAttempts) {
			if (this.repos.titleJobs.markFailed(jobId, error)) {
				this.updateLaunchTitleStep(
					current.processInstanceId,
					"failed",
					"Process started, but a title could not be generated. You can rename it later.",
					current.launchRunId,
				);
				this.logger?.warn("Process title generation exhausted its retry budget", {
					jobId,
					targetKind: current.targetKind,
					processDefinitionId: current.processDefinitionId,
					attemptCount: current.attemptCount,
					maxAttempts: current.maxAttempts,
					error,
				});
			}
			return;
		}
		const nextRunAt = new Date(
			this.runtime.now().getTime() +
				computeProcessTitleRetryDelayMs(current.attemptCount, this.retryPolicy),
		).toISOString();
		if (this.repos.titleJobs.reschedule(jobId, nextRunAt, error)) {
			this.logger?.warn("Process title generation scheduled a retry", {
				jobId,
				targetKind: current.targetKind,
				processDefinitionId: current.processDefinitionId,
				attemptCount: current.attemptCount,
				maxAttempts: current.maxAttempts,
				nextRunAt,
				error,
			});
		}
	}
}

export function createProcessTitleGenerator(options: {
	config: LeitwerkConfig;
	repos: ProcessTitleRepos;
	broadcaster: Broadcaster;
	logger?: ProcessTitleLogger;
	runtime?: Partial<ProcessTitleGeneratorRuntimeDeps>;
	extensionHost?: ExtensionHost;
	futureExecutionTitleApplier?: FutureExecutionTitleApplier;
	getLaunchCoordinator?: () => LaunchCoordinator | undefined;
}): ProcessTitleGenerator {
	const runtime = { ...createDefaultRuntimeDeps(), ...options.runtime };
	return new DefaultProcessTitleGenerator(
		options.config,
		options.repos,
		options.broadcaster,
		options.logger,
		runtime,
		options.extensionHost,
		options.futureExecutionTitleApplier,
		options.getLaunchCoordinator,
	);
}
