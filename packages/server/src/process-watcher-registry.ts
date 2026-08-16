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
} from "@leitwerk-dev/process-sdk";
import { buildProcessWatchers } from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan } from "./process-launch-plan.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";

export type { ProcessWatcherServiceLike, RegisteredProcessWatcherLike };

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
	launchSkillIds: readonly string[];
}

interface ProcessWatcherRegistryOptions {
	modelProfiles?: readonly LauncherModelProfileSummary[];
	getModelProfilesForProcess?: (processId: string) => readonly LauncherModelProfileSummary[];
	processModelPolicy?: ServerProcessModelPolicy;
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
		launchConfig: { ...launchConfig, skillIds: watcher.launchSkillIds },
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
		const parsedLaunch = parsed.launchModelConfig ?? {
			defaultModelProfileId: null,
			turnConfigs: {},
		};
		const launchModelConfig = {
			defaultModelProfileId: parsedLaunch.defaultModelProfileId ?? null,
			turnConfigs: parsedLaunch.turnConfigs ?? {},
		};
		return {
			processId: input.processId,
			processDisplayName: input.processDisplayName,
			processDef: input.processDef,
			definition: input.definition,
			config: parsed.config,
			enabled: parsed.enabled,
			presentation,
			configPath: input.configPath,
			launchModelConfig,
			launchSkillIds:
				"skillIds" in parsedLaunch && Array.isArray(parsedLaunch.skillIds)
					? parsedLaunch.skillIds
					: [],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${input.configPath}: ${message}`, { cause: error });
	}
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

function collectConfiguredProcessWatchers(input: {
	config: LeitwerkConfig;
	catalog: Pick<ExtensionCatalog, "processes">;
	processModelPolicy?: ServerProcessModelPolicy;
}): { watchers: RegisteredProcessWatcher[]; errors: string[] } {
	const watchers: RegisteredProcessWatcher[] = [];
	const errors: string[] = [];
	for (const [processId, processConfig] of Object.entries(input.config.process_configs ?? {})) {
		const processDef = input.catalog.processes.get(processId);
		if (!processDef) continue;
		const definitions = collectProcessWatchers(processDef);
		for (const [watcherId, rawConfig] of Object.entries(processConfig.watchers ?? {})) {
			const configPath = `process_configs.${processId}.watchers.${watcherId}`;
			const definition = definitions.get(watcherId);
			if (!definition) {
				errors.push(`Unknown watcher '${watcherId}' at ${configPath}`);
				continue;
			}
			try {
				const watcher = parseConfiguredWatcher({
					processId,
					processDisplayName: processDef.displayName,
					processDef,
					definition,
					rawConfig,
					configPath,
				});
				watchers.push(watcher);
				if (input.processModelPolicy) {
					errors.push(
						...validateWatcherLaunchModelConfig(
							processId,
							watcher.launchModelConfig,
							input.processModelPolicy,
						),
					);
				}
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	return { watchers, errors };
}

export function buildProcessWatcherRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
	config: LeitwerkConfig,
	options: ProcessWatcherRegistryOptions = {},
): ProcessWatcherServiceLike {
	const { watchers, errors } = collectConfiguredProcessWatchers({
		catalog,
		config,
		processModelPolicy: options.processModelPolicy,
	});
	if (errors.length > 0) {
		throw new Error(`Invalid process watcher config:\n${errors.join("\n")}`);
	}

	const getDefaultModelProfilesForProcess = (
		processId: string,
	): readonly LauncherModelProfileSummary[] =>
		options.getModelProfilesForProcess?.(processId) ?? options.modelProfiles ?? [];
	const createWatcherContext = (processId: string, ctx: LauncherContext = {}): LauncherContext => ({
		...ctx,
		modelProfiles: ctx.modelProfiles ?? getDefaultModelProfilesForProcess(processId),
	});

	const registrations = watchers
		.sort((a, b) => {
			const processCompare = a.processDisplayName.localeCompare(b.processDisplayName);
			return processCompare !== 0
				? processCompare
				: a.definition.label.localeCompare(b.definition.label);
		})
		.map((watcher) => ({
			source: watcher.definition.source,
			view: {
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
					if (
						watcher.definition.matches &&
						!(await watcher.definition.matches(event, watcherContext))
					) {
						return null;
					}
					const launchConfig = await watcher.definition.resolveLaunchConfig(event, watcherContext);
					return buildLaunchPlan(watcher, launchConfig, config.commit_messages);
				},
			} satisfies RegisteredProcessWatcherLike,
		}));

	return {
		listAll: () => registrations.map(({ view }) => view),
		listBySource: <TConfig, TEvent>(source: ProcessWatcherSource<TConfig, TEvent>) =>
			registrations
				.filter((watcher) => watcher.source === source)
				.map(({ view }) => view) as RegisteredProcessWatcherLike<TConfig, TEvent>[],
	};
}
