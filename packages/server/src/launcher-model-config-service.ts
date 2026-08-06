import {
	findUiLauncherById,
	type LauncherModelConfigServiceLike,
	type LaunchModelConfigInputLike,
	type LaunchPlanPreparationIssue,
	type ProcessLauncherService,
	type ProcessLaunchPlanServiceLike,
} from "@leitwerk-dev/process-sdk";
import type { ModelStatusCache } from "./model-providers/model-status-cache.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";
import {
	presentLauncherModelConfigPreview,
	presentLauncherModelConfigSchema,
} from "./process-model-policy-presenter.js";

type LauncherModelConfigDeps = {
	launcherService: ProcessLauncherService;
	launchPlans: ProcessLaunchPlanServiceLike;
	/** Server construction always supplies the authoritative model policy and availability view. */
	processModelPolicy: ServerProcessModelPolicy;
	modelStatusCache: Pick<ModelStatusCache, "snapshot">;
};

export function buildLauncherModelConfigSchemaForLauncher(
	input: LauncherModelConfigDeps & { launcherId: string },
) {
	const launcher = findUiLauncherById(input.launcherService, input.launcherId);
	if (!launcher) return null;
	return presentLauncherModelConfigSchema(
		input.processModelPolicy.project({
			kind: "launcher_schema",
			processId: launcher.processId,
			availability: input.modelStatusCache.snapshot(),
		}),
	);
}

function projectLauncherPreview(
	input: LauncherModelConfigDeps,
	processId: string,
	modelConfig: LaunchModelConfigInputLike,
) {
	return presentLauncherModelConfigPreview(
		input.processModelPolicy.project({
			kind: "launcher_preview",
			processId,
			modelConfig: modelConfig,
			availability: input.modelStatusCache.snapshot(),
		}),
	);
}

export type LauncherModelConfigPreviewResult =
	| {
			readonly ok: true;
			readonly launcher: NonNullable<ReturnType<typeof findUiLauncherById>>;
			readonly preview: ReturnType<typeof projectLauncherPreview>;
	  }
	| {
			readonly ok: false;
			readonly launcher: NonNullable<ReturnType<typeof findUiLauncherById>>;
			readonly errors: readonly LaunchPlanPreparationIssue[];
	  };

export async function buildLauncherModelConfigPreviewForLauncher(
	input: LauncherModelConfigDeps & {
		launcherId: string;
		launcherInput: Record<string, unknown>;
		modelConfig: LaunchModelConfigInputLike;
		replaceModelConfig?: boolean;
		ignoreResolveErrors?: boolean;
	},
): Promise<LauncherModelConfigPreviewResult | null> {
	const launcher = findUiLauncherById(input.launcherService, input.launcherId);
	if (!launcher) return null;
	let modelConfig = input.modelConfig;
	let resolved: Awaited<ReturnType<ProcessLauncherService["resolveUiLauncher"]>> | null = null;
	try {
		resolved = await input.launcherService.resolveUiLauncher(input.launcherId, input.launcherInput);
	} catch (error) {
		if (!input.ignoreResolveErrors) throw error;
	}
	if (resolved?.ok) {
		const prepared = await input.launchPlans.prepare(resolved.launcher.launchPlan, {
			modelConfig: input.modelConfig,
			replaceModelConfig: input.replaceModelConfig,
			invalidModelConfig: "reject",
		});
		if (!prepared.ok) {
			if (!input.ignoreResolveErrors) {
				return { ok: false, launcher, errors: prepared.errors };
			}
		} else {
			modelConfig = prepared.modelConfig;
		}
	}
	return {
		ok: true,
		launcher,
		preview: projectLauncherPreview(input, launcher.processId, modelConfig),
	};
}

export function createLauncherModelConfigService(
	input: LauncherModelConfigDeps,
): LauncherModelConfigServiceLike {
	return {
		async getSchema(launcherId) {
			return buildLauncherModelConfigSchemaForLauncher({ ...input, launcherId });
		},
		async preview(launcherId, launcherInput, opts = {}) {
			const result = await buildLauncherModelConfigPreviewForLauncher({
				...input,
				launcherId,
				launcherInput,
				modelConfig: opts.modelConfig ?? {},
				replaceModelConfig: opts.modelConfig !== undefined,
				ignoreResolveErrors: true,
			});
			return result?.ok ? result.preview : null;
		},
	};
}
