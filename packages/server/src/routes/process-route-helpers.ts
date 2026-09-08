import {
	type Actor,
	normalizeLaunchModelConfigInput,
	type ProcessEvent,
	type ProcessInstance,
	type ProcessProject,
	redactCredentialBearingAbsoluteUrl,
} from "@leitwerk-dev/domain";
import type { ProcessModelSelectionServiceLike } from "@leitwerk-dev/process-sdk";
import {
	type FormDefinition,
	findUiLauncherById,
	isLlmTurnDefinition,
	type OutcomeToolParameterSpec,
	type ProcessLauncherService,
	type ProcessLaunchPlanServiceLike,
	type ProcessToolOutcomeSpec,
} from "@leitwerk-dev/process-sdk";
import {
	createTemplateContext,
	resolveProcessPiConfig,
	resolveTurnActiveToolNames,
} from "@leitwerk-dev/process-sdk/pi-config";
import {
	parseActionRequestBody,
	parseLauncherInputJson,
	parseLauncherRequestBody,
} from "@leitwerk-dev/protocol";
import type {
	LauncherModelConfigSchema,
	LauncherMutationResponseBody,
	ProcessActionPreviewSummary,
	ProcessActionSummary,
	ProcessLaunchConfigurationView,
	ProcessRunDetailsView,
	ProcessRunTurnView,
	ScheduledActionDetail,
	ScheduledActionMutationResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import type { ToolCallRendererDefinition } from "@leitwerk-dev/protocol/tool-renderer-contract";
import type { FastifyReply, FastifyRequest } from "fastify";
import * as v from "valibot";
import { actorForRequest } from "../auth/fastify-auth.js";
import { getDefaultConfig } from "../config/config-loader.js";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type {
	ActionMutationOutcome,
	FutureExecutionLifecycle,
	LaunchMutationOutcome,
	NormalizedScheduledActionInput,
	NormalizedScheduledLaunchInput,
} from "../future-execution/index.js";
import {
	buildFutureExecutionListView,
	getScheduledActionDetailForProcess as getPresentedScheduledActionDetailForProcess,
} from "../future-execution-presenter.js";
import type { LaunchCoordinator } from "../launch-coordinator.js";
import { normalizeSubmittedProcessTitle } from "../launch-title.js";
import type { LauncherRecentValuesService } from "../launcher-recent-values-service.js";
import type {
	ModelProviderCredentialStatusResolver,
	ModelProviderRegistry,
	ModelStatusCache,
} from "../model-providers/index.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessDeletionService } from "../process-deletion-service.js";
import {
	isInternalEngineFailureCode,
	publicInternalEngineFailureMessage,
} from "../process-engine/internal-failures.js";
import type { ProcessEngine } from "../process-engine/types.js";
import { getProcessGraph, type ProcessGraphRegistry } from "../process-graph.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import { presentLauncherModelConfigSchema } from "../process-model-policy-presenter.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import {
	getSelectedTurnSummaryForProcess,
	listCurrentVisibleActions,
	listVisibleActionsForProcess as listVisibleAttentionActionsForProcess,
} from "../process-operator-attention.js";
import type { ProcessQuestionService } from "../process-question-service.js";
import type { ProcessSessionReader } from "../process-session-store.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { ProcessUiRegistry } from "../process-ui-registry.js";
import type { SkillCatalogService } from "../skills/catalog-service.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { ToolApprovalGate } from "../tool-approval-gate.js";
import type { Broadcaster } from "../ws/broadcast.js";

export const PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT = 500;

export interface RouteDeps
	extends Pick<
		RepositoryBundle,
		| "processes"
		| "launchRuns"
		| "projects"
		| "inputs"
		| "events"
		| "futureExecutions"
		| "skills"
		| "processSkills"
		| "handoffDedupKeys"
		| "leafOutcomeSnapshots"
		| "questionRequests"
		| "processRelations"
		| "toolApprovalRequests"
		| "turnRecords"
		| "turnStarts"
		| "turnAnnotations"
		| "leases"
		| "externalWrites"
		| "transaction"
	> {
	broadcaster: Broadcaster;
	processOperations: ProcessOperationCoordinator;
	processQuestions: ProcessQuestionService;
	toolApprovalGate: ToolApprovalGate;
	processGraphs: ProcessGraphRegistry;
	supervisor?: WorkerSupervisor;
	processEngine: ProcessEngine;
	processDeletion: ProcessDeletionService;
	processActionRegistry?: ProcessActionRegistry;
	processUiRegistry?: ProcessUiRegistry;
	extensionHost?: ExtensionHost;
	launcherService: ProcessLauncherService;
	launchCoordinator: LaunchCoordinator;
	launcherRecentValues: LauncherRecentValuesService;
	launchPlans: ProcessLaunchPlanServiceLike;
	processTitles?: ProcessTitleGenerator;
	toolRenderers?: ReadonlyMap<string, ToolCallRendererDefinition>;
	config?: LeitwerkConfig;
	sessionReader: ProcessSessionReader;
	futureExecutionLifecycle: FutureExecutionLifecycle;
	modelProviderRegistry?: ModelProviderRegistry;
	modelProviderCredentialStatus?: ModelProviderCredentialStatusResolver;
	modelStatusCache: ModelStatusCache;
	processModelPolicy: ServerProcessModelPolicy;
	processModelSelection: ProcessModelSelectionServiceLike;
	skillCatalog?: SkillCatalogService;
}

export function routeConfig(deps: RouteDeps): LeitwerkConfig {
	return deps.config ?? getDefaultConfig();
}

function formatLaunchParameterValue(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === "string") {
		const normalized = redactCredentialBearingAbsoluteUrl(value.trim());
		return normalized === "" ? null : normalized;
	}
	return String(value);
}

