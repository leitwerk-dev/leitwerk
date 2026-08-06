import type {
	ServerToWorkerMessage,
	WorkerQuestionRequestedPayload,
} from "@leitwerk-dev/worker-protocol";
import type { WorkerQuestionRequest } from "./question-tool.js";
import type { WorkerIpcReporter } from "./worker-ipc-reporter.js";

interface PendingQuestion {
	payload: WorkerQuestionRequestedPayload;
	resolve(answers: string[]): void;
	reject(error: Error): void;
	removeAbort(): void;
}

export class WorkerQuestionBridge {
	private readonly pending = new Map<string, PendingQuestion>();

	constructor(private readonly reporter: WorkerIpcReporter) {}

	request(request: WorkerQuestionRequest): Promise<string[]> {
		if (this.pending.has(request.toolCallId)) {
			return Promise.reject(new Error("Duplicate in-flight question request"));
		}
		const payload: WorkerQuestionRequestedPayload = {
			turnRecordId: request.turnRecordId,
			toolCallId: request.toolCallId,
			questions: request.questions,
		};
		return new Promise<string[]>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(request.toolCallId);
				reject(new Error("Question request cancelled because the turn stopped"));
			};
			request.signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(request.toolCallId, {
				payload,
				resolve,
				reject,
				removeAbort: () => request.signal.removeEventListener("abort", onAbort),
			});
			this.emit(payload);
		});
	}

	handle(message: Extract<ServerToWorkerMessage, { type: "worker.question_response" }>): boolean {
		const pending = this.pending.get(message.payload.toolCallId);
		if (!pending || pending.payload.turnRecordId !== message.payload.turnRecordId) return false;
		this.pending.delete(message.payload.toolCallId);
		pending.removeAbort();
		pending.resolve([...message.payload.answers]);
		return true;
	}

	replay(): void {
		for (const pending of this.pending.values()) this.emit(pending.payload);
	}

	cancelAll(reason: string): void {
		for (const pending of this.pending.values()) {
			pending.removeAbort();
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}

	private emit(payload: WorkerQuestionRequestedPayload): void {
		this.reporter.project({ kind: "protocol", type: "worker.question_requested", payload });
	}
}
