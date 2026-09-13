import type {
	ProcessInstance,
	ProcessProject,
	ProcessQuestionRequest,
	ProcessToolApprovalRequest,
	QuestionAnswerDraft,
} from "@leitwerk-dev/domain";
import type {
	LaunchTicketCreationRequestBody,
	LaunchTicketCreationResponseBody,
	PrimaryPathSnapshot,
	ResolveToolApprovalRequestBody,
	TicketCreationToolSummary,
} from "@leitwerk-dev/protocol";
import type {
	AuthMeResponseBody,
	CronPreviewResponseBody,
	FutureExecutionSummary as FullFutureExecutionSummary,
	FutureExecutionDetailResponseBody,
	FutureExecutionOverviewItem,
	FutureLaunchMutationResponseBody,
	FutureLaunchSummary,
	InstalledSkillCatalogDetail,
	InstalledSkillCatalogDetailResponseBody,
	LauncherDefaultsResponseBody,
	LauncherModelConfigDefaults,
	LauncherModelConfigPreview,
	LauncherModelConfigPreviewResponseBody,
	LauncherMutationResponseBody,
	LauncherOptionsResponseBody,
	LauncherRecentValuesResponseBody,
	LaunchersResponseBody,
	LaunchRunResponseBody,
	ModelProviderOptionsResponseBody,
	PrimaryPathSnapshotResponseBody,
	ProcessActionModelPreview,
	ProcessActionModelPreviewResponseBody,
	ProcessBrowseResponseBody,
	ProcessDetailUiSnapshotResponseBody,
	ProcessDiagnosticsData,
	ProcessDiagnosticsResponseBody,
	ProcessesOverviewResponseBody,
	ProcessLaunchRunsResponseBody,
	ProcessOverviewItem,
	ProcessRetryConfig,
	ProcessRetryConfigResponseBody,
	QuestionRequestMutationResponseBody,
	ScheduleConfigInput,
	ScheduledActionDetail,
	ScheduledActionMutationResponseBody,
	SkillCatalogDetail,
	SkillCatalogDetailResponseBody,
	SkillsCatalogResponseBody,
	StartLaunchRunResponseBody,
	TurnReasoningDetailResponseBody,
	UiLauncherSummary,
	WatcherSummary,
	WatchersResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import type {
	LauncherFieldOptionDefinition,
	LauncherValidationError,
} from "@leitwerk-dev/protocol/launcher-contract";
import * as v from "valibot";
import { formatDefinition } from "./format.js";
import {
	jsonRequestInit,
	readErrorMessage,
	readJsonObject,
	requestJson,
	requestMutation,
	requireSuccessfulResponse,
	tryReadJson,
	unknownRecordSchema,
} from "./http-client.js";
import { getFetchImpl, resolveApiUrl } from "./runtime-config";

export class ApiResponseError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiResponseError";
		this.status = status;
	}
}

function requestStatusJson<T extends object>(
	path: string,
	error: string,
	malformed: string,
	init?: RequestInit,
): Promise<T> {
	return requestJson({
		path,
		init,
		malformed,
		error: (response) => new Error(`${error}: ${response.status}`),
	});
}

function apiResponseError(message: string) {
	return (response: Response, body: unknown) =>
		new ApiResponseError(readErrorMessage(body) ?? message, response.status);
}

export type ProcessDetailData = ProcessDetailUiSnapshotResponseBody;
export type FutureExecutionSummary = FutureExecutionOverviewItem;
export type FutureActionSummary = Extract<FutureExecutionOverviewItem, { kind: "action" }>;
export type FutureLaunchOverviewSummary = Extract<FutureExecutionOverviewItem, { kind: "launch" }>;
export type FullFutureExecution = FullFutureExecutionSummary;