function buildLaunchParameterRows(
	params: Record<string, unknown>,
	launcher: ReturnType<ProcessLauncherService["listUiLaunchers"]>[number] | null,
): ProcessLaunchConfigurationView["parameters"] {
	const rows: Array<ProcessLaunchConfigurationView["parameters"][number]> = [];
	const usedFieldIds = new Set<string>();
	for (const field of launcher?.launchConfigSchema.fields ?? []) {
		if (!Object.hasOwn(params, field.id)) {
			continue;
		}
		usedFieldIds.add(field.id);
		rows.push({
			fieldId: field.id,
			label: field.label || field.id,
			value: formatLaunchParameterValue(params[field.id]),
		});
	}
	for (const fieldId of Object.keys(params).sort((left, right) => left.localeCompare(right))) {
		if (usedFieldIds.has(fieldId)) {
			continue;
		}
		rows.push({
			fieldId,
			label: fieldId,
			value: formatLaunchParameterValue(params[fieldId]),
		});
	}
	return rows;
}

export function buildProcessLaunchConfigurationView(
	deps: Pick<RouteDeps, "launcherService">,
	process: ProcessInstance,
	projects: readonly ProcessProject[],
): ProcessLaunchConfigurationView {
	const rawLauncherId = process.metadata?.launcherId;
	const launcherId =
		typeof rawLauncherId === "string" && rawLauncherId.trim() !== "" ? rawLauncherId.trim() : null;
	const launcher = launcherId ? findUiLauncherById(deps.launcherService, launcherId) : null;
	const parsedParams = parseLauncherInputJson(process.paramsJson, "paramsJson");
	return {
		launcherId,
		launcherLabel: launcher?.label ?? null,
		launcherSchemaTitle: launcher?.launchConfigSchema.title ?? null,
		paramsParseError: parsedParams.ok ? null : parsedParams.error,
		parameters: parsedParams.ok ? buildLaunchParameterRows(parsedParams.value, launcher) : [],
		projects: projects.map((project) => ({
			key: project.key,
			repoLocator: redactCredentialBearingAbsoluteUrl(project.repoLocator),
			repoLocatorKind: project.repoLocatorKind,
			baseBranch: project.baseBranch,
			workBranch: project.workBranch,
			externalId: project.externalId,
			externalUrl: project.externalUrl
				? redactCredentialBearingAbsoluteUrl(project.externalUrl)
				: null,
			pipelineStatus: project.pipelineStatus,
		})),
	};
}

