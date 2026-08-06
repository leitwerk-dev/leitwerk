import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExtensionProcessDefinition,
	LauncherContext,
	LauncherModelProfileSummary,
	LaunchModelConfigInputLike,
	ProcessLaunchConfig,
	ProcessLaunchPlan,
	ProcessWatcherDefinition,
} from "@leitwerk-dev/process-sdk";
import { buildProcessWatchers } from "@leitwerk-dev/process-sdk";
import type { ProcessWatcherType } from "@leitwerk-dev/protocol";
import type {
	ProcessWatcherConfigSnapshot,
	WatcherLaunchConfigSnapshot,
} from "@leitwerk-dev/protocol/config-snapshot";
import type { LeitwerkConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan } from "./process-launch-plan.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";

export interface RegisteredProcessWatcherLike {
	processId: string;
	processDisplayName: string;
	watcherId: string;
	watcherLabel: string;
	watcherDescription: string;
	type: ProcessWatcherType;
	enabled: boolean;
	pollInterval: string;
	configPath: string;
	config: ProcessWatcherConfigSnapshot;
	launchModelConfig: LaunchModelConfigInputLike;
}

export interface ResolvedProcessWatcherStartLike {
	watcher: RegisteredProcessWatcherLike;
	launchPlan: ProcessLaunchPlan;
}

export interface ProcessWatcherServiceLike {
	listAll(): readonly RegisteredProcessWatcherLike[];
	listByType(type: ProcessWatcherType): readonly RegisteredProcessWatcherLike[];
	resolveLaunch(
		processId: string,
		watcherId: string,
		payload: unknown,
		ctx?: LauncherContext,
	): Promise<ResolvedProcessWatcherStartLike | null>;
}

interface RegisteredProcessWatcher {
	processId: string;
	processDisplayName: string;
	processDef: ExtensionProcessDefinition;
	definition: ProcessWatcherDefinition;
	config: ProcessWatcherConfigSnapshot;
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
			processWatcherType: watcher.definition.type,
			processWatcherConfigPath: watcher.configPath,
		},
		errorSubject: `Process watcher '${watcher.definition.id}'`,
		commitMessages,
	});
}

function buildWatcherLaunchModelConfig(
	launch: WatcherLaunchConfigSnapshot | undefined,
): LaunchModelConfigInputLike {
	const turnConfigs = Object.fromEntries(
		Object.entries(launch?.turn_configs ?? {}).map(([turnId, turnConfig]) => [
			turnId,
			{ modelProfileId: turnConfig.model_profile ?? null },
		]),
	);
	return {
		defaultModelProfileId: launch?.default_model_profile ?? null,
		turnConfigs,
	};
}

function buildRegistrationView(watcher: RegisteredProcessWatcher): RegisteredProcessWatcherLike {
	return {
		processId: watcher.processId,
		processDisplayName: watcher.processDisplayName,
		watcherId: watcher.definition.id,
		watcherLabel: watcher.definition.label,
		watcherDescription: watcher.definition.description,
		type: watcher.definition.type,
		enabled: watcher.config.enabled,
		pollInterval: watcher.config.poll_interval,
		configPath: watcher.configPath,
		config: structuredClone(watcher.config),
		launchModelConfig: structuredClone(watcher.launchModelConfig),
	};
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
	// Watcher launch profiles are inherited server defaults. Unknown or newly
	// disallowed profiles are skipped when the launch plan is prepared; only
	// structural turn mistakes make watcher configuration invalid at startup.
	for (const turnId of Object.keys(modelConfig.turnConfigs ?? {})) {
		if (!llmTurnIds.has(turnId)) {
			errors.push(`turn '${turnId}': is not a known LLM turn for process '${processId}'`);
		}
	}
	return errors;
}

export function validateConfiguredProcessWatchersAgainstCatalog(input: {
	config: LeitwerkConfig;
	catalog: Pick<ExtensionCatalog, "processes">;
	processModelPolicy?: ServerProcessModelPolicy;
}): string[] {
	const errors: string[] = [];
	for (const [processId, processConfig] of Object.entries(input.config.process_configs ?? {})) {
		if (!input.catalog.processes.has(processId)) {
			continue;
		}
		const processDef = input.catalog.processes.get(processId);
		if (!processDef) {
			continue;
		}
		const built = collectProcessWatchers(processDef);
		const configuredWatchers =
			(processConfig as { watchers?: Record<string, ProcessWatcherConfigSnapshot> }).watchers ?? {};
		for (const [watcherId, watcherConfig] of Object.entries(configuredWatchers)) {
			const watcherDef = built.get(watcherId);
			if (!watcherDef) {
				errors.push(
					`Unknown watcher '${watcherId}' at process_configs.${processId}.watchers.${watcherId}`,
				);
				continue;
			}
			if (watcherDef.type !== watcherConfig.type) {
				errors.push(
					`Watcher '${watcherId}' at process_configs.${processId}.watchers.${watcherId} configured type '${watcherConfig.type}' does not match declared watcher type '${watcherDef.type}'`,
				);
			}
			if (input.processModelPolicy) {
				errors.push(
					...validateWatcherLaunchModelConfig(
						processId,
						buildWatcherLaunchModelConfig(watcherConfig.launch),
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
		const processWatchers =
			(
				config.process_configs?.[processId] as
					| { watchers?: Record<string, ProcessWatcherConfigSnapshot> }
					| undefined
			)?.watchers ?? {};
		for (const [watcherId, watcherConfig] of Object.entries(processWatchers)) {
			const watcherDef = built.get(watcherId);
			if (!watcherDef || watcherDef.type !== watcherConfig.type) {
				continue;
			}
			watchers.set(watcherKey(processId, watcherId), {
				processId,
				processDisplayName: processDef.displayName,
				processDef,
				definition: watcherDef,
				config: watcherConfig,
				configPath: `process_configs.${processId}.watchers.${watcherId}`,
				launchModelConfig: buildWatcherLaunchModelConfig(watcherConfig.launch),
			});
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
		if (processCompare !== 0) {
			return processCompare;
		}
		return a.definition.label.localeCompare(b.definition.label);
	});

	return {
		listAll() {
			return sortedWatchers.map(buildRegistrationView);
		},
		listByType(type: ProcessWatcherType) {
			return sortedWatchers
				.filter((watcher) => watcher.definition.type === type)
				.map(buildRegistrationView);
		},
		async resolveLaunch(
			processId: string,
			watcherId: string,
			payload: unknown,
			ctx: LauncherContext = {},
		) {
			const watcher = watchers.get(watcherKey(processId, watcherId));
			if (!watcher) {
				return null;
			}
			const watcherContext = createWatcherContext(processId, ctx);
			if (watcher.definition.matches) {
				const matches = await watcher.definition.matches(payload, watcherContext);
				if (!matches) {
					return null;
				}
			}
			const launchConfig = await watcher.definition.resolveLaunchConfig(payload, watcherContext);
			return {
				watcher: buildRegistrationView(watcher),
				launchPlan: buildLaunchPlan(watcher, launchConfig, config.commit_messages),
			};
		},
	};
}
