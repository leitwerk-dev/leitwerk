import type { ProcessTurnRecordPathType, ProcessTurnType } from "@leitwerk-dev/domain";
import type {
	WorkerFailedPayload,
	WorkerLifecycleParkedPayload,
	WorkerStartPayload,
	WorkerTurnFailedPayload,
} from "@leitwerk-dev/worker-protocol";
import type { WorkerDiagnosticPayload } from "../diagnostics.js";
import { classifyRuntimeError, type TurnExecutionError } from "../turn-execution-error.js";
import type { WorkerRuntimeState } from "./lifecycle-reducer.js";
import type { WorkerSnapshotPoint } from "./snapshot-policy.js";

export interface WorkerFailureSessionContext {
	selectedTurnId: string | null;
	lifecycleStatus: string;
	snapshotSource: WorkerFailureSnapshotRequest["source"];
}

export interface WorkerTurnFailureCorrelation {
	turnRecordId: string;
	turnId: string;
	turnType?: ProcessTurnType;
	pathType?: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
}

export type WorkerFailure =
	| { kind: "bootstrap"; error: unknown; payload: WorkerStartPayload }
	| {
			kind: "turn";
			error: TurnExecutionError;
			correlation: WorkerTurnFailureCorrelation;
			session?: WorkerFailureSessionContext | null;
	  }
	| {
			kind: "mandatory_snapshot";
			error: unknown;
			point: WorkerSnapshotPoint;
			correlation: WorkerTurnFailureCorrelation;
			session?: WorkerFailureSessionContext | null;
	  }
	| {
			kind: "dispatch";
			error: unknown;
			state: WorkerRuntimeState;
			session: WorkerFailureSessionContext | null;
	  }
	| { kind: "cleanup"; error: unknown; session: WorkerFailureSessionContext | null }
	| { kind: "transport"; error: unknown };

export type WorkerFailureTerminal =
	| {
			kind: "turn_failed";
			payload: WorkerTurnFailedPayload;
			park: WorkerLifecycleParkedPayload;
	  }
	| { kind: "worker_failed"; payload: WorkerFailedPayload }
	| { kind: "park"; payload: WorkerLifecycleParkedPayload }
	| { kind: "transport_lost" };

export interface WorkerFailureSnapshotRequest {
	point: "before_worker_failed";
	source: {
		kind: "automatic" | "llm";
		treeFile: string;
	};
}

export interface WorkerFailureDisposition {
	diagnostic: WorkerDiagnosticPayload | null;
	stderrMessage: string;
	snapshot?: WorkerFailureSnapshotRequest;
	terminal: WorkerFailureTerminal;
	exitCode?: number;
}

export function extractSecretValuesFromPayload(
	payload: WorkerStartPayload | null | undefined,
): string[] {
	if (!payload) return [];
	const secrets = new Set<string>();
	if (payload.bootstrap.kind === "llm" && payload.bootstrap.credential?.values) {
		for (const value of Object.values(payload.bootstrap.credential.values)) {
			if (typeof value === "string" && value.trim() !== "") secrets.add(value.trim());
		}
	}
	return Array.from(secrets);
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
	let result = message;
	for (const secret of secrets) {
		if (secret) result = result.split(secret).join("<redacted>");
	}
	return result;
}

