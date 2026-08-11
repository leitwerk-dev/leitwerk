import type { Actor, QuestionAnswerDraft } from "@leitwerk-dev/domain";
import { createTestQuestion } from "@leitwerk-dev/test-support/fixtures";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createProcessQuestionService } from "../process-question-service.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { registerProcessQuestionRoutes } from "./process-questions.js";
import type { RouteDeps } from "./process-route-helpers.js";

const apps: ReturnType<typeof Fastify>[] = [];
const actor: Actor = { id: "operator-1", kind: "user", provider: "oidc" };

function createHarness() {
	const deps = createTestDeps();
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
	});
	const turn = deps.turnRecords.create({
		id: `trn_${process.id}`,
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "llm",
		status: "running",
	});
	const request = deps.questionRequests.createIdempotent({
		instanceId: process.id,
		turnRecordId: turn.id,
		toolCallId: "tool-questions",
		questions: [
			createTestQuestion({
				options: [
					{ id: "question_1_option_1", label: "Safe", details: "Small change" },
					{ id: "question_1_option_2", label: "Bold", details: null },
				],
			}),
		],
	}).request;
	const questionResponse = vi.fn();
	const worker = { workerId: "worker-current", instanceId: process.id };
	const app = Fastify();
	apps.push(app);
	const processOperations = createProcessOperationCoordinator();
	const processQuestions = createProcessQuestionService({
		repos: deps,
		processOperations,
		broadcaster: deps.broadcaster,
		getWorkerId: () => worker.workerId,
		sendQuestionResponse: questionResponse,
	});
	app.addHook("preHandler", async (req) => {
		req.actor = actor;
	});
	registerProcessQuestionRoutes(app, {
		...deps,
		processOperations,
		processQuestions,
		supervisor: {
			getWorker: () => worker,
			questionResponse,
		},
	} as unknown as RouteDeps);
	const draft = (optionId = "question_1_option_1"): QuestionAnswerDraft[] => [
		{
			selectedOptionIds: [optionId],
			freeText: "",
			comment: "Prefer the smaller change",
		},
	];
	return { app, deps, process, request, draft, questionResponse };
}

afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("process question routes", () => {
	it("accepts the first submission, attributes it, and rejects later submissions", async () => {
		const h = createHarness();
		const url = `/api/processes/${h.process.id}/question-requests/${h.request.id}/answers`;

		const accepted = await h.app.inject({ method: "POST", url, payload: { draft: h.draft() } });
		const repeated = await h.app.inject({
			method: "POST",
			url,
			payload: { draft: h.draft("question_1_option_2") },
		});

		expect(accepted.statusCode).toBe(200);
		expect(accepted.json().request).toMatchObject({
			status: "answered",
			answers: ["Safe\nContext: Prefer the smaller change"],
			answeredBy: actor,
		});
		expect(repeated.statusCode).toBe(409);
		expect(h.questionResponse).toHaveBeenCalledTimes(1);
		expect(h.questionResponse).toHaveBeenCalledWith(
			h.process.id,
			"worker-current",
			expect.objectContaining({
				turnRecordId: h.request.turnRecordId,
				toolCallId: h.request.toolCallId,
				answers: accepted.json().request.answers,
			}),
		);
	});

	it("does not expose a request through another process id", async () => {
		const h = createHarness();
		const other = h.deps.processes.create({ processId: "ticket_issue_process" });

		const response = await h.app.inject({
			method: "POST",
			url: `/api/processes/${other.id}/question-requests/${h.request.id}/answers`,
			payload: { draft: h.draft() },
		});

		expect(response.statusCode).toBe(404);
		expect(h.deps.questionRequests.getById(h.request.id)).toMatchObject({ status: "open" });
		expect(h.questionResponse).not.toHaveBeenCalled();
	});
});
