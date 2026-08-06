import type {
	ModelSelectionProvenance,
	ProcessInstance,
	ResolvedTurnStart,
	TurnStartPreparationFailureCode,
	TurnStartRecordState,
} from "@leitwerk-dev/domain";
import { filterProviderOptionsForDefinition } from "@leitwerk-dev/process-sdk";
import { IPC_PROTOCOL_VERSION, WORKER_API_VERSION } from "@leitwerk-dev/worker-protocol";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type {
	ModelStatusCache,
	ModelStatusCacheSnapshot,
} from "../model-providers/model-status-cache.js";
import { resolveRegisteredProviderOptions } from "../model-providers/provider-options.js";
import type { ModelProviderRegistry } from "../model-providers/registry.js";
import { assemblePiResourceSnapshot, type PiResourceBundleCache } from "../pi-resources/index.js";
import {
	buildRuntimeProfileSelectionInput,
	selectWorkerRuntimeProfile,
} from "../worker-runtime-profile-selection.js";
import type { Writes } from "./writes/writes.js";

const PI_RUNTIME_VERSION = "0.81.1";

export interface TurnStartPreflightDeps {
	config: LeitwerkConfig;
	registry: ModelProviderRegistry;
	modelStatusCache: ModelStatusCache;
	piContributions: Parameters<typeof assemblePiResourceSnapshot>[0]["piContributions"];
	bundleCache: PiResourceBundleCache;
	projects: Pick<RepositoryBundle["projects"], "listByInstance">;
	processSkills: Pick<RepositoryBundle["processSkills"], "listResourceLayers">;
}

export type TurnStartPreflightResult = { ok: true } | { ok: false; code: string; message: string };

function failure(
	requestedModelProfileId: string | null,
	providerOptions: Record<string, string>,
	code: TurnStartPreparationFailureCode,
	safeSummary: string,
	modelSelectionProvenance?: ModelSelectionProvenance,
	availabilityRevision?: number,
): TurnStartRecordState {
	return {
		kind: "preparation_failed",
		requestedModelProfileId,
		providerOptions,
		code,
		safeSummary,
		...(modelSelectionProvenance ? { modelSelectionProvenance } : {}),
		...(availabilityRevision !== undefined ? { availabilityRevision } : {}),
	};
}

function previousProviderOptions(state: TurnStartRecordState): Record<string, string> {
	if (state.kind === "preparation_failed") return { ...state.providerOptions };
	if (state.kind === "superseded" || state.kind === "starting" || state.kind === "accepted") {
		return state.start?.kind === "llm" ? { ...state.start.providerOptions } : {};
	}
	return state.start.kind === "llm" ? { ...state.start.providerOptions } : {};
}

function previousProviderId(
	deps: TurnStartPreflightDeps,
	state: TurnStartRecordState,
): string | null {
	if (state.kind !== "preparation_failed") {
		return state.start?.kind === "llm" ? state.start.model.providerId : null;
	}
	const profileId = state.requestedModelProfileId;
	return profileId
		? (deps.config.pi.model_profiles.find((profile) => profile.id === profileId)?.provider ?? null)
		: null;
}

function parkPreparationFailure(
	writes: Writes,
	write: Extract<Writes["turnStartWrites"][number], { kind: "create" }>,
	state: TurnStartRecordState,
): void {
	write.input.state = state;
	writes.processPatch.lifecycleStatus = "error";
	// Reconciliation may stop an obsolete worker, but it must not launch the
	// preparation-failed start.
	writes.workerIntent = { kind: "reconcile" };
}

function candidateProcess(process: ProcessInstance, writes: Writes): ProcessInstance {
	return { ...process, ...writes.processPatch };
}

function defaultRuntimeProfile(config: LeitwerkConfig): string | null {
	if (config.workers.runner === "local") {
		return config.workers.default_runtime_profile ?? "local";
	}
	return (
		(config.workers.runner === "kubernetes"
			? config.kubernetes?.default_worker_runtime_profile
			: undefined) ??
		config.workers.default_runtime_profile ??
		null
	);
}

