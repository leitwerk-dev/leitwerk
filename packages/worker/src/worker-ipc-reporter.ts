import { randomUUID } from "node:crypto";
import type { WorkerToServerMessage } from "@leitwerk-dev/worker-protocol";
import { createIpcMessage } from "@leitwerk-dev/worker-protocol";
import { buildWorkerDiagnosticPayload, type WorkerDiagnosticPayload } from "./diagnostics.js";

type WorkerMessageType = WorkerToServerMessage["type"];
type Payload<T extends WorkerMessageType> = Extract<WorkerToServerMessage, { type: T }>["payload"];

export interface WorkerProtocolFact<T extends WorkerMessageType = WorkerMessageType> {
	kind: "protocol";
	type: T;
	payload: Payload<T>;
}

export interface WorkerIpcReporter {
	project(fact: WorkerProtocolFact): void;
	workerEvent(
		eventType: string,
		data: Record<string, unknown>,
		selectedTurnId?: string | null,
	): Extract<WorkerToServerMessage, { type: "worker.event" }>["payload"];
	workerTrace(input: WorkerDiagnosticPayload, selectedTurnId?: string | null): void;
	workerError(input: WorkerDiagnosticPayload, selectedTurnId?: string | null): void;
}

const EXTENSION_FACTS = new Set<WorkerMessageType>([
	"worker.state",
	"worker.ready",
	"worker.turn_started",
	"worker.turn_outcome",
	"worker.turn_failed",
	"worker.lifecycle_parked",
	"worker.input_consumed",
	"worker.cleanup_started",
	"worker.cleanup_completed",
	"worker.failed",
]);

/** Envelopes protocol-ready facts and preserves IPC-before-extension ordering. */
export function createWorkerIpcReporter(options: {
	instanceId: string;
	workerId: string;
	now(): Date;
	send(message: WorkerToServerMessage): void;
	emitExtensionEvent?(event: string, payload: unknown): void;
}): WorkerIpcReporter {
	const project = (fact: WorkerProtocolFact): void => {
		options.send(
			createIpcMessage({
				type: fact.type,
				messageId: randomUUID(),
				instanceId: options.instanceId,
				workerId: options.workerId,
				sentAt: options.now().toISOString(),
				payload: fact.payload,
			} as never) as WorkerToServerMessage,
		);
		if (EXTENSION_FACTS.has(fact.type)) options.emitExtensionEvent?.(fact.type, fact.payload);
	};
	const workerEvent = (
		eventType: string,
		data: Record<string, unknown>,
		selectedTurnId: string | null = null,
	) => {
		const payload = {
			eventType,
			selectedTurnId,
			data: {
				...data,
				timestamp:
					typeof data.timestamp === "string" && data.timestamp.trim() !== ""
						? data.timestamp
						: options.now().toISOString(),
			},
		};
		project({ kind: "protocol", type: "worker.event", payload });
		options.emitExtensionEvent?.("worker.event", payload);
		return payload;
	};
	return {
		project,
		workerEvent,
		workerTrace(input, selectedTurnId = null) {
			const payload = workerEvent(
				"worker.trace",
				buildWorkerDiagnosticPayload(input),
				selectedTurnId,
			);
			options.emitExtensionEvent?.("worker.trace", payload);
		},
		workerError(input, selectedTurnId = null) {
			const payload = workerEvent(
				"worker.error",
				buildWorkerDiagnosticPayload(input),
				selectedTurnId,
			);
			options.emitExtensionEvent?.("worker.error", payload);
		},
	};
}