export async function submitQuestionAnswers(input: {
	instanceId: string;
	requestId: string;
	draft: QuestionAnswerDraft[];
}): Promise<ProcessQuestionRequest> {
	return (
		await requestJson<QuestionRequestMutationResponseBody>({
			path: `/api/processes/${encodeURIComponent(input.instanceId)}/question-requests/${encodeURIComponent(input.requestId)}/answers`,
			init: jsonRequestInit("POST", { draft: input.draft }),
			malformed: "Malformed question response",
			error: apiResponseError("Couldn't send answers"),
		})
	).request;
}

export async function fetchTicketCreationTools(): Promise<TicketCreationToolSummary[]> {
	return (
		await requestJson<{ tools: TicketCreationToolSummary[] }>({
			path: "/api/ticket-creation/tools",
			malformed: "Malformed ticket tool response",
			error: (response) => new ApiResponseError("Couldn't load ticket systems", response.status),
		})
	).tools;
}

export function launchTicketCreation(
	instanceId: string,
	body: LaunchTicketCreationRequestBody,
): Promise<LaunchTicketCreationResponseBody> {
	return requestJson({
		path: `/api/processes/${encodeURIComponent(instanceId)}/ticket-creation`,
		init: {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": crypto.randomUUID(),
			},
			body: JSON.stringify(body),
		},
		malformed: "Malformed ticket launch response",
		error: apiResponseError("Couldn't start ticket creation"),
	});
}

export async function resolveToolApproval(input: {
	instanceId: string;
	requestId: string;
	body: ResolveToolApprovalRequestBody;
}): Promise<ProcessToolApprovalRequest> {
	return (
		await requestJson<{ request: ProcessToolApprovalRequest }>({
			path: `/api/processes/${encodeURIComponent(input.instanceId)}/tool-approval-requests/${encodeURIComponent(input.requestId)}`,
			init: jsonRequestInit("POST", input.body),
			malformed: "Malformed approval response",
			error: apiResponseError("Couldn't resolve approval"),
		})
	).request;
}

export async function fetchAuthMe(): Promise<AuthMeResponseBody> {
	const res = await getFetchImpl()(resolveApiUrl("/api/auth/me"));
	if (res.status === 401) {
		return { authEnabled: true, actor: null };
	}
	if (!res.ok) {
		throw new ApiResponseError(`Couldn't load authentication status: ${res.status}`, res.status);
	}
	return readJsonObject<AuthMeResponseBody>(res, "Malformed auth status response");
}

export async function logout(): Promise<void> {
	const res = await getFetchImpl()(resolveApiUrl("/auth/logout"), { method: "POST" });
	if (!res.ok) {
		throw new ApiResponseError(`Couldn't log out: ${res.status}`, res.status);
	}
}

export interface AuthMeRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	signal?: AbortSignal;
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
	sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function defaultRetrySleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function retryableAuthBootstrapError(error: unknown): boolean {
	return error instanceof ApiResponseError
		? [502, 503, 504].includes(error.status)
		: error instanceof TypeError;
}

export async function fetchAuthMeWithRetry(
	options: AuthMeRetryOptions = {},
): Promise<AuthMeResponseBody> {
	const maxAttempts = options.maxAttempts ?? 60;
	const baseDelayMs = options.baseDelayMs ?? 250;
	const maxDelayMs = options.maxDelayMs ?? 2_000;
	const sleep = options.sleep ?? defaultRetrySleep;
	let attempt = 0;
	while (true) {
		attempt += 1;
		try {
			return await fetchAuthMe();
		} catch (error) {
			if (
				options.signal?.aborted ||
				!retryableAuthBootstrapError(error) ||
				attempt >= maxAttempts
			) {
				throw error;
			}
			const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 8));
			options.onRetry?.(error, attempt, delayMs);
			await sleep(delayMs, options.signal);
		}
	}
}

export type LauncherSubmitResult =
	| {
			kind: "launch_started";
			launchRunId: string;
	  }
	| {
			kind: "success";
			process: ProcessInstance;
			projects: ProcessProject[];
	  }
	| {
			kind: "scheduled";
			futureExecution: FutureLaunchSummary;
	  }
	| {
			kind: "validation_error";
			status: number;
			errors: LauncherValidationError[];
	  }
	| {
			kind: "failure";
			status: number;
			error: string;
	  };