function resolveRuntimeProfile(
	deps: TurnStartPreflightDeps,
	process: ProcessInstance,
): { ok: true; id: string } | { ok: false; message: string } {
	if (deps.config.workers.runner === "local") {
		return { ok: true, id: defaultRuntimeProfile(deps.config) ?? "local" };
	}
	const selection = selectWorkerRuntimeProfile(
		buildRuntimeProfileSelectionInput({
			config: deps.config,
			processId: process.processId,
			componentKeys: deps.projects.listByInstance(process.id).map((project) => project.key),
		}),
	);
	return selection.ok
		? { ok: true, id: selection.runtimeProfile }
		: { ok: false, message: selection.error };
}

function resolveProviderWorkerConfig(
	provider: ReturnType<ModelProviderRegistry["require"]>,
	options: Readonly<Record<string, string>>,
): Extract<ResolvedTurnStart, { kind: "llm" }>["providerWorkerConfig"] {
	if (provider.definition.worker.kind !== "extension_pi_worker") return null;
	const definition = provider.definition.worker.config;
	if (!definition) return null;
	const projected = definition.resolve({ config: provider.config, options });
	const value = definition.schema.parse(projected);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Provider worker configuration must be a JSON object");
	}
	return { version: definition.version, value };
}

function resolveProviderPiModels(
	provider: ReturnType<ModelProviderRegistry["require"]>,
): Record<string, unknown> {
	const worker = provider.definition.worker;
	return worker.kind === "configured_pi_provider"
		? worker.resolveModels({ config: provider.config })
		: { providers: {} };
}

function buildPiSettings(config: LeitwerkConfig): Record<string, unknown> {
	// Keep the immutable settings layer declarative. Runtime duration parsing and
	// request retries are still applied by the worker's standard Pi services.
	return {
		retry: {
			enabled: config.pi.retry.enabled,
			maxRetries: config.pi.retry.max_retries,
			baseDelay: config.pi.retry.base_delay,
			provider: {
				timeout: config.pi.retry.provider.timeout,
				maxRetries: config.pi.retry.provider.max_retries,
				maxRetryDelay: config.pi.retry.provider.max_retry_delay,
			},
		},
	};
}

/**
 * Replaces placeholder LLM start states after the effective model has been
 * resolved but before the process/start transaction commits. Provider I/O is
 * deliberately absent: this consumes the bounded model-status cache only.
 */