export function buildProcessRunDetailsView(
	deps: RouteDeps,
	process: ProcessInstance,
	projects: readonly ProcessProject[],
): ProcessRunDetailsView {
	const config = routeConfig(deps);
	const processDef = deps.processActionRegistry?.getProcessGraph(process.processId);
	const contextData = deps.processActionRegistry?.resolveContextData(
		process.processId,
		process,
	) ?? {
		params: {},
		state: {},
	};
	const templateContext = createTemplateContext({
		params: contextData.params,
		process,
		projects,
	});
	const resolvedPiConfig = resolveProcessPiConfig({
		processId: process.processId,
		processPiConfig: processDef?.piConfig,
		turns: processDef?.turns.values(),
		configSnapshot: config,
		templateContext,
	});
	const contract = getProcessGraph(deps.processGraphs, process.processId);
	const turns: ProcessRunTurnView[] = [];

	for (const [turnId, turnContract] of contract.turns) {
		if (turnContract.turnType !== "llm") {
			continue;
		}
		const turnDef = deps.processActionRegistry?.getTurnDefinition(process.processId, turnId);
		if (!turnDef || !isLlmTurnDefinition(turnDef)) {
			continue;
		}
		turns.push({
			turnId,
			description: turnDef.description,
			pathType: turnDef.branchType,
			consumedProducts: [...(turnContract.consumedProducts ?? [])],
			publishedProducts: [
				...new Set(
					[turnContract.publishedProduct, ...(turnContract.publishedProducts ?? [])].filter(
						(product): product is string => Boolean(product),
					),
				),
			],
			activePiToolNames: resolveTurnActiveToolNames({
				turnId,
				turnDef,
			}),
			outcomeActions: (
				Object.entries(turnDef.outcomes ?? {}) as [
					string,
					ProcessToolOutcomeSpec<unknown, unknown> | undefined,
				][]
			)
				.filter((entry): entry is [string, ProcessToolOutcomeSpec<unknown, unknown>] =>
					Boolean(entry[1]),
				)
				.map(([toolName, toolSpec]) => ({
					name: toolName,
					description: toolSpec.description,
					parameters: (
						Object.entries(toolSpec.parameters) as [string, OutcomeToolParameterSpec][]
					).map(([parameterName, parameterSpec]) => ({
						name: parameterName,
						type: parameterSpec.type,
						description: parameterSpec.description,
						required: parameterSpec.required === true,
					})),
				})),
		});
	}

	return {
		systemPrompt: resolvedPiConfig.systemPrompt ?? null,
		appendSystemPrompt: resolvedPiConfig.appendSystemPrompt ?? null,
		availablePiToolNames: [...resolvedPiConfig.availableToolNames],
		turns,
	};
}

export function actionHasPurePlan(
	deps: RouteDeps,
	process: ProcessInstance,
	actionId: string,
): boolean {
	const action = deps.processActionRegistry?.getAction(process.processId, actionId);
	return typeof action?.plan === "function";
}