function bounded(message: string): string {
	return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

function errorCode(error: unknown, fallback: string): string {
	const code = (error as { code?: unknown })?.code;
	return typeof code === "string" && code.trim() !== "" ? code.trim() : fallback;
}

/** Pure normalization boundary for every failure owned by the worker runtime. */
export function normalizeWorkerFailure(failure: WorkerFailure): WorkerFailureDisposition {
	const secrets = extractSecretValuesFromPayload(
		failure.kind === "bootstrap" ? failure.payload : null,
	);
	const classified = classifyRuntimeError(failure.error, "infrastructure");
	const message = redactSecrets(classified.message, secrets);

	if (failure.kind === "transport") {
		return {
			diagnostic: null,
			stderrMessage: message,
			terminal: { kind: "transport_lost" },
			exitCode: 1,
		};
	}

	if (failure.kind === "turn" || failure.kind === "mandatory_snapshot") {
		const correlation = failure.correlation;
		const turnError = failure.kind === "turn" ? failure.error : null;
		const summary =
			failure.kind === "mandatory_snapshot"
				? `Mandatory session snapshot upload failed before ${failure.point}: ${message}`
				: (turnError?.message ?? message);
		const errorClass = turnError?.errorClass ?? classified.errorClass;
		const payload: WorkerTurnFailedPayload = {
			turnRecordId: correlation.turnRecordId,
			turnId: correlation.turnId,
			turnType: correlation.turnType ?? "llm",
			pathType: correlation.pathType ?? "primary",
			errorSummary: summary,
			errorClass,
			forkPiEntryId: correlation.forkPiEntryId ?? null,
			resultPiEntryId: correlation.resultPiEntryId ?? null,
			...(turnError?.failureCode ? { failureCode: turnError.failureCode } : {}),
			...(failure.kind === "mandatory_snapshot"
				? { failureDetails: { reason: failure.point } }
				: turnError?.failureDetails
					? { failureDetails: turnError.failureDetails }
					: {}),
			...(turnError?.recoveryContext ? { recoveryContext: turnError.recoveryContext } : {}),
		};
		return {
			diagnostic: {
				level: "error",
				code:
					failure.kind === "mandatory_snapshot"
						? "session_snapshot.upload_failed"
						: "turn.execution_failed",
				message:
					failure.kind === "mandatory_snapshot" ? summary : `Turn execution failed: ${summary}`,
				errorClass,
				turnRecordId: correlation.turnRecordId,
				turnId: correlation.turnId,
			},
			stderrMessage: summary,
			terminal: {
				kind: "turn_failed",
				payload,
				park: {
					selectedTurnId: failure.session?.selectedTurnId ?? correlation.turnId,
					reason: summary,
					errorClass,
				},
			},
		};
	}

	if (failure.kind === "bootstrap") {
		const summary = `Worker bootstrap failed: ${message}`;
		return {
			diagnostic: {
				level: "error",
				code: "bootstrap.failed",
				message: summary,
				errorClass: "infrastructure",
			},
			stderrMessage: summary,
			snapshot: {
				point: "before_worker_failed",
				source: {
					kind: failure.payload.bootstrap.kind,
					treeFile: failure.payload.treePaths.primaryTreeFile,
				},
			},
			terminal: {
				kind: "worker_failed",
				payload: {
					state: "bootstrapping",
					errorCode: errorCode(failure.error, "bootstrap_failed"),
					message: bounded(summary),
					errorClass: "infrastructure",
					selectedTurnId: failure.payload.processSnapshot.selectedTurnId ?? null,
				},
			},
			exitCode: 1,
		};
	}

	const { session } = failure;
	const isCleanup = failure.kind === "cleanup";
	const summary = `${isCleanup ? "Worker cleanup failed" : "Worker dispatch failed"}: ${message}`;
	const diagnostic: WorkerDiagnosticPayload = {
		level: "error",
		code: isCleanup ? "cleanup.failed" : "runtime.dispatch_failed",
		message: summary,
		errorClass: classified.errorClass,
	};
	if (failure.kind === "dispatch" && session && session.lifecycleStatus !== "error") {
		return {
			diagnostic,
			stderrMessage: message,
			terminal: {
				kind: "park",
				payload: {
					selectedTurnId: session.selectedTurnId,
					reason: message,
					errorClass: classified.errorClass,
				},
			},
		};
	}

	return {
		diagnostic,
		stderrMessage: summary,
		...(session
			? {
					snapshot: {
						point: "before_worker_failed" as const,
						source: session.snapshotSource,
					},
				}
			: {}),
		terminal: {
			kind: "worker_failed",
			payload: {
				state: isCleanup ? "cleanup" : failure.state,
				errorCode: isCleanup ? "cleanup_failed" : "runtime_dispatch_failed",
				message: bounded(message),
				errorClass: classified.errorClass,
				selectedTurnId: session?.selectedTurnId ?? null,
			},
		},
		exitCode: 1,
	};
}