export async function prepareCreatedTurnStarts(
	deps: TurnStartPreflightDeps,
	process: ProcessInstance,
	writes: Writes,
	explicitProviderOptions?: Readonly<Record<string, string>>,
	availabilitySnapshot?: ModelStatusCacheSnapshot,
): Promise<TurnStartPreflightResult> {
	const nextProcess = candidateProcess(process, writes);
	const availability = availabilitySnapshot ?? deps.modelStatusCache.snapshot();
	const provenance =
		nextProcess.selectedTurnModelKind && nextProcess.selectedTurnModelSource
			? {
					kind: nextProcess.selectedTurnModelKind,
					source: nextProcess.selectedTurnModelSource,
				}
			: undefined;
	for (let index = 0; index < writes.turnStartWrites.length; index += 1) {
		const write = writes.turnStartWrites[index];
		if (!write || write.kind !== "create" || write.input.turnType !== "llm") continue;

		const requestedProfileId = nextProcess.selectedTurnModelProfileId?.trim() || null;
		const retainedState = write.input.state;
		const retainedOptions = previousProviderOptions(retainedState);
		if (
			retainedState.kind === "preparation_failed" &&
			retainedState.code === "invalid_model_configuration"
		) {
			parkPreparationFailure(writes, write, retainedState);
			continue;
		}
		if (!requestedProfileId) {
			parkPreparationFailure(
				writes,
				write,
				failure(
					null,
					retainedOptions,
					"model_required",
					"Choose a model before retrying startup",
					undefined,
					availability.revision,
				),
			);
			continue;
		}

		const profile = deps.config.pi.model_profiles.find((item) => item.id === requestedProfileId);
		if (!profile) {
			return {
				ok: false,
				code: "invalid_model_profile",
				message: `Unknown model profile '${requestedProfileId}'`,
			};
		}
		const provider = deps.registry.require(profile.provider);
		const retainedProviderId = previousProviderId(deps, retainedState);
		const recoveryOptions = explicitProviderOptions
			? { ...explicitProviderOptions }
			: retainedProviderId !== null && retainedProviderId !== provider.id
				? {
						...filterProviderOptionsForDefinition(provider.definition.options, retainedOptions),
					}
				: retainedOptions;
		const optionResult = resolveRegisteredProviderOptions({
			provider,
			explicit: recoveryOptions,
			profileDefaults: profile.provider_options ?? {},
		});
		if (!optionResult.ok) {
			const onlyRequired = optionResult.issues.every((issue) => issue.code === "required");
			if (!onlyRequired) {
				return {
					ok: false,
					code: "invalid_provider_options",
					message: optionResult.issues.map((issue) => issue.message).join("; "),
				};
			}
			parkPreparationFailure(
				writes,
				write,
				failure(
					profile.id,
					recoveryOptions,
					"provider_options_required",
					optionResult.issues.map((issue) => issue.message).join("; "),
				),
			);
			continue;
		}

		const status = availability.profiles.find((candidate) => candidate.profileId === profile.id);
		if (!status || status.availability !== "available") {
			parkPreparationFailure(
				writes,
				write,
				failure(
					profile.id,
					recoveryOptions,
					!status || status.availability === "stale" ? "model_stale" : "model_unavailable",
					status?.safeReason ?? "The selected model status is stale",
					provenance,
					availability.revision,
				),
			);
			continue;
		}

		try {
			const runtimeProfile = resolveRuntimeProfile(deps, nextProcess);
			if (!runtimeProfile.ok) throw new Error(runtimeProfile.message);
			const providerWorkerConfig = resolveProviderWorkerConfig(provider, optionResult.value);
			const piSettings = buildPiSettings(deps.config);
			const model = {
				profileId: profile.id,
				providerId: profile.provider,
				modelId: profile.model_id,
				thinkingLevel: profile.thinking_level ?? "off",
			};
			const resourceLayers = deps.processSkills.listResourceLayers(nextProcess.id);
			const assembled = await assemblePiResourceSnapshot({
				resourceLayers,
				piContributions: deps.piContributions,
				model,
				providerOptions: optionResult.value,
				providerWorkerConfig,
				piSettings,
				piModels: resolveProviderPiModels(provider),
				declaredCredentialPaths: [
					"auth.json",
					...(provider.definition.worker.kind === "extension_pi_worker"
						? (provider.definition.worker.credentialFiles ?? [])
						: []),
				],
				compatibility: {
					workerApiVersion: WORKER_API_VERSION,
					piVersion: PI_RUNTIME_VERSION,
					protocolVersion: IPC_PROTOCOL_VERSION,
				},
			});
			deps.bundleCache.put(assembled.bundle);
			write.input.state = {
				kind: "starting",
				start: {
					kind: "llm",
					model,
					...(provenance ? { modelSelectionProvenance: provenance } : {}),
					availabilityRevision: availability.revision,
					providerOptions: { ...optionResult.value },
					providerWorkerConfig,
					piResourceSnapshotDigest: assembled.bundle.digest,
					workerRuntimeProfileId: runtimeProfile.id,
					piSettings,
				},
			};
			writes.processPatch.lifecycleStatus = "active";
			writes.workerIntent = { kind: "restart_worker" };
		} catch {
			parkPreparationFailure(
				writes,
				write,
				failure(
					profile.id,
					{ ...optionResult.value },
					"provider_preflight_failed",
					"The provider could not prepare this worker start",
				),
			);
		}
	}
	return { ok: true };
}