export function buildActionSummaryForProcess(
	deps: RouteDeps,
	process: ProcessInstance,
	actionId: string,
	action: {
		id: string;
		label: string;
		form?: FormDefinition;
	},
	labelOverride?: string | null,
	overrides: { supportsScheduling?: boolean } = {},
): ProcessActionSummary {
	const visibleAction = listCurrentVisibleActions(deps, process).find(
		(candidate) => candidate.id === actionId,
	);
	const preview =
		visibleAction?.preview ??
		deps.processActionRegistry?.resolveActionPreview(process.processId, process, actionId) ??
		null;
	const supportsScheduling =
		overrides.supportsScheduling ??
		Boolean(
			actionHasPurePlan(deps, process, actionId) &&
				deps.processActionRegistry?.resolveActionScheduling(process.processId, process, actionId),
		);
	return buildProcessActionSummary(action, labelOverride ?? visibleAction?.label ?? action.label, {
		description: visibleAction?.description ?? null,
		preview: buildProcessActionPreviewSummary(deps, preview, process),
		supportsScheduling,
		supportsNextTurnModelOverride: previewSupportsNextTurnModelOverride(
			deps,
			process,
			actionId,
			preview,
		),
	});
}

export function listVisibleActionsForProcess(deps: RouteDeps, process: ProcessInstance) {
	return listVisibleAttentionActionsForProcess(deps, process).map((action) =>
		buildActionSummaryForProcess(deps, process, action.id, action, action.label),
	);
}

export function processDefinesLeafOutcome(deps: RouteDeps, process: ProcessInstance): boolean {
	return deps.processUiRegistry?.hasLeafOutcome(process.processId) ?? false;
}

export function getProcessOrReply(
	deps: RouteDeps,
	instanceId: string,
	reply: FastifyReply,
): ProcessInstance | null {
	const process = deps.processes.getById(instanceId);
	if (!process) {
		reply.code(404).send({ error: "Process not found" });
		return null;
	}
	return process;
}

/**
 * Resolves the acting principal for an HTTP request. When SSO is enabled,
 * the actor is extracted from the session cookie; when auth is disabled,
 * every web action is attributed to the `admin` actor.
 */
export function resolveActor(req: FastifyRequest): Actor {
	return actorForRequest(req);
}

export interface NormalizedContinueRequest {
	prompt?: string | null;
	promptProvided: boolean;
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	providerOptions?: Record<string, string>;
	providerOptionsProvided: boolean;
}

export interface NormalizedRecoveryModelRequest {
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	providerOptions?: Record<string, string>;
	providerOptionsProvided: boolean;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(object, key);
}

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

function normalizeProviderOptions(
	value: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "providerOptions must be an object of string values" };
	}
	const entries = Object.entries(value);
	if (entries.length > 64) return { ok: false, error: "providerOptions has too many fields" };
	const result: Record<string, string> = {};
	for (const [key, option] of entries) {
		if (!key || key.length > 128 || typeof option !== "string" || option.length > 4096) {
			return { ok: false, error: "providerOptions contains an invalid field" };
		}
		result[key] = option;
	}
	return { ok: true, value: result };
}

interface ParsedModelRequest {
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	providerOptions?: Record<string, string>;
	providerOptionsProvided: boolean;
}

function parseModelRequest(
	value: unknown,
	input: { requestName: string; allowedKeys: readonly string[]; expectedShape: string },
):
	| { ok: true; body: Record<string, unknown>; request: ParsedModelRequest }
	| { ok: false; error: string } {
	if (value === undefined || value === null) {
		return {
			ok: true,
			body: {},
			request: { nextTurnModelProfileIdProvided: false, providerOptionsProvided: false },
		};
	}
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return { ok: false, error: `${input.requestName} request body must be an object` };
	}
	const body = parsedValue.output;
	if (Object.keys(body).some((key) => !input.allowedKeys.includes(key))) {
		return {
			ok: false,
			error: `${input.requestName} request body must use ${input.expectedShape}`,
		};
	}
	const nextTurnModelProfileIdProvided = hasOwn(body, "nextTurnModelProfileId");
	const modelProfileId = body.nextTurnModelProfileId;
	if (
		modelProfileId !== undefined &&
		modelProfileId !== null &&
		typeof modelProfileId !== "string"
	) {
		return { ok: false, error: "nextTurnModelProfileId must be a string or null" };
	}
	const providerOptionsProvided = hasOwn(body, "providerOptions");
	const providerOptions = providerOptionsProvided
		? normalizeProviderOptions(body.providerOptions)
		: ({ ok: true, value: {} } as const);
	if (!providerOptions.ok) return providerOptions;
	return {
		ok: true,
		body,
		request: {
			nextTurnModelProfileIdProvided,
			providerOptionsProvided,
			...(nextTurnModelProfileIdProvided
				? {
						nextTurnModelProfileId:
							typeof modelProfileId === "string" ? modelProfileId.trim() || null : null,
					}
				: {}),
			...(providerOptionsProvided ? { providerOptions: providerOptions.value } : {}),
		},
	};
}

