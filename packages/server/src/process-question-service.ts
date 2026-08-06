import {
	type Actor,
	canonicalizeQuestionAnswers,
	type ProcessQuestionRequest,
	type QuestionAnswerDraft,
} from "@leitwerk-dev/domain";
import { WS_PROCESS_TYPES } from "@leitwerk-dev/protocol";
import type {
	WorkerQuestionRequestedPayload,
	WorkerQuestionResponsePayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessOperationCoordinator } from "./process-operation-coordinator.js";
import type { Broadcaster } from "./ws/broadcast.js";

type ProcessQuestionRepos = Pick<
	RepositoryBundle,
	"events" | "leases" | "processes" | "questionRequests" | "transaction" | "turnRecords"
>;

function isCurrentRequest(repos: ProcessQuestionRepos, request: ProcessQuestionRequest): boolean {
	const process = repos.processes.getById(request.instanceId);
	const turn = repos.turnRecords.getById(request.turnRecordId);
	const lease = repos.leases.getByInstance(request.instanceId);
	return Boolean(
		process?.lifecycleStatus === "active" &&
			turn?.status === "running" &&
			lease &&
			turn?.acceptedWorkerLeaseId === lease.id,
	);
}

export function createProcessQuestionService(input: {
	repos: ProcessQuestionRepos;
	processOperations: ProcessOperationCoordinator;
	broadcaster: Broadcaster;
	getWorkerId: (instanceId: string) => string | null;
	sendQuestionResponse: (
		instanceId: string,
		workerId: string,
		payload: WorkerQuestionResponsePayload,
	) => void;
	emitQuestionRequested?: (request: ProcessQuestionRequest) => void | Promise<void>;
}) {
	const sendResponse = (instanceId: string, workerId: string, request: ProcessQuestionRequest) => {
		if (!request.answers) return;
		input.sendQuestionResponse(instanceId, workerId, {
			turnRecordId: request.turnRecordId,
			toolCallId: request.toolCallId,
			answers: [...request.answers],
		});
	};
	return {
		listOpen: (instanceId?: string) => input.repos.questionRequests.listOpen(instanceId),
		async handleWorkerRequest(
			instanceId: string,
			workerLeaseId: string,
			workerId: string,
			payload: WorkerQuestionRequestedPayload,
		) {
			const result = await input.processOperations.runExclusive(instanceId, () =>
				input.repos.transaction((repos) => {
					const process = repos.processes.getById(instanceId);
					const turn = repos.turnRecords.getById(payload.turnRecordId);
					if (
						process?.lifecycleStatus !== "active" ||
						!turn ||
						turn.instanceId !== instanceId ||
						turn.status !== "running" ||
						turn.acceptedWorkerLeaseId !== workerLeaseId
					) {
						return null;
					}
					const result = repos.questionRequests.createIdempotent({
						instanceId,
						turnRecordId: payload.turnRecordId,
						toolCallId: payload.toolCallId,
						questions: payload.questions,
					});
					if (result.kind === "created") {
						repos.events.create({
							instanceId,
							eventType: "question_requested",
							data: { requestId: result.request.id, turnRecordId: result.request.turnRecordId },
						});
					}
					return result;
				}),
			);
			if (!result) return;
			if (result.request.status === "answered") {
				sendResponse(instanceId, workerId, result.request);
				return;
			}
			if (result.kind === "replay") return;
			input.broadcaster.sendDurable(
				"process.event",
				{
					eventType: "question_requested",
					level: "info",
					message: "Operator answers requested",
				},
				instanceId,
			);
			await input.emitQuestionRequested?.(result.request);
			input.broadcaster.sendEphemeral(
				WS_PROCESS_TYPES.TOAST,
				{
					instanceId,
					level: "warn",
					message: "The active turn is waiting for your answers.",
					eventType: "question_requested",
					dedupeKey: `question-request:${result.request.id}`,
					ttlMs: 10_000,
					focusTarget: { kind: "question_request", requestId: result.request.id },
				},
				instanceId,
			);
		},
		async submitAnswers(
			instanceId: string,
			requestId: string,
			draftInput: readonly QuestionAnswerDraft[],
			actor: Actor,
		) {
			try {
				const result = await input.processOperations.runExclusive(instanceId, () =>
					input.repos.transaction((repos) => {
						const request = repos.questionRequests.getById(requestId);
						if (!request || request.instanceId !== instanceId) {
							return {
								ok: false as const,
								code: "not_found" as const,
								message: "Question request not found",
							};
						}
						if (request.status !== "open" || !isCurrentRequest(repos, request)) {
							return {
								ok: false as const,
								code: "not_current" as const,
								message: "Question request is no longer active",
								request,
							};
						}
						const answered = repos.questionRequests.answer({
							id: request.id,
							answers: canonicalizeQuestionAnswers(request.questions, draftInput),
							actor,
						});
						if (!answered) {
							return {
								ok: false as const,
								code: "not_current" as const,
								message: "Question request was answered elsewhere",
								request: repos.questionRequests.getById(request.id) ?? request,
							};
						}
						repos.events.create({
							instanceId,
							eventType: "question_answered",
							data: { requestId: request.id, actorId: actor.id },
						});
						return { ok: true as const, request: answered };
					}),
				);
				if (!result.ok) return result;
				const workerId = input.getWorkerId(instanceId);
				if (workerId) sendResponse(instanceId, workerId, result.request);
				input.broadcaster.sendDurable(
					"process.event",
					{ eventType: "question_answered", level: "info", message: "Answers sent" },
					instanceId,
				);
				return result;
			} catch (error) {
				return {
					ok: false as const,
					code: "invalid" as const,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}

export type ProcessQuestionService = ReturnType<typeof createProcessQuestionService>;
