import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExtensionProcessDefinition,
	LauncherContext,
	LauncherModelProfileSummary,
	LaunchModelConfigInputLike,
	ProcessLaunchConfig,
	ProcessLaunchPlan,
	ProcessWatcherDefinition,
	ProcessWatcherPresentation,
	ProcessWatcherServiceLike,
	ProcessWatcherSource,
	RegisteredProcessWatcherLike,
	ResolvedProcessWatcherStartLike,
} from "@leitwerk-dev/process-sdk";
import { buildProcessWatchers } from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan } from "./process-launch-plan.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";

export type {
	ProcessWatcherServiceLike,
	RegisteredProcessWatcherLike,
	ResolvedProcessWatcherStartLike,
};

interface RegisteredProcessWatcher {
	processId: string;
	processDisplayName: string;
	processDef: ExtensionProcessDefinition;
	definition: ProcessWatcherDefinition;
	config: unknown;
	enabled: boolean;
	presentation: ProcessWatcherPresentation;
	configPath: string;
	launchModelConfig: LaunchModelConfigInputLike;
}

interface ProcessWatcherRegistryOptions {
	modelProfiles?: readonly LauncherModelProfileSummary[];
	getModelProfilesForProcess?: (processId: string) => readonly LauncherModelProfileSummary[];
}

function collectProcessWatchers(
	processDef: ExtensionProcessDefinition,
): ReadonlyMap<string, ProcessWatcherDefinition> {
	return buildProcessWatchers(processDef)?.watchers ?? new Map();
}

function buildLaunchPlan(
	watcher: RegisteredProcessWatcher,
	launchConfig: ProcessLaunchConfig,
	commitMessages?: LeitwerkConfig["commit_messages"],
): ProcessLaunchPlan {
	return buildProcessLaunchPlan({
		processDef: watcher.processDef,
		launchConfig,
		launcherId: `${watcher.processId}.${watcher.definition.id}`,
		metadataAdditions: {
			processWatcherId: watcher.definition.id,
			processWatcherSourceId: watcher.definition.source.id,
			processWatcherConfigPath: watcher.configPath,
		},
		errorSubject: `Process watcher '${watcher.definition.id}'`,
		commitMessages,
	});
}