export function normalizeLauncherRequest(value: unknown):
	| { ok: true; request: NormalizedScheduledLaunchInput }
	| {
			ok: false;
			error: string;
	  } {
	const parsed = parseLauncherRequestBody(value);
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	return {
		ok: true,
		request: {
			title: normalizeSubmittedProcessTitle(parsed.value.title),
			titleProvided: parsed.value.titleProvided,
			launcherInput: parsed.value.launcherInput,
			launcherInputProvided: parsed.value.launcherInputProvided,
			...(parsed.value.skillIds ? { skillIds: parsed.value.skillIds } : {}),
			modelConfig: normalizeLaunchModelConfigInput(parsed.value.modelConfig),
			modelConfigProvided: parsed.value.modelConfigProvided,
			schedule: parsed.value.schedule,
			scheduleProvided: parsed.value.scheduleProvided,
		},
	};
}

export function normalizeActionRequest(value: unknown):
	| {
			ok: true;
			request: NormalizedScheduledActionInput;
	  }
	| {
			ok: false;
			error: string;
	  } {
	const parsed = parseActionRequestBody(value);
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	return {
		ok: true,
		request: parsed.value,
	};
}

function isScheduleRequestError(error: string): boolean {
	return (
		error === "schedule must be an object" ||
		error === "runAt must be a valid ISO datetime" ||
		error === "cronExpression is required for cron schedules" ||
		error.startsWith("schedule.")
	);
}

export function sendLauncherRequestNormalizationError(reply: FastifyReply, error: string) {
	return isScheduleRequestError(error)
		? reply.code(400).send({
				errors: [{ code: "invalid_schedule", message: error }],
			})
		: reply.code(400).send({ error });
}

export function sendActionRequestNormalizationError(reply: FastifyReply, error: string) {
	return isScheduleRequestError(error)
		? reply.code(400).send({ error, code: "invalid_schedule" })
		: reply.code(400).send({ error });
}

export function normalizeContinueRequest(
	value: unknown,
): { ok: true; request: NormalizedContinueRequest } | { ok: false; error: string } {
	const parsed = parseModelRequest(value, {
		requestName: "continue",
		allowedKeys: ["prompt", "nextTurnModelProfileId", "providerOptions"],
		expectedShape: "{ prompt, nextTurnModelProfileId, providerOptions }",
	});
	if (!parsed.ok) return parsed;
	if (
		parsed.body.prompt !== undefined &&
		parsed.body.prompt !== null &&
		typeof parsed.body.prompt !== "string"
	) {
		return { ok: false, error: "prompt must be a string or null" };
	}
	const promptProvided = hasOwn(parsed.body, "prompt");
	return {
		ok: true,
		request: {
			...parsed.request,
			promptProvided,
			...(promptProvided ? { prompt: parsed.body.prompt as string | null } : {}),
		},
	};
}

export function normalizeRecoveryModelRequest(
	value: unknown,
): { ok: true; request: NormalizedRecoveryModelRequest } | { ok: false; error: string } {
	const parsed = parseModelRequest(value, {
		requestName: "recovery",
		allowedKeys: ["nextTurnModelProfileId", "providerOptions"],
		expectedShape: "{ nextTurnModelProfileId, providerOptions }",
	});
	return parsed.ok ? { ok: true, request: parsed.request } : parsed;
}

