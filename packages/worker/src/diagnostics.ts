import type { WorkerErrorClass } from "@leitwerk-dev/domain";

export type WorkerDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface WorkerDiagnosticPayload {
	level: WorkerDiagnosticLevel;
	code: string;
	message: string;
	timestamp?: string;
	turnRecordId?: string | null;
	turnId?: string | null;
	errorClass?: WorkerErrorClass;
	details?: Record<string, unknown>;
	truncated?: boolean;
}

export type WorkerOperationEmission =
	| { kind: "trace" | "error"; payload: WorkerDiagnosticPayload }
	| { kind: "session_tainted"; reason: string };

export type WorkerOperationEmitter = (emission: WorkerOperationEmission) => void;

const MAX_MESSAGE_LENGTH = 1000;
const MAX_DETAILS_LENGTH = 8_000;

function truncateString(value: string, maxLength: number): { value: string; truncated: boolean } {
	if (value.length <= maxLength) {
		return { value, truncated: false };
	}
	return {
		value: `${value.slice(0, Math.max(0, maxLength - 1))}…`,
		truncated: true,
	};
}

function sanitizeDetails(value: Record<string, unknown> | undefined): {
	details: Record<string, unknown> | undefined;
	truncated: boolean;
} {
	if (!value) {
		return { details: undefined, truncated: false };
	}

	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return {
			details: { serializationError: true },
			truncated: true,
		};
	}

	const truncated = truncateString(serialized, MAX_DETAILS_LENGTH);
	if (!truncated.truncated) {
		return { details: value, truncated: false };
	}

	return {
		details: { truncatedJson: truncated.value },
		truncated: true,
	};
}

export function buildWorkerDiagnosticPayload(
	input: WorkerDiagnosticPayload,
): Record<string, unknown> {
	const message = truncateString(input.message, MAX_MESSAGE_LENGTH);
	const details = sanitizeDetails(input.details);
	const truncated = message.truncated || details.truncated || input.truncated === true;
	return {
		level: input.level,
		code: input.code,
		message: message.value,
		...(input.timestamp ? { timestamp: input.timestamp } : {}),
		...(input.turnRecordId !== undefined ? { turnRecordId: input.turnRecordId } : {}),
		...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
		...(input.errorClass ? { errorClass: input.errorClass } : {}),
		...(details.details ? { details: details.details } : {}),
		...(truncated ? { truncated: true } : {}),
	};
}
