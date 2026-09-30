import { VERSION as PI_RUNTIME_VERSION } from "@earendil-works/pi-coding-agent";
import type {
	ProcessInstance,
	ResolvedTurnStart,
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
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import { presentProcessModelPolicyFailure } from "../process-model-policy-presenter.js";
import type { ScopedSettingsService } from "../scoped-settings-service.js";
import {
	buildRuntimeProfileSelectionInput,
	defaultWorkerRuntimeProfile,
	selectWorkerRuntimeProfile,
} from "../worker-runtime-profile-selection.js";
import type { Writes } from "./writes/writes.js";

export interface TurnStartPreflightDeps {
	scopedSettings?: Pick<ScopedSettingsService, "capture">;
	processModelPolicy: ServerProcessModelPolicy;
	config: LeitwerkConfig;
	registry: ModelProviderRegistry;
	modelStatusCache: ModelStatusCache;
	piContributions: Parameters<typeof assemblePiResourceSnapshot>[0]["piContributions"];
	bundleCache: PiResourceBundleCache;
	projects: Pick<RepositoryBundle["projects"], "listByInstance">;
	processSkills: Pick<RepositoryBundle["processSkills"], "listResourceLayers">;
}

export type TurnStartPreflightResult = { ok: true } | { ok: false; code: string; message: string };

function previousProviderOptions(state: TurnStartRecordState): Record<string, string> {
	if (state.kind === "preparation_failed") return { ...state.providerOptions };
	return state.start?.kind === "llm" ? { ...state.start.providerOptions } : {};
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

function resolveRuntimeProfile(
	deps: TurnStartPreflightDeps,
	process: ProcessInstance,
): { ok: true; id: string } | { ok: false; message: string } {
	if (deps.config.workers.runner === "local") {
		return { ok: true, id: defaultWorkerRuntimeProfile(deps.config) ?? "local" };
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
	const nextProcess = { ...process, ...writes.processPatch };
	const availability = availabilitySnapshot ?? deps.modelStatusCache.snapshot();

	for (const write of writes.turnStartWrites) {
		if (write.kind !== "create" || write.input.turnType !== "llm") continue;
		const parkFailure = (
			failure: Omit<Extract<TurnStartRecordState, { kind: "preparation_failed" }>, "kind">,
		) => {
			write.input.state = { ...failure, kind: "preparation_failed" };
			writes.processPatch.lifecycleStatus = "error";
			// Reconcile obsolete workers without launching this failed start.
			writes.workerIntent = { kind: "reconcile" };
		};

		// Resolve the model and required settings without yielding. An edit while the
		// resource bundle is assembled belongs to the next start, not this snapshot.
		const evaluated = deps.processModelPolicy.evaluate({
			kind: "process_turn",
			process: nextProcess,
			turnId: write.input.turnId,
			initialSelection: true,
			startKind: write.input.startKind,
			availability,
		});
		if (!evaluated.ok) {
			const code =
				evaluated.code === "model_unavailable" ||
				evaluated.code === "model_stale" ||
				evaluated.code === "model_required"
					? evaluated.code
					: "invalid_model_configuration";
			parkFailure({
				requestedModelProfileId: evaluated.selection?.modelProfileId ?? null,
				providerOptions: previousProviderOptions(write.input.state),
				code,
				safeSummary: presentProcessModelPolicyFailure(evaluated),
				...(evaluated.selection
					? { modelSelectionProvenance: evaluated.selection.provenance }
					: {}),
				availabilityRevision: availability.revision,
			});
			continue;
		}
		if (evaluated.selection) {
			const patch = {
				selectedTurnModelProfileId: evaluated.selection.modelProfileId,
				selectedTurnModelKind: evaluated.selection.provenance.kind,
				selectedTurnModelSource: evaluated.selection.provenance.source,
			};
			Object.assign(nextProcess, patch);
			Object.assign(writes.processPatch, patch);
		}
		const provenance =
			nextProcess.selectedTurnModelKind && nextProcess.selectedTurnModelSource
				? {
						kind: nextProcess.selectedTurnModelKind,
						source: nextProcess.selectedTurnModelSource,
					}
				: undefined;
		const requestedProfileId = nextProcess.selectedTurnModelProfileId?.trim() || null;
		let scopedSettings: ReturnType<ScopedSettingsService["capture"]>;
		try {
			scopedSettings = deps.scopedSettings?.capture(
				nextProcess,
				write.input.turnId,
				provenance?.source === "scoped_purpose_default",
			);
		} catch (error) {
			parkFailure({
				requestedModelProfileId: requestedProfileId,
				providerOptions: {},
				code: "invalid_model_configuration",
				safeSummary:
					error instanceof Error
						? error.message
						: "Correct invalid scoped settings before retrying",
			});
			continue;
		}
		const retainedState = write.input.state;
		const retainedOptions = previousProviderOptions(retainedState);
		if (
			retainedState.kind === "preparation_failed" &&
			retainedState.code === "invalid_model_configuration"
		) {
			parkFailure(retainedState);
			continue;
		}
		if (!requestedProfileId) {
			parkFailure({
				requestedModelProfileId: null,
				providerOptions: retainedOptions,
				code: "model_required",
				safeSummary: "Choose a model before retrying startup",
				availabilityRevision: availability.revision,
			});
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
			parkFailure({
				requestedModelProfileId: profile.id,
				providerOptions: recoveryOptions,
				code: "provider_options_required",
				safeSummary: optionResult.issues.map((issue) => issue.message).join("; "),
			});
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
					...(scopedSettings ? { scopedSettings } : {}),
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
			parkFailure({
				requestedModelProfileId: profile.id,
				providerOptions: { ...optionResult.value },
				code: "provider_preflight_failed",
				safeSummary: "The provider could not prepare this worker start",
			});
		}
	}
	return { ok: true };
}