function isLauncherValidationError(value: unknown): value is LauncherValidationError {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return false;
	}
	const record = parsedValue.output;
	return (
		typeof record.code === "string" &&
		typeof record.message === "string" &&
		(record.fieldId === undefined || typeof record.fieldId === "string")
	);
}

function readLauncherValidationErrors(body: unknown): LauncherValidationError[] {
	const parsedBody = v.safeParse(unknownRecordSchema, body);
	if (!parsedBody.success || !Array.isArray(parsedBody.output.errors)) {
		return [];
	}
	return parsedBody.output.errors.filter(isLauncherValidationError);
}

export async function fetchProcessesList(): Promise<{
	processes: ProcessOverviewItem[];
	futureExecutions: FutureExecutionOverviewItem[];
}> {
	return requestStatusJson<ProcessesOverviewResponseBody>(
		"/api/processes/overview",
		"Couldn't load the process list",
		"Malformed process overview response",
	);
}

export interface ProcessBrowseRequest {
	limit?: number;
	offset?: number;
	query?: string;
	processType?: string;
	status?: string;
	sortKey?: "status" | "title" | "timeline";
	sortDirection?: "asc" | "desc";
}

export async function fetchProcessBrowse(
	request: ProcessBrowseRequest = {},
): Promise<ProcessBrowseResponseBody> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(request)) {
		if (value !== undefined && value !== "") {
			params.set(key, String(value));
		}
	}
	const query = params.size > 0 ? `?${params.toString()}` : "";
	return requestStatusJson(
		`/api/processes/browse${query}`,
		"Couldn't browse processes",
		"Malformed process browse response",
	);
}

export async function fetchLaunchers(): Promise<UiLauncherSummary[]> {
	const body = await requestStatusJson<LaunchersResponseBody>(
		"/api/launchers",
		"Couldn't load available processes",
		"Malformed launchers response",
	);
	return body.launchers;
}

export async function fetchWatchers(): Promise<WatcherSummary[]> {
	const body = await requestStatusJson<WatchersResponseBody>(
		"/api/watchers",
		"Couldn't load registered watchers",
		"Malformed watchers response",
	);
	return body.watchers;
}

export async function fetchSkills(): Promise<SkillsCatalogResponseBody> {
	return requestStatusJson(
		"/api/skills",
		"Couldn't load the skill catalog",
		"Malformed skill catalog response",
	);
}

export async function refreshSkills(): Promise<SkillsCatalogResponseBody> {
	return requestStatusJson(
		"/api/skills/refresh",
		"Couldn't refresh skill repositories",
		"Malformed skill catalog response",
		{ method: "POST" },
	);
}

export async function fetchSkillDetail(
	repositoryId: string,
	skillId: string,
): Promise<SkillCatalogDetail> {
	const body = await requestStatusJson<SkillCatalogDetailResponseBody>(
		`/api/skills/available/${encodeURIComponent(repositoryId)}/${encodeURIComponent(skillId)}`,
		"Couldn't load skill details",
		"Malformed skill detail response",
	);
	return body.skill;
}

export async function fetchInstalledSkillDetail(
	skillId: string,
): Promise<InstalledSkillCatalogDetail> {
	const body = await requestStatusJson<InstalledSkillCatalogDetailResponseBody>(
		`/api/skills/installed/${encodeURIComponent(skillId)}`,
		"Couldn't load installed skill details",
		"Malformed installed skill detail response",
	);
	return body.skill;
}

export async function registerSkill(repositoryId: string, skillId: string): Promise<void> {
	return requestMutation(
		`/api/skills/available/${encodeURIComponent(repositoryId)}/${encodeURIComponent(skillId)}/register`,
		"Couldn't register the skill",
		{ method: "POST" },
	);
}