export function buildProcessActionPreviewSummary(
	deps: RouteDeps,
	preview: {
		candidateSelectedTurnId: string | null;
		lifecycleStatus?: string | null;
	} | null,
	process: ProcessInstance,
): ProcessActionPreviewSummary | null {
	if (!preview) {
		return null;
	}
	if (!preview.candidateSelectedTurnId) {
		return {
			kind: "terminal",
			turnId: null,
			turnKind: null,
			description: preview.lifecycleStatus === "aborted" ? "Abort process" : "Complete process",
		};
	}
	const turnDef = deps.processActionRegistry?.getTurnDefinition(
		process.processId,
		preview.candidateSelectedTurnId,
	);
	if (!turnDef) {
		return null;
	}
	return {
		kind: "turn",
		turnId: preview.candidateSelectedTurnId,
		turnKind: turnDef.kind,
		description: turnDef.description,
	};
}

export function previewSupportsNextTurnModelOverride(
	deps: RouteDeps,
	process: ProcessInstance,
	actionId: string,
	preview: { candidateSelectedTurnId: string | null } | null,
): boolean {
	if (!preview?.candidateSelectedTurnId) {
		return false;
	}
	if (!actionHasPurePlan(deps, process, actionId)) {
		return false;
	}
	const turnDef = deps.processActionRegistry?.getTurnDefinition(
		process.processId,
		preview.candidateSelectedTurnId,
	);
	return Boolean(turnDef && isLlmTurnDefinition(turnDef));
}

export function buildProcessActionSummary(
	action: {
		id: string;
		label: string;
		form?: FormDefinition;
	},
	labelOverride?: string | null,
	opts: {
		description?: string | null;
		preview?: ProcessActionPreviewSummary | null;
		supportsScheduling?: boolean;
		supportsNextTurnModelOverride?: boolean;
	} = {},
): ProcessActionSummary {
	return {
		id: action.id,
		label: labelOverride?.trim() ? labelOverride : action.label,
		description: opts.description ?? null,
		preview: opts.preview ?? null,
		supportsScheduling: opts.supportsScheduling === true,
		supportsNextTurnModelOverride: opts.supportsNextTurnModelOverride === true,
		...(action.form
			? {
					form: {
						id: action.form.id,
						title: action.form.title,
						submitLabel: action.form.submitLabel,
						fields: action.form.fields.map((field) => ({ ...field })),
					},
				}
			: {}),
	};
}

export function getScheduledActionDetailForProcess(
	deps: RouteDeps,
	process: ProcessInstance,
): ScheduledActionDetail | null {
	return getPresentedScheduledActionDetailForProcess(
		{
			...deps,
			buildActionSummaryForProcess: (process, actionId, action, labelOverride, overrides) =>
				buildActionSummaryForProcess(deps, process, actionId, action, labelOverride, overrides),
		},
		process,
	);
}

export function buildLauncherModelConfigSchema(
	deps: RouteDeps,
	processId: string,
): LauncherModelConfigSchema {
	return presentLauncherModelConfigSchema(
		deps.processModelPolicy.project({
			kind: "launcher_schema",
			processId,
			availability: deps.modelStatusCache.snapshot(),
		}),
	);
}

export function sendLauncherLookupFailure(reply: FastifyReply, error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	if (
		error.message.startsWith("Unknown launcher '") ||
		error.message.includes("is not UI-visible")
	) {
		reply.code(404).send({ error: "Launcher not found" });
		return true;
	}
	return false;
}

type SharedMutationFailure = Extract<
	LaunchMutationOutcome | ActionMutationOutcome,
	{ kind: "conflict" | "unavailable" | "failed" }
>;

function sendSharedMutationFailure(reply: FastifyReply, outcome: SharedMutationFailure) {
	switch (outcome.kind) {
		case "conflict":
			return reply.code(409).send({ error: outcome.issue.message, code: outcome.issue.code });
		case "unavailable":
			return reply.code(503).send({ error: outcome.reason });
		case "failed":
			return reply.code(500).send({
				error: isInternalEngineFailureCode(outcome.issue.code)
					? publicInternalEngineFailureMessage(outcome.issue.code)
					: outcome.issue.message,
				code: outcome.issue.code,
			});
	}
}