function parseConfiguredWatcher(input: {
	processId: string;
	processDisplayName: string;
	processDef: ExtensionProcessDefinition;
	definition: ProcessWatcherDefinition;
	rawConfig: unknown;
	configPath: string;
}): RegisteredProcessWatcher {
	try {
		const parsed = input.definition.source.parseConfig(input.rawConfig);
		if (typeof parsed.enabled !== "boolean") {
			throw new Error("parseConfig() must return a boolean enabled value");
		}
		const presentation = input.definition.source.presentConfig(parsed.config);
		if (presentation.targetSummary.trim() === "") {
			throw new Error("presentConfig() must return a non-empty targetSummary");
		}
		return {
			processId: input.processId,
			processDisplayName: input.processDisplayName,
			processDef: input.processDef,
			definition: input.definition,
			config: parsed.config,
			enabled: parsed.enabled,
			presentation,
			configPath: input.configPath,
			launchModelConfig: parsed.launchModelConfig ?? {
				defaultModelProfileId: null,
				turnConfigs: {},
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${input.configPath}: ${message}`, { cause: error });
	}
}

function watcherKey(processId: string, watcherId: string): string {
	return `${processId}:${watcherId}`;
}

function validateWatcherLaunchModelConfig(
	processId: string,
	modelConfig: LaunchModelConfigInputLike,
	policy: ServerProcessModelPolicy,
): string[] {
	const errors: string[] = [];
	const schema = policy.project({ kind: "launcher_schema", processId });
	const llmTurnIds = new Set(schema.turns.map((turn) => turn.turnId));
	for (const turnId of Object.keys(modelConfig.turnConfigs ?? {})) {
		if (!llmTurnIds.has(turnId)) {
			errors.push(`turn '${turnId}': is not a known LLM turn for process '${processId}'`);
		}
	}
	return errors;
}

function configuredWatcherEntries(config: LeitwerkConfig, processId: string) {
	return Object.entries(config.process_configs?.[processId]?.watchers ?? {});
}

export function validateConfiguredProcessWatchersAgainstCatalog(input: {
	config: LeitwerkConfig;
	catalog: Pick<ExtensionCatalog, "processes">;
	processModelPolicy?: ServerProcessModelPolicy;
}): string[] {
	const errors: string[] = [];
	for (const [processId, processConfig] of Object.entries(input.config.process_configs ?? {})) {
		const processDef = input.catalog.processes.get(processId);
		if (!processDef) continue;
		const built = collectProcessWatchers(processDef);
		for (const [watcherId, rawConfig] of Object.entries(processConfig.watchers ?? {})) {
			const configPath = `process_configs.${processId}.watchers.${watcherId}`;
			const watcherDef = built.get(watcherId);
			if (!watcherDef) {
				errors.push(`Unknown watcher '${watcherId}' at ${configPath}`);
				continue;
			}
			let watcher: RegisteredProcessWatcher;
			try {
				watcher = parseConfiguredWatcher({
					processId,
					processDisplayName: processDef.displayName,
					processDef,
					definition: watcherDef,
					rawConfig,
					configPath,
				});
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
				continue;
			}
			if (input.processModelPolicy) {
				errors.push(
					...validateWatcherLaunchModelConfig(
						processId,
						watcher.launchModelConfig,
						input.processModelPolicy,
					),
				);
			}
		}
	}
	return errors;
}

export function buildProcessWatcherRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
	config: LeitwerkConfig,
	options: ProcessWatcherRegistryOptions = {},
): ProcessWatcherServiceLike {
	const watchers = new Map<string, RegisteredProcessWatcher>();
	for (const [processId, processDef] of catalog.processes) {
		const built = collectProcessWatchers(processDef);
		for (const [watcherId, rawConfig] of configuredWatcherEntries(config, processId)) {
			const watcherDef = built.get(watcherId);
			if (!watcherDef) continue;
			watchers.set(
				watcherKey(processId, watcherId),
				parseConfiguredWatcher({
					processId,
					processDisplayName: processDef.displayName,
					processDef,
					definition: watcherDef,
					rawConfig,
					configPath: `process_configs.${processId}.watchers.${watcherId}`,
				}),
			);
		}
	}

	const getDefaultModelProfilesForProcess = (
		processId: string,
	): readonly LauncherModelProfileSummary[] =>
		options.getModelProfilesForProcess?.(processId) ?? options.modelProfiles ?? [];
	const createWatcherContext = (processId: string, ctx: LauncherContext = {}): LauncherContext => ({
		...ctx,
		modelProfiles: ctx.modelProfiles ?? getDefaultModelProfilesForProcess(processId),
	});

	const sortedWatchers = [...watchers.values()].sort((a, b) => {
		const processCompare = a.processDisplayName.localeCompare(b.processDisplayName);
		return processCompare !== 0
			? processCompare
			: a.definition.label.localeCompare(b.definition.label);
	});

	const buildRegistrationView = (
		watcher: RegisteredProcessWatcher,
	): RegisteredProcessWatcherLike => ({
		processId: watcher.processId,
		processDisplayName: watcher.processDisplayName,
		watcherId: watcher.definition.id,
		watcherLabel: watcher.definition.label,
		watcherDescription: watcher.definition.description,
		sourceId: watcher.definition.source.id,
		sourceLabel: watcher.definition.source.label,
		enabled: watcher.enabled,
		configPath: watcher.configPath,
		config: structuredClone(watcher.config),
		presentation: structuredClone(watcher.presentation),
		launchModelConfig: structuredClone(watcher.launchModelConfig),
		async resolveLaunch(event: unknown, ctx: LauncherContext = {}) {
			const watcherContext = createWatcherContext(watcher.processId, ctx);
			if (watcher.definition.matches) {
				const matches = await watcher.definition.matches(event, watcherContext);
				if (!matches) return null;
			}
			const launchConfig = await watcher.definition.resolveLaunchConfig(event, watcherContext);
			return {
				watcher: buildRegistrationView(watcher),
				launchPlan: buildLaunchPlan(watcher, launchConfig, config.commit_messages),
			};
		},
	});

	return {
		listAll() {
			return sortedWatchers.map(buildRegistrationView);
		},
		listBySource<TConfig, TEvent>(source: ProcessWatcherSource<TConfig, TEvent>) {
			return sortedWatchers
				.filter((watcher) => watcher.definition.source === source)
				.map(buildRegistrationView) as RegisteredProcessWatcherLike<TConfig, TEvent>[];
		},
	};
}