export async function removeSkill(skillId: string): Promise<void> {
	return requestMutation(
		`/api/skills/installed/${encodeURIComponent(skillId)}`,
		"Couldn't remove the skill",
		{ method: "DELETE" },
	);
}

export async function fetchLauncherDefaults(
	launcherId: string,
): Promise<LauncherDefaultsResponseBody> {
	return requestStatusJson(
		`/api/launchers/${encodeURIComponent(launcherId)}/defaults`,
		"Couldn't load default values",
		"Malformed launcher defaults response",
	);
}

export async function fetchLauncherRecentValues(
	launcherId: string,
): Promise<Record<string, readonly string[]>> {
	const body = await requestStatusJson<LauncherRecentValuesResponseBody>(
		`/api/launchers/${encodeURIComponent(launcherId)}/recent-values`,
		"Couldn't load recent launcher values",
		"Malformed launcher recent values response",
	);
	return body.values;
}

export async function fetchLauncherOptions(
	launcherId: string,
	launcherInput: Record<string, unknown>,
): Promise<Record<string, readonly LauncherFieldOptionDefinition[]>> {
	const body = await requestStatusJson<LauncherOptionsResponseBody>(
		`/api/launchers/${encodeURIComponent(launcherId)}/options`,
		"Couldn't refresh the available options",
		"Malformed launcher options response",
		jsonRequestInit("POST", { launcherInput }),
	);
	return body.options;
}

export async function fetchLauncherModelConfigPreview(
	launcherId: string,
	launcherInput: Record<string, unknown>,
	modelConfig: LauncherModelConfigDefaults = {},
): Promise<LauncherModelConfigPreview> {
	const body = await requestStatusJson<LauncherModelConfigPreviewResponseBody>(
		`/api/launchers/${encodeURIComponent(launcherId)}/model-config-preview`,
		"Couldn't refresh the model preview",
		"Malformed launcher model preview response",
		jsonRequestInit("POST", { launcherInput, modelConfig }),
	);
	return body.preview;
}

async function parseLauncherErrorResponse(
	res: Response,
	fallbackMessagePrefix: string,
	body: unknown,
): Promise<LauncherSubmitResult> {
	const errors = readLauncherValidationErrors(body);
	if (errors.length > 0) {
		return { kind: "validation_error", status: res.status, errors };
	}
	return {
		kind: "failure",
		status: res.status,
		error: readErrorMessage(body) ?? `${fallbackMessagePrefix}: ${res.status}`,
	};
}

export async function fetchLaunchRun(
	launchRunId: string,
): Promise<LaunchRunResponseBody["launchRun"]> {
	return (
		await requestJson<LaunchRunResponseBody>({
			path: `/api/launch-runs/${encodeURIComponent(launchRunId)}`,
			malformed: "Malformed launch run response",
			error: (response) =>
				new ApiResponseError(`Couldn't load launch progress: ${response.status}`, response.status),
		})
	).launchRun;
}

export async function fetchProcessLaunchRuns(
	instanceId: string,
): Promise<ProcessLaunchRunsResponseBody["launchRuns"]> {
	return (
		await requestJson<ProcessLaunchRunsResponseBody>({
			path: `/api/processes/${encodeURIComponent(instanceId)}/launch-runs`,
			malformed: "Malformed process launch runs response",
			error: (response) =>
				new ApiResponseError(`Couldn't load launch progress: ${response.status}`, response.status),
		})
	).launchRuns;
}

export async function startLaunchRun(
	launcherId: string,
	title: string | null,
	launcherInput: Record<string, unknown>,
	modelConfig: LauncherModelConfigDefaults = {},
	skillIds: readonly string[] = [],
): Promise<LauncherSubmitResult> {
	const response = await requestJson<StartLaunchRunResponseBody | LauncherSubmitResult>({
		path: `/api/launchers/${encodeURIComponent(launcherId)}/launch-runs`,
		init: {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": crypto.randomUUID(),
			},
			body: JSON.stringify({
				title,
				launcherInput,
				modelConfig,
				schedule: { mode: "now" },
				skillIds,
			}),
		},
		malformed: "Malformed launch run response",
		onError: (response, body) =>
			parseLauncherErrorResponse(response, "Couldn't start this process", body),
	});
	return "launchRunId" in response
		? { kind: "launch_started", launchRunId: response.launchRunId }
		: response;
}

