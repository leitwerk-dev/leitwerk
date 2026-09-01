import type {
	ModelProviderOptionsResponseBody,
	ProcessActionModelPreviewResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FutureExecutionLifecycle } from "../future-execution/index.js";
import { loadProviderOptionChoices } from "../model-providers/provider-options.js";
import { sendEngineFailure } from "./process-engine-http.js";
import {
	getProcessOrReply,
	listVisibleActionsForProcess,
	normalizeActionRequest,
	normalizeContinueRequest,
	normalizeRecoveryModelRequest,
	type RouteDeps,
	resolveActor,
	routeConfig,
	sendActionRequestNormalizationError,
	sendScheduledActionMutationResponse,
} from "./process-route-helpers.js";

export function registerProcessActionRoutes(
	app: FastifyInstance,
	deps: RouteDeps,
	futureExecutionLifecycle: FutureExecutionLifecycle,
) {
	app.get<{
		Params: { instanceId: string; modelProfileId: string };
	}>(
		"/api/processes/:instanceId/model-profiles/:modelProfileId/provider-options",
		async (req, reply): Promise<ModelProviderOptionsResponseBody | undefined> => {
			const process = getProcessOrReply(deps, req.params.instanceId, reply);
			if (!process) return;
			if (!deps.modelProviderRegistry || !deps.modelProviderCredentialStatus) {
				return reply.code(503).send({ error: "Model provider catalog is unavailable" });
			}
			const config = routeConfig(deps);
			const profile = config.pi.model_profiles.find(
				(candidate) => candidate.id === req.params.modelProfileId,
			);
			const profiles = deps.processModelPolicy.project({
				kind: "profile_options",
				processId: process.processId,
				availability: deps.modelStatusCache.snapshot(),
			});
			const allowed = profiles.some((candidate) => candidate.id === req.params.modelProfileId);
			if (!profile || !allowed) {
				return reply.code(404).send({ error: "Model profile not found" });
			}

			const provider = deps.modelProviderRegistry.require(profile.provider);
			const choicesResult = await loadProviderOptionChoices({
				provider,
				credentialStatus: deps.modelProviderCredentialStatus,
			});
			const fields = Object.entries(provider.definition.options?.fields ?? {}).map(
				([fieldId, field]) => {
					const declaredDefault =
						typeof field.defaultValue === "function"
							? field.defaultValue({ config: provider.config })
							: field.defaultValue;
					const profileDefault = profile.provider_options?.[fieldId];
					return {
						id: fieldId,
						label: field.label,
						required: field.required === true,
						minLength: field.minLength ?? null,
						maxLength: field.maxLength ?? null,
						defaultValue: profileDefault ?? declaredDefault ?? null,
						choices: choicesResult.ok ? (choicesResult.choices[fieldId] ?? []) : [],
					};
				},
			);
			return {
				modelProfileId: profile.id,
				providerId: profile.provider,
				fields,
				choicesStatus: choicesResult.ok ? "available" : "unavailable",
				choicesUnavailableReason: choicesResult.ok ? null : choicesResult.safeReason,
			};
		},
	);

	app.post<{ Params: { instanceId: string }; Body: { message?: unknown } }>(
		"/api/processes/:instanceId/steer",
		async (req, reply) => {
			const process = getProcessOrReply(deps, req.params.instanceId, reply);
			if (!process) return;
			const message = req.body?.message;
			if (typeof message !== "string" || message.trim() === "") {
				return reply.code(400).send({ error: "message must be a non-empty string" });
			}
			const result = await deps.processEngine.queueInputs(
				process.id,
				[
					{
						source: "app_steer",
						kind: "instruction",
						bodyMarkdown: message,
					},
				],
				{
					dispatchErrorMessage: "Failed to deliver the steering input to the worker",
					actor: resolveActor(req),
				},
			);
			if (!result.ok) {
				return sendEngineFailure(reply, result, "steer");
			}
			const [input] = result.data;
			if (!input) {
				return reply
					.code(503)
					.send({ error: "Failed to deliver the steering input to the worker" });
			}
			return { input };
		},
	);

	app.post<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/abort",
		async (req, reply) => {
			const result = await deps.processEngine.abortProcess(req.params.instanceId, {
				actor: resolveActor(req),
			});
			if (!result.ok) {
				return sendEngineFailure(reply, result, "abort");
			}
			return { process: result.process };
		},
	);

	app.post<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/abort-turn",
		async (req, reply) => {
			const result = await deps.processEngine.abortTurn(req.params.instanceId, {
				reason: "operator",
				actor: resolveActor(req),
			});
			if (!result.ok) {
				return sendEngineFailure(reply, result, "abort-turn");
			}
			return { process: result.process };
		},
	);

	app.post<{ Params: { instanceId: string }; Body: unknown }>(
		"/api/processes/:instanceId/retry",
		async (req, reply) => {
			const normalized = normalizeRecoveryModelRequest(req.body);
			if (!normalized.ok) return reply.code(400).send({ error: normalized.error });
			const result = await deps.processEngine.retryProcess(req.params.instanceId, {
				actor: resolveActor(req),
				...(normalized.request.nextTurnModelProfileIdProvided
					? { nextTurnModelProfileId: normalized.request.nextTurnModelProfileId ?? null }
					: {}),
				...(normalized.request.providerOptionsProvided
					? { providerOptions: normalized.request.providerOptions ?? {} }
					: {}),
			});
			if (!result.ok) {
				return sendEngineFailure(reply, result, "retry");
			}
			return { process: result.process };
		},
	);

	app.post<{
		Params: { instanceId: string; startRecordId: string };
		Body: unknown;
	}>("/api/processes/:instanceId/turn-starts/:startRecordId/retry", async (req, reply) => {
		const normalized = normalizeRecoveryModelRequest(req.body);
		if (!normalized.ok) return reply.code(400).send({ error: normalized.error });
		const options = {
			...(normalized.request.nextTurnModelProfileIdProvided
				? { nextTurnModelProfileId: normalized.request.nextTurnModelProfileId ?? null }
				: {}),
			...(normalized.request.providerOptionsProvided
				? { providerOptions: normalized.request.providerOptions ?? {} }
				: {}),
		};
		const { launchRunId } = await deps.launchCoordinator.retryStartup(
			req.params.instanceId,
			resolveActor(req),
		);
		const result = await deps.processEngine.retryStartup(
			req.params.instanceId,
			req.params.startRecordId,
			Object.keys(options).length > 0 ? options : undefined,
		);
		if (!result.ok) {
			deps.launchCoordinator.failStartupRetry(
				req.params.instanceId,
				"The worker could not be restarted. Review the process error and try again.",
			);
			return sendEngineFailure(reply, result, "retry");
		}
		return { process: result.process, startRecordId: result.data.startRecordId, launchRunId };
	});

	app.post<{ Params: { instanceId: string; turnRecordId: string } }>(
		"/api/processes/:instanceId/turn-records/:turnRecordId/continue",
		async (req, reply) => {
			const normalized = normalizeContinueRequest(req.body);
			if (!normalized.ok) {
				return reply.code(400).send({ error: normalized.error });
			}
			const actor = resolveActor(req);
			const options = {
				actor,
				...(normalized.request.promptProvided ? { prompt: normalized.request.prompt ?? null } : {}),
				...(normalized.request.nextTurnModelProfileIdProvided
					? { nextTurnModelProfileId: normalized.request.nextTurnModelProfileId ?? null }
					: {}),
				...(normalized.request.providerOptionsProvided
					? { providerOptions: normalized.request.providerOptions ?? {} }
					: {}),
			};
			const result = await deps.processEngine.continueFailedTurn(
				req.params.instanceId,
				req.params.turnRecordId,
				options,
			);
			if (!result.ok) {
				return sendEngineFailure(reply, result, "continue");
			}
			return { process: result.process };
		},
	);

	function resolveProcessActionTarget(
		req: FastifyRequest<{ Params: { instanceId: string }; Body: unknown }>,
		reply: FastifyReply,
	) {
		if (!deps.processActionRegistry) {
			reply.code(503).send({ error: "Process action registry is not available" });
			return null;
		}
		const process = getProcessOrReply(deps, req.params.instanceId, reply);
		if (!process) {
			return null;
		}
		const normalized = normalizeActionRequest(req.body);
		if (!normalized.ok) {
			sendActionRequestNormalizationError(reply, normalized.error);
			return null;
		}
		return {
			process,
			request: normalized.request,
			processActionRegistry: deps.processActionRegistry,
		};
	}

	app.post<{ Params: { instanceId: string; actionId: string }; Body: unknown }>(
		"/api/processes/:instanceId/actions/:actionId/model-preview",
		async (req, reply) => {
			const normalized = normalizeActionRequest(req.body);
			if (!normalized.ok) {
				return sendActionRequestNormalizationError(reply, normalized.error);
			}
			const result = await deps.processModelSelection.preview(
				req.params.instanceId,
				req.params.actionId,
				normalized.request.input,
			);
			if (result.kind === "operational_failure") {
				if (result.code === "process_not_found") {
					return reply.code(404).send({ error: "Process not found" });
				}
				return reply.code(503).send({ error: "Process model preview is unavailable" });
			}
			const body = { preview: result } satisfies ProcessActionModelPreviewResponseBody;
			return body;
		},
	);

	app.post<{ Params: { instanceId: string; actionId: string }; Body: unknown }>(
		"/api/processes/:instanceId/actions/:actionId",
		async (req, reply) => {
			const target = resolveProcessActionTarget(req, reply);
			if (!target) {
				return;
			}
			const { process, request } = target;
			const result = await futureExecutionLifecycle.scheduleAction(
				process,
				req.params.actionId,
				request,
				{ actor: resolveActor(req) },
			);
			return sendScheduledActionMutationResponse(reply, deps, result);
		},
	);

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/actions",
		async (req, reply) => {
			if (!deps.processActionRegistry) {
				return reply.code(503).send({ error: "Process action registry is not available" });
			}

			const process = getProcessOrReply(deps, req.params.instanceId, reply);
			if (!process) return;

			return { actions: listVisibleActionsForProcess(deps, process) };
		},
	);
}
