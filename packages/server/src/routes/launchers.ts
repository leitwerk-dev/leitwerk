import type { LaunchModelConfigInput } from "@leitwerk-dev/domain";
import type {
	LauncherDefaultsResponseBody,
	LauncherModelConfigPreviewResponseBody,
	LauncherOptionsResponseBody,
	LauncherRecentValuesResponseBody,
	LaunchersResponseBody,
	UiLauncherSummary,
} from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import type { FutureExecutionLifecycle } from "../future-execution/index.js";
import { buildLauncherModelConfigPreviewForLauncher } from "../launcher-model-config-service.js";
import { buildProcessFlowViewForProcess } from "../process-graph.js";
import { presentLaunchPlanPreparationIssues } from "../process-model-policy-presenter.js";
import {
	buildLauncherModelConfigSchema,
	normalizeLauncherRequest,
	type RouteDeps,
	resolveActor,
	sendLauncherLookupFailure,
	sendLauncherMutationResponse,
	sendLauncherRequestNormalizationError,
} from "./process-route-helpers.js";

export function registerLauncherRoutes(
	app: FastifyInstance,
	deps: RouteDeps,
	futureExecutionLifecycle: FutureExecutionLifecycle,
) {
	app.get("/api/launchers", async () => {
		const launchers: UiLauncherSummary[] = deps.launcherService
			.listUiLaunchers()
			.map((launcher) => ({
				...launcher,
				modelConfigSchema: buildLauncherModelConfigSchema(deps, launcher.processId),
				processFlow: buildProcessFlowViewForProcess(deps.processGraphs, launcher.processId),
				skills: deps.skills.listAvailable(),
			}));
		const body = { launchers } satisfies LaunchersResponseBody;
		return body;
	});

	app.get<{ Params: { launcherId: string } }>(
		"/api/launchers/:launcherId/defaults",
		async (req, reply) => {
			try {
				const defaults = await deps.launcherService.resolveUiDefaults(req.params.launcherId);
				const launcher = deps.launcherService
					.listUiLaunchers()
					.find((candidate) => candidate.id === req.params.launcherId);
				let title: string | null = null;
				let modelConfig: LaunchModelConfigInput = launcher
					? { defaultModelProfileId: null, turnConfigs: {} }
					: {};
				const warnings: Array<{ code: string; message: string; fieldId?: string }> = [];
				if (launcher) {
					const resolved = await deps.launcherService.resolveUiLauncher(
						req.params.launcherId,
						defaults,
					);
					if (resolved.ok) {
						title = resolved.launcher.launchPlan.processInput.title ?? null;
						const preparedLaunchPlan = await deps.launchPlans.prepare(
							resolved.launcher.launchPlan,
							{ invalidModelConfig: "omit" },
						);
						if (!preparedLaunchPlan.ok) {
							warnings.push(...presentLaunchPlanPreparationIssues(preparedLaunchPlan.errors));
							modelConfig = {};
						} else {
							warnings.push(...presentLaunchPlanPreparationIssues(preparedLaunchPlan.warnings));
							modelConfig = preparedLaunchPlan.modelConfig;
						}
					}
				}
				const body = {
					defaults,
					title,
					modelConfig,
					...(warnings.length > 0 ? { warnings } : {}),
				} satisfies LauncherDefaultsResponseBody;
				return body;
			} catch (error) {
				if (sendLauncherLookupFailure(reply, error)) {
					return;
				}
				throw error;
			}
		},
	);

	app.get<{ Params: { launcherId: string } }>(
		"/api/launchers/:launcherId/recent-values",
		async (req, reply) => {
			const launcher = deps.launcherService
				.listUiLaunchers()
				.find((candidate) => candidate.id === req.params.launcherId);
			if (!launcher) {
				return reply.code(404).send({ error: "Launcher not found" });
			}
			const body = {
				values: deps.launcherRecentValues.list(req.params.launcherId),
			} satisfies LauncherRecentValuesResponseBody;
			return body;
		},
	);

	app.post<{ Params: { launcherId: string }; Body: unknown }>(
		"/api/launchers/:launcherId/model-config-preview",
		async (req, reply) => {
			const normalized = normalizeLauncherRequest(req.body);
			if (!normalized.ok) {
				return sendLauncherRequestNormalizationError(reply, normalized.error);
			}

			let previewResult: Awaited<ReturnType<typeof buildLauncherModelConfigPreviewForLauncher>>;
			try {
				previewResult = await buildLauncherModelConfigPreviewForLauncher({
					launcherService: deps.launcherService,
					launchPlans: deps.launchPlans,
					launcherId: req.params.launcherId,
					launcherInput: normalized.request.launcherInput,
					modelConfig: normalized.request.modelConfig,
					replaceModelConfig: normalized.request.modelConfigProvided,
					processModelPolicy: deps.processModelPolicy,
					modelStatusCache: deps.modelStatusCache,
				});
			} catch (error) {
				if (sendLauncherLookupFailure(reply, error)) return;
				throw error;
			}
			if (!previewResult) return reply.code(404).send({ error: "Launcher not found" });
			if (!previewResult.ok) {
				return reply
					.code(400)
					.send({ errors: presentLaunchPlanPreparationIssues(previewResult.errors) });
			}
			const body = {
				preview: previewResult.preview,
			} satisfies LauncherModelConfigPreviewResponseBody;
			return body;
		},
	);

	app.post<{ Params: { launcherId: string }; Body: unknown }>(
		"/api/launchers/:launcherId/options",
		async (req, reply) => {
			const normalized = normalizeLauncherRequest(req.body);
			if (!normalized.ok) {
				return sendLauncherRequestNormalizationError(reply, normalized.error);
			}
			try {
				const options = await deps.launcherService.resolveUiOptions(
					req.params.launcherId,
					normalized.request.launcherInput,
				);
				const body = { options } satisfies LauncherOptionsResponseBody;
				return body;
			} catch (error) {
				if (sendLauncherLookupFailure(reply, error)) {
					return;
				}
				throw error;
			}
		},
	);

	app.post<{ Params: { launcherId: string }; Body: unknown }>(
		"/api/launchers/:launcherId/launch",
		async (req, reply) => {
			const normalized = normalizeLauncherRequest(req.body);
			if (!normalized.ok) {
				return sendLauncherRequestNormalizationError(reply, normalized.error);
			}

			try {
				const result = await futureExecutionLifecycle.scheduleLaunch(
					req.params.launcherId,
					normalized.request,
					{ actor: resolveActor(req) },
				);
				return sendLauncherMutationResponse(reply, deps, result);
			} catch (error) {
				if (sendLauncherLookupFailure(reply, error)) {
					return;
				}
				throw error;
			}
		},
	);
}