export async function launchLauncher(
	launcherId: string,
	title: string | null,
	launcherInput: Record<string, unknown>,
	modelConfig: LauncherModelConfigDefaults = {},
	schedule: ScheduleConfigInput = { mode: "now" },
	skillIds: readonly string[] = [],
): Promise<LauncherSubmitResult> {
	if (schedule.mode === "now") {
		return startLaunchRun(launcherId, title, launcherInput, modelConfig, skillIds);
	}
	const res = await getFetchImpl()(
		resolveApiUrl(`/api/launchers/${encodeURIComponent(launcherId)}/future-launches`),
		jsonRequestInit("POST", { title, launcherInput, modelConfig, schedule, skillIds }),
	);
	if (!res.ok) {
		return parseLauncherErrorResponse(res, "Couldn't start this process", await tryReadJson(res));
	}
	const body = await readJsonObject<FutureLaunchMutationResponseBody>(
		res,
		"Malformed future launch response",
	);
	return body.futureExecution
		? { kind: "scheduled", futureExecution: body.futureExecution }
		: {
				kind: "failure",
				status: res.status,
				error: body.error ?? "The future launch response did not include the saved launch",
			};
}

export async function fetchProcessDiagnostics(instanceId: string): Promise<ProcessDiagnosticsData> {
	return requestStatusJson<ProcessDiagnosticsResponseBody>(
		`/api/processes/${encodeURIComponent(instanceId)}/diagnostics`,
		"Couldn't load this process",
		"Malformed process diagnostics response",
	);
}

export async function fetchPrimaryPathSnapshot(instanceId: string): Promise<PrimaryPathSnapshot> {
	return requestStatusJson<PrimaryPathSnapshotResponseBody>(
		`/api/processes/${encodeURIComponent(instanceId)}/primary-path`,
		"Couldn't load this process",
		"Malformed primary path snapshot response",
	);
}

export async function fetchProcessDetail(instanceId: string): Promise<ProcessDetailData> {
	return requestStatusJson(
		`/api/processes/${encodeURIComponent(instanceId)}/ui-snapshot`,
		"Couldn't load this process",
		"Malformed process UI snapshot response",
	);
}

export async function fetchTurnReasoningDetail(
	instanceId: string,
	turnRecordId: string,
	sessionSignature: string | null,
	signal?: AbortSignal,
): Promise<TurnReasoningDetailResponseBody> {
	const params = new URLSearchParams(sessionSignature === null ? {} : { sessionSignature });
	const res = await getFetchImpl()(
		resolveApiUrl(
			`/api/processes/${encodeURIComponent(instanceId)}/turn-records/${encodeURIComponent(turnRecordId)}/reasoning?${params.toString()}`,
		),
		{ signal },
	);
	if (res.status === 409) {
		throw new Error(
			"The process changed while reasoning details were loading. Retry with the latest snapshot.",
		);
	}
	if (!res.ok) throw new Error(`Couldn't load reasoning details: ${res.status}`);
	return readJsonObject<TurnReasoningDetailResponseBody>(
		res,
		"Malformed reasoning detail response",
	);
}

export async function fetchFutureExecution(
	futureExecutionId: string,
): Promise<FutureExecutionDetailResponseBody> {
	const res = await getFetchImpl()(
		resolveApiUrl(`/api/future-executions/${encodeURIComponent(futureExecutionId)}`),
	);
	if (!res.ok) {
		throw new ApiResponseError(`Couldn't load scheduled item: ${res.status}`, res.status);
	}
	return readJsonObject<FutureExecutionDetailResponseBody>(
		res,
		"Malformed scheduled item response",
	);
}

