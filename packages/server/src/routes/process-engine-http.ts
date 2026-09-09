import type { FastifyReply } from "fastify";
import {
	isInternalEngineFailureCode,
	publicInternalEngineFailureMessage,
} from "../process-engine/internal-failures.js";
import type { EngineFailure } from "../process-engine/types.js";

export type ProcessEngineRouteVariant = "steer" | "abort" | "abort-turn" | "retry" | "continue";

export interface ProcessEngineHttpFailure {
	status: number;
	body: Record<string, unknown>;
}

export function mapEngineFailure<T>(
	result: EngineFailure<T>,
	variant: ProcessEngineRouteVariant,
): ProcessEngineHttpFailure {
	if (isInternalEngineFailureCode(result.code)) {
		return {
			status: 500,
			body: {
				error: publicInternalEngineFailureMessage(result.code, result.stage),
				code: result.code,
			},
		};
	}

	if (result.code === "process_not_found") {
		return {
			status: 404,
			body: { error: result.message },
		};
	}
	if (result.code === "session_transfer_in_progress") {
		return {
			status: 409,
			body: { error: result.message, code: result.code },
		};
	}

	switch (variant) {
		case "steer":
			if (result.code === "input_dispatch_failed") {
				return { status: 503, body: { error: result.message } };
			}
			break;
		case "abort":
			if (result.code === "worker_reconcile_failed") {
				return {
					status: 503,
					body: {
						error: "Process was aborted, but the worker could not be stopped cleanly",
						process: result.process,
					},
				};
			}
			break;
		case "abort-turn":
			if (result.code === "worker_supervisor_unavailable") {
				return { status: 503, body: { error: result.message } };
			}
			if (result.code === "worker_unavailable") {
				return { status: 409, body: { error: result.message } };
			}
			if (result.code === "worker_reconcile_failed") {
				return {
					status: 503,
					body: {
						error: "Turn abort request was recorded, but the worker could not be signaled",
						process: result.process,
					},
				};
			}
			break;
		case "retry":
		case "continue":
			if (result.code === "worker_reconcile_failed") {
				return {
					status: 503,
					body: {
						error: "Process was reactivated, but the worker could not be started cleanly",
						process: result.process,
					},
				};
			}
			break;
	}
	return {
		status: 400,
		body: { error: result.message, code: result.code },
	};
}

export function sendEngineFailure<T>(
	reply: FastifyReply,
	result: EngineFailure<T>,
	variant: ProcessEngineRouteVariant,
) {
	const failure = mapEngineFailure(result, variant);
	return reply.code(failure.status).send(failure.body);
}