export function sendLauncherMutationResponse(
	reply: FastifyReply,
	deps: RouteDeps,
	outcome: LaunchMutationOutcome,
) {
	switch (outcome.kind) {
		case "scheduled": {
			const summary = buildFutureExecutionListView(deps, outcome.execution);
			const body = {
				kind: "scheduled",
				futureExecution: summary?.kind === "launch" ? summary : null,
			} satisfies LauncherMutationResponseBody;
			return reply.code(outcome.operation === "created" ? 201 : 200).send(body);
		}
		case "launched":
			return reply
				.code(outcome.operation === "created" ? 201 : 200)
				.send({ process: outcome.process, projects: outcome.projects });
		case "committed_with_reaction_error":
			if ("execution" in outcome) {
				const summary = buildFutureExecutionListView(deps, outcome.execution);
				return reply.code(200).send({
					kind: "scheduled",
					futureExecution: summary?.kind === "launch" ? summary : null,
					error: outcome.error,
					code: outcome.code,
				});
			}
			return reply.code(200).send({
				process: outcome.process,
				projects: outcome.projects,
				error: outcome.error,
				...(outcome.code ? { code: outcome.code } : {}),
			});
		case "invalid":
			return reply.code(400).send({ errors: outcome.issues });
		case "not_found":
			return reply.code(404).send({ error: "Scheduled launch not found" });
		case "conflict":
		case "unavailable":
		case "failed":
			return sendSharedMutationFailure(reply, outcome);
	}
}

export function sendScheduledActionMutationResponse(
	reply: FastifyReply,
	deps: RouteDeps,
	outcome: ActionMutationOutcome,
) {
	switch (outcome.kind) {
		case "scheduled": {
			const lockedProcess = deps.processes.getById(outcome.instanceId);
			const body = {
				kind: "scheduled",
				scheduledAction: lockedProcess
					? getScheduledActionDetailForProcess(deps, lockedProcess)
					: null,
			} satisfies ScheduledActionMutationResponseBody;
			return reply.code(outcome.operation === "created" ? 201 : 200).send(body);
		}
		case "executed":
			return reply
				.code(200)
				.send({ process: outcome.process, ...(outcome.data ? { data: outcome.data } : {}) });
		case "committed_with_reaction_error":
			if ("execution" in outcome) {
				const lockedProcess = deps.processes.getById(outcome.instanceId);
				return reply.code(200).send({
					kind: "scheduled",
					scheduledAction: lockedProcess
						? getScheduledActionDetailForProcess(deps, lockedProcess)
						: null,
					error: outcome.error,
					code: outcome.code,
				});
			}
			return reply.code(200).send({
				process: outcome.process,
				error: outcome.error,
				...(outcome.code ? { code: outcome.code } : {}),
			});
		case "invalid": {
			const issue = outcome.issues[0] ?? {
				code: "invalid_request",
				message: "Invalid action request",
			};
			return reply.code(400).send({ error: issue.message, code: issue.code });
		}
		case "not_found":
			return reply.code(404).send({
				error: outcome.target === "process" ? "Process not found" : "Scheduled action not found",
			});
		case "conflict":
		case "unavailable":
		case "failed":
			return sendSharedMutationFailure(reply, outcome);
	}
}

export function mergeProcessEventWindowsAscending(
	windows: readonly (readonly ProcessEvent[])[],
): ProcessEvent[] {
	const eventsById = new Map<string, ProcessEvent>();
	for (const window of windows) {
		for (const event of window) {
			eventsById.set(event.id, event);
		}
	}
	return [...eventsById.values()].sort((left, right) => {
		const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
		return createdAtComparison !== 0 ? createdAtComparison : left.id.localeCompare(right.id);
	});
}

export { getSelectedTurnSummaryForProcess };
