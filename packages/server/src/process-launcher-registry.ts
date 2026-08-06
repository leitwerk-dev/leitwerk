import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExtensionProcessDefinition,
	LauncherContext,
	LauncherModelProfileSummary,
	ProcessLaunchConfig,
	ProcessLauncherDefinition,
	ProcessLauncherService,
	ResolvedProcessLauncher,
	UiLauncherDefinition,
	UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";
import { buildProcessLaunchers } from "@leitwerk-dev/process-sdk";
import type { CommitMessageConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan } from "./process-launch-plan.js";

interface RegisteredProcessLauncher {
	processId: string;
	displayName: string;
	processDef: ExtensionProcessDefinition;
	definition: ProcessLauncherDefinition;
}

interface ProcessLauncherRegistryOptions {
	modelProfiles?: readonly LauncherModelProfileSummary[];
	getModelProfilesForProcess?: (processId: string) => readonly LauncherModelProfileSummary[];
	commitMessages?: CommitMessageConfig;
}

function buildLaunchPlan(
	launcher: RegisteredProcessLauncher,
	launchConfig: ProcessLaunchConfig,
	commitMessages?: CommitMessageConfig,
) {
	return buildProcessLaunchPlan({
		processDef: launcher.processDef,
		launchConfig,
		launcherId: launcher.definition.id,
		metadataAdditions: {
			launcherId: launcher.definition.id,
		},
		errorSubject: `Launcher '${launcher.definition.id}'`,
		commitMessages,
	});
}

function buildResolvedProcessLauncher(
	launcher: RegisteredProcessLauncher,
	launchConfig: ProcessLaunchConfig,
	commitMessages?: CommitMessageConfig,
): ResolvedProcessLauncher {
	return {
		launcherId: launcher.definition.id,
		processId: launcher.processId,
		displayName: launcher.displayName,
		launchConfig,
		launchPlan: buildLaunchPlan(launcher, launchConfig, commitMessages),
	};
}

function getRequiredUiDefinition(
	launcher: RegisteredProcessLauncher | undefined,
	launcherId: string,
): UiLauncherDefinition {
	if (!launcher) {
		throw new Error(`Unknown launcher '${launcherId}'`);
	}
	if (!launcher.definition.ui) {
		throw new Error(`Launcher '${launcherId}' is not UI-visible`);
	}
	return launcher.definition.ui;
}

export function buildProcessLauncherRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
	options: ProcessLauncherRegistryOptions = {},
): ProcessLauncherService {
	const launchers = new Map<string, RegisteredProcessLauncher>();

	for (const [processId, processDef] of catalog.processes) {
		const built = buildProcessLaunchers(processDef);
		for (const [launcherId, definition] of built?.launchers ?? new Map()) {
			if (launchers.has(launcherId)) {
				throw new Error(`Launcher '${launcherId}' is already registered`);
			}
			launchers.set(launcherId, {
				processId,
				displayName: processDef.displayName,
				processDef,
				definition,
			});
		}
	}

	const getDefaultModelProfilesForProcess = (
		processId: string,
	): readonly LauncherModelProfileSummary[] =>
		options.getModelProfilesForProcess?.(processId) ?? options.modelProfiles ?? [];

	const createLauncherContext = (
		processId: string,
		ctx: LauncherContext = {},
	): LauncherContext => ({
		...ctx,
		modelProfiles: ctx.modelProfiles ?? getDefaultModelProfilesForProcess(processId),
	});

	const uiLaunchers = [...launchers.values()]
		.filter((launcher) => launcher.definition.ui)
		.map(
			(launcher): UiLauncherSummary => ({
				id: launcher.definition.id,
				processId: launcher.processId,
				displayName: launcher.displayName,
				label: launcher.definition.label,
				description: launcher.definition.description,
				card: launcher.definition.ui?.card ?? {},
				launchConfigSchema: launcher.definition.ui?.launchConfigSchema ?? {
					id: launcher.definition.id,
					title: launcher.definition.label,
					fields: [],
				},
			}),
		)
		.sort((a, b) => a.label.localeCompare(b.label));

	return {
		listUiLaunchers() {
			return uiLaunchers;
		},

		async resolveUiDefaults(launcherId, ctx = {}) {
			const launcher = launchers.get(launcherId);
			const ui = getRequiredUiDefinition(launcher, launcherId);
			return (
				(await ui.resolveDefaults?.(
					createLauncherContext((launcher as RegisteredProcessLauncher).processId, ctx),
				)) ?? {}
			);
		},

		async resolveUiOptions(launcherId, input, ctx = {}) {
			const launcher = launchers.get(launcherId);
			const ui = getRequiredUiDefinition(launcher, launcherId);
			return (
				(await ui.resolveOptions?.(
					input,
					createLauncherContext((launcher as RegisteredProcessLauncher).processId, ctx),
				)) ?? {}
			);
		},

		async resolveUiRelaunchInput(launcherId, previousInput, ctx = {}) {
			const launcher = launchers.get(launcherId);
			const ui = getRequiredUiDefinition(launcher, launcherId);
			const input = await ui.resolveRelaunchInput?.(
				{ ...previousInput },
				createLauncherContext((launcher as RegisteredProcessLauncher).processId, ctx),
			);
			return input ? { ...input } : { ...previousInput };
		},

		async resolveUiLauncher(launcherId, input, ctx = {}) {
			const launcher = launchers.get(launcherId);
			const ui = getRequiredUiDefinition(launcher, launcherId);
			const resolved = await ui.resolveLaunchConfig(
				input,
				createLauncherContext((launcher as RegisteredProcessLauncher).processId, ctx),
			);
			if (!resolved.ok) {
				return resolved;
			}
			return {
				ok: true as const,
				launcher: buildResolvedProcessLauncher(
					launcher as RegisteredProcessLauncher,
					resolved.launchConfig,
					options.commitMessages,
				),
			};
		},
	};
}