export async function postProcessRetry(
	instanceId: string,
	nextTurnModelProfileId?: string | null,
	providerOptions?: Readonly<Record<string, string>>,
): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/retry`,
		(response) => new Error(`Couldn't retry this process: ${response.status}`),
		jsonRequestInit("POST", { nextTurnModelProfileId, providerOptions }),
	);
}

export async function fetchModelProviderOptions(
	instanceId: string,
	modelProfileId: string,
): Promise<ModelProviderOptionsResponseBody> {
	const res = await getFetchImpl()(
		resolveApiUrl(
			`/api/processes/${encodeURIComponent(instanceId)}/model-profiles/${encodeURIComponent(modelProfileId)}/provider-options`,
		),
	);
	await requireSuccessfulResponse(res, "Couldn't load provider options");
	return (await res.json()) as ModelProviderOptionsResponseBody;
}

export async function postProcessTurnContinue(
	instanceId: string,
	turnRecordId: string,
	prompt?: string | null,
	nextTurnModelProfileId?: string | null,
	providerOptions?: Readonly<Record<string, string>>,
): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/turn-records/${encodeURIComponent(turnRecordId)}/continue`,
		"Couldn't continue this failed turn",
		jsonRequestInit("POST", { prompt, nextTurnModelProfileId, providerOptions }),
	);
}

export async function postProcessStartupRetry(
	instanceId: string,
	startRecordId: string,
	nextTurnModelProfileId?: string | null,
	providerOptions?: Readonly<Record<string, string>>,
): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/turn-starts/${encodeURIComponent(startRecordId)}/retry`,
		"Couldn't retry worker startup",
		jsonRequestInit("POST", { nextTurnModelProfileId, providerOptions }),
	);
}

export interface SessionTransferGrantResponse {
	transferUrl: string;
	expiresAt: string;
}

export async function createSessionTransferGrant(
	instanceId: string,
): Promise<SessionTransferGrantResponse> {
	return requestJson<SessionTransferGrantResponse>({
		path: `/api/processes/${encodeURIComponent(instanceId)}/session-transfers`,
		init: { method: "POST" },
		malformed: "Malformed transfer link response",
		error: "Couldn't create local transfer link",
	});
}

export async function cancelSessionTransfer(instanceId: string, attemptId: string): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/session-transfers/${encodeURIComponent(attemptId)}/cancel`,
		"Couldn't cancel the local session transfer",
		{ method: "POST" },
	);
}

export async function deleteProcess(instanceId: string): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}`,
		"Couldn't delete this process",
		{ method: "DELETE" },
	);
}

export async function postProcessAbort(instanceId: string): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/abort`,
		"Couldn't abort this process",
		{ method: "POST" },
	);
}

export async function postProcessAbortTurn(instanceId: string): Promise<void> {
	return requestMutation(
		`/api/processes/${encodeURIComponent(instanceId)}/abort-turn`,
		"Couldn't stop this turn",
		{ method: "POST" },
	);
}

export async function fetchProcessRetryConfig(instanceId: string): Promise<ProcessRetryConfig> {
	return requestStatusJson<ProcessRetryConfigResponseBody>(
		`/api/processes/${encodeURIComponent(instanceId)}/retry-config`,
		"Couldn't load retry config",
		"Malformed process retry config response",
	);
}

export type ProcessActionSubmitResult =
	| { kind: "success" }
	| { kind: "scheduled"; scheduledAction: ScheduledActionDetail | null };

export async function fetchProcessActionModelPreview(
	instanceId: string,
	actionId: string,
	input: Record<string, unknown> = {},
): Promise<ProcessActionModelPreview> {
	const body = await requestJson<ProcessActionModelPreviewResponseBody>({
		path: `/api/processes/${encodeURIComponent(instanceId)}/actions/${encodeURIComponent(actionId)}/model-preview`,
		init: jsonRequestInit("POST", { input }),
		error: "Couldn't refresh the action model preview",
		malformed: "Malformed process action model preview response",
	});
	return body.preview;
}

export async function postProcessAction(
	instanceId: string,
	actionId: string,
	input: Record<string, unknown> = {},
	opts: {
		nextTurnModelProfileId?: string | null;
		schedule?: ScheduleConfigInput;
	} = {},
): Promise<ProcessActionSubmitResult> {
	const body = await requestJson<ScheduledActionMutationResponseBody>({
		path: `/api/processes/${encodeURIComponent(instanceId)}/actions/${encodeURIComponent(actionId)}`,
		init: jsonRequestInit("POST", {
			input,
			schedule: opts.schedule ?? { mode: "now" },
			nextTurnModelProfileId: opts.nextTurnModelProfileId,
		}),
		error: `Couldn't run "${formatDefinition(actionId)}"`,
		malformed: "Malformed process action response",
	});
	if (body.scheduledAction) {
		return { kind: "scheduled", scheduledAction: body.scheduledAction };
	}
	return { kind: "success" };
}

