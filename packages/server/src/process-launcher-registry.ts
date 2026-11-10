import { randomUUID } from "node:crypto";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExtensionProcessDefinition,
	LauncherContext,
	LauncherModelProfileSummary,
	LauncherReadiness,
	ProcessLaunchConfig,
	ProcessLauncherDefinition,
	ProcessLauncherService,
	ResolvedProcessLauncher,
	UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";
import { buildProcessLaunchers, SafeLaunchPreparationError } from "@leitwerk-dev/process-sdk";
import type { CommitMessageConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan, validateLaunchPreparationChecks } from "./process-launch-plan.js";

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
	logger?: { warn(message: string): void };
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
		launchPlan: buildProcessLaunchPlan({
			processDef: launcher.processDef,
			launchConfig,
			launcherId: launcher.definition.id,
			metadataAdditions: { launcherId: launcher.definition.id },
			errorSubject: `Launcher '${launcher.definition.id}'`,
			commitMessages,
		}),
	};
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

	function requireUiLauncher(launcherId: string) {
		const launcher = launchers.get(launcherId);
		if (!launcher) throw new Error(`Unknown launcher '${launcherId}'`);
		const ui = launcher.definition.ui;
		if (!ui) throw new Error(`Launcher '${launcherId}' is not UI-visible`);
		return { launcher, ui };
	}

	const createLauncherContext = (
		processId: string,
		ctx: LauncherContext = {},
	): LauncherContext => ({
		...ctx,
		modelProfiles:
			ctx.modelProfiles ??
			options.getModelProfilesForProcess?.(processId) ??
			options.modelProfiles ??
			[],
	});

	async function resolveUiLauncher(
		launcherId: string,
		input: Record<string, unknown>,
		ctx: LauncherContext,
		preview: boolean,
	) {
		const { launcher, ui } = requireUiLauncher(launcherId);
		const resolve = preview
			? (ui.resolvePreviewConfig ?? ui.resolveLaunchConfig)
			: ui.resolveLaunchConfig;
		const resolved = await resolve.call(ui, input, createLauncherContext(launcher.processId, ctx));
		if (!resolved.ok) return resolved;
		const result = buildResolvedProcessLauncher(
			launcher,
			resolved.launchConfig,
			options.commitMessages,
		);
		if (preview) result.launchPlan.preview = true;
		return {
			ok: true as const,
			launcher: result,
		};
	}

	function resolveUiReadiness(
		launcherId: string,
		input: Record<string, unknown>,
	): LauncherReadiness {
		const { ui } = requireUiLauncher(launcherId);
		try {
			return ui.readiness?.(input) ?? { status: "ready", issues: [] };
		} catch {
			const correlationId = randomUUID();
			// Do not log exception messages: integration errors may contain credentials.
			options.logger?.warn(`Launcher readiness failed; correlationId=${correlationId}`);
			return {
				status: "blocked",
				issues: [
					{
						code: "launcher_readiness_failed",
						summary: "Configuration readiness could not be checked.",
						remediation: `Ask an operator to inspect the server logs. Reference: ${correlationId}`,
					},
				],
			};
		}
	}

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
			return uiLaunchers.map((launcher) => ({
				...launcher,
				...(requireUiLauncher(launcher.id).ui.readiness
					? { readiness: resolveUiReadiness(launcher.id, {}) }
					: {}),
			}));
		},

		resolveUiReadiness,

		async resolveUiDefaults(launcherId, ctx = {}) {
			const { launcher, ui } = requireUiLauncher(launcherId);
			return (await ui.resolveDefaults?.(createLauncherContext(launcher.processId, ctx))) ?? {};
		},

		async resolveUiOptions(launcherId, input, ctx = {}) {
			const { launcher, ui } = requireUiLauncher(launcherId);
			return (
				(await ui.resolveOptions?.(input, createLauncherContext(launcher.processId, ctx))) ?? {}
			);
		},

		async resolveUiRelaunchInput(launcherId, previousInput, ctx = {}) {
			const { launcher, ui } = requireUiLauncher(launcherId);
			const input = await ui.resolveRelaunchInput?.(
				{ ...previousInput },
				createLauncherContext(launcher.processId, ctx),
			);
			return input ? { ...input } : { ...previousInput };
		},

		resolvePreparationChecks(launcherId, input, launchConfig) {
			const { ui } = requireUiLauncher(launcherId);
			const checks = [...(ui.preparationChecks?.(input, launchConfig) ?? [])];
			if (ui.readiness) {
				checks.unshift({
					id: "launcher-readiness",
					label: "Check launcher configuration",
					async run() {
						const readiness = resolveUiReadiness(launcherId, input);
						if (readiness.status !== "ready") {
							const summary = readiness.issues
								.map((issue) => `${issue.summary} ${issue.remediation}`)
								.join(" ");
							throw new SafeLaunchPreparationError(
								"Launcher configuration is incomplete",
								summary || "Complete launcher configuration before launching.",
							);
						}
					},
				});
			}
			return validateLaunchPreparationChecks(checks, `Launcher '${launcherId}'`);
		},

		async resolveUiLauncher(launcherId, input, ctx = {}) {
			return resolveUiLauncher(launcherId, input, ctx, false);
		},
		async resolveUiLauncherPreview(launcherId, input, ctx = {}) {
			return resolveUiLauncher(launcherId, input, ctx, true);
		},
	};
}
