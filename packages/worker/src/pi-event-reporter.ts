import { translatePiEvent } from "./event-translator.js";
import type { PiEvent, PiSessionDiagnostic, PiTreeHandle } from "./pi-adapter.js";
import type { WorkerIpcReporter } from "./worker-ipc-reporter.js";

export interface PiEventReporter {
	attach(piHandle: PiTreeHandle): void;
	resetRetryState(): void;
}

export interface PiEventReporterOptions {
	reporter: Pick<WorkerIpcReporter, "workerEvent" | "workerTrace" | "workerError">;
	emitExtensionEvent?(event: string, payload: unknown): void;
	getCurrentSelectedTurnId?(): string | null;
	getSessionTainted?(): boolean;
	onLifecycleObservation?(kind: "pi_turn_started" | "pi_turn_ended"): void;
}

function readPiEventString(data: Record<string, unknown>, key: string): string | null {
	const value = data[key];
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readPiEventNumber(data: Record<string, unknown>, key: string): number | null {
	const value = data[key];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

export function createPiEventReporter(options: PiEventReporterOptions): PiEventReporter {
	let currentPiAttempt = 1;
	let currentPiMaxAttempts: number | null = null;

	const resetPiRetryState = () => {
		currentPiAttempt = 1;
		currentPiMaxAttempts = null;
	};

	const reportPiError = (event: PiEvent) => {
		const message =
			readPiEventString(event.data, "message") ??
			readPiEventString(event.data, "errorMessage") ??
			"Pi reported an error";
		const toolName = readPiEventString(event.data, "toolName");
		const source = readPiEventString(event.data, "source");
		const provider = readPiEventString(event.data, "provider");
		const model = readPiEventString(event.data, "model");
		const stopReason = readPiEventString(event.data, "stopReason");
		options.reporter.workerError({
			level: "error",
			code: toolName || source === "tool" ? "pi.tool_error" : "pi.request_failed",
			message,
			timestamp: event.timestamp,
			turnId: event.turnId,
			errorClass: toolName || source === "tool" ? "infrastructure" : "llm_error",
			details: {
				attempt: currentPiAttempt,
				...(currentPiMaxAttempts !== null ? { maxAttempts: currentPiMaxAttempts } : {}),
				...(source ? { source } : {}),
				...(toolName ? { toolName } : {}),
				...(provider ? { provider } : {}),
				...(model ? { model } : {}),
				...(stopReason ? { stopReason } : {}),
			},
		});
	};

	const reportPiRetryLifecycle = (event: PiEvent) => {
		const attempt = readPiEventNumber(event.data, "attempt");
		const maxAttempts = readPiEventNumber(event.data, "maxAttempts");
		const delayMs = readPiEventNumber(event.data, "delayMs");
		const errorMessage = readPiEventString(event.data, "errorMessage");
		const finalError = readPiEventString(event.data, "finalError");
		const message =
			readPiEventString(event.data, "message") ??
			(event.type === "retry.start"
				? "Pi scheduled an automatic retry"
				: event.data.success === true
					? "Pi retry sequence succeeded"
					: "Pi retry sequence ended");
		const success = event.data.success === true;
		options.reporter.workerTrace({
			level: event.type === "retry.end" && success ? "info" : "warn",
			timestamp: event.timestamp,
			code:
				event.type === "retry.start"
					? "pi.retry_scheduled"
					: success
						? "pi.retry_succeeded"
						: "pi.retry_exhausted",
			message,
			turnId: event.turnId,
			details: {
				...(attempt !== null ? { attempt } : {}),
				...(maxAttempts !== null ? { maxAttempts } : {}),
				...(delayMs !== null ? { delayMs } : {}),
				...(errorMessage ? { errorMessage } : {}),
				...(finalError ? { finalError } : {}),
			},
		});
		if (maxAttempts !== null) {
			currentPiMaxAttempts = maxAttempts;
		}
		if (event.type === "retry.start" && attempt !== null) {
			currentPiAttempt = Math.max(currentPiAttempt, attempt + 1);
		}
		if (event.type === "retry.end" && success) {
			resetPiRetryState();
		}
	};

	const reportPiDiagnostic = (diagnostic: PiSessionDiagnostic) => {
		options.reporter.workerTrace({
			level: diagnostic.level,
			code: diagnostic.code,
			message: diagnostic.message,
			timestamp: diagnostic.timestamp,
			...(diagnostic.turnId ? { turnId: diagnostic.turnId } : {}),
			...(diagnostic.details ? { details: diagnostic.details } : {}),
		});
	};

	return {
		attach(piHandle) {
			piHandle.subscribe((event) => {
				if (event.type === "turn.start") {
					options.onLifecycleObservation?.("pi_turn_started");
					resetPiRetryState();
				}
				if (event.type === "turn.end") {
					options.onLifecycleObservation?.("pi_turn_ended");
					resetPiRetryState();
				}
				if (event.type === "error") {
					reportPiError(event);
				}
				if (event.type === "retry.start" || event.type === "retry.end") {
					reportPiRetryLifecycle(event);
				}
				if (options.getSessionTainted?.()) return;
				const translated = translatePiEvent(event, options.getCurrentSelectedTurnId?.() ?? null);
				const payload = options.reporter.workerEvent(
					translated.eventType,
					translated.data,
					translated.selectedTurnId,
				);
				options.emitExtensionEvent?.("worker.pi_event", payload);
			});
			piHandle.subscribeDiagnostics?.((diagnostic) => {
				reportPiDiagnostic(diagnostic);
			});
		},
		resetRetryState() {
			resetPiRetryState();
		},
	};
}