export async function updateScheduledLaunch(
	futureExecutionId: string,
	title: string | null,
	launcherInput: Record<string, unknown>,
	modelConfig: LauncherModelConfigDefaults,
	schedule: ScheduleConfigInput,
	skillIds: readonly string[] = [],
): Promise<LauncherSubmitResult> {
	const res = await getFetchImpl()(
		resolveApiUrl(`/api/future-executions/${encodeURIComponent(futureExecutionId)}/launch`),
		jsonRequestInit("PUT", { title, launcherInput, modelConfig, schedule, skillIds }),
	);
	if (!res.ok) {
		return parseLauncherErrorResponse(
			res,
			"Couldn't update this scheduled launch",
			await tryReadJson(res),
		);
	}
	const body = await readJsonObject<LauncherMutationResponseBody>(
		res,
		"Malformed scheduled launch update response",
	);
	const projects = body.projects ?? [];
	const errorMessage = body.error ?? `Couldn't update this scheduled launch: ${res.status}`;
	if (body.futureExecution) {
		return { kind: "scheduled", futureExecution: body.futureExecution };
	}
	if (body.process) {
		return { kind: "success", process: body.process, projects };
	}
	const errors = body.errors ?? [];
	if (errors.length > 0) {
		return { kind: "validation_error", status: res.status, errors };
	}
	return { kind: "failure", status: res.status, error: errorMessage };
}

export async function updateScheduledAction(
	futureExecutionId: string,
	input: Record<string, unknown>,
	opts: {
		nextTurnModelProfileId?: string | null;
		schedule: ScheduleConfigInput;
	},
): Promise<ProcessActionSubmitResult> {
	const body = await requestJson<ScheduledActionMutationResponseBody>({
		path: `/api/future-executions/${encodeURIComponent(futureExecutionId)}/action`,
		init: jsonRequestInit("PUT", {
			input,
			schedule: opts.schedule,
			nextTurnModelProfileId: opts.nextTurnModelProfileId,
		}),
		error: "Couldn't update this scheduled action",
		malformed: "Malformed scheduled action update response",
	});
	if (body.scheduledAction) {
		return { kind: "scheduled", scheduledAction: body.scheduledAction };
	}
	return { kind: "success" };
}

export async function deleteFutureExecution(futureExecutionId: string): Promise<void> {
	return requestMutation(
		`/api/future-executions/${encodeURIComponent(futureExecutionId)}`,
		"Couldn't cancel this scheduled item",
		{ method: "DELETE" },
	);
}

export async function previewCronExpression(expression: string): Promise<string> {
	const body = await requestJson<CronPreviewResponseBody>({
		path: "/api/future-executions/cron-preview",
		init: jsonRequestInit("POST", { expression }),
		error: "Couldn't preview this cron",
		malformed: "Malformed cron preview response",
	});
	if (typeof body.nextRunAt !== "string") {
		throw new Error("Malformed cron preview response: nextRunAt must be a string");
	}
	return body.nextRunAt;
}
