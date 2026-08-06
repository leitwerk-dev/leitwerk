import type { WorkerStartPayload } from "@leitwerk-dev/worker-protocol";

export type LlmWorkerStartPayload = Extract<WorkerStartPayload, { configSnapshot: unknown }>;

/** Correlates the nested bootstrap discriminant with the containing payload variant. */
export function isLlmWorkerStartPayload(
	payload: WorkerStartPayload,
): payload is LlmWorkerStartPayload {
	return payload.bootstrap.kind === "llm";
}
