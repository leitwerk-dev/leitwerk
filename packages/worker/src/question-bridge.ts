import type {
	ServerToWorkerMessage,
	WorkerQuestionRequestedPayload,
} from "@leitwerk-dev/worker-protocol";
import type { WorkerQuestionRequest } from "./question-tool.js";
import { ReplayingRequestBridge } from "./replaying-request-bridge.js";
import type { WorkerIpcReporter } from "./worker-ipc-reporter.js";

type QuestionResponse = Extract<
	ServerToWorkerMessage,
	{ type: "worker.question_response" }
>["payload"];

export class WorkerQuestionBridge {
	private readonly bridge: ReplayingRequestBridge<
		WorkerQuestionRequestedPayload,
		QuestionResponse,
		string[]
	>;

	constructor(reporter: WorkerIpcReporter) {
		this.bridge = new ReplayingRequestBridge(
			(payload) =>
				reporter.project({ kind: "protocol", type: "worker.question_requested", payload }),
			(payload) => [...payload.answers],
		);
	}

	request(request: WorkerQuestionRequest): Promise<string[]> {
		return this.bridge.request(
			{
				turnRecordId: request.turnRecordId,
				toolCallId: request.toolCallId,
				questions: request.questions,
			},
			request.signal,
			"Question request cancelled because the turn stopped",
		);
	}

	handle(message: Extract<ServerToWorkerMessage, { type: "worker.question_response" }>): boolean {
		return this.bridge.handle(message.payload);
	}

	replay(): void {
		this.bridge.replay();
	}

	cancelAll(reason: string): void {
		this.bridge.cancelAll(reason);
	}
}
