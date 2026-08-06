import { createHash } from "node:crypto";
import type { PolicySnapshot, ProcessModelPolicyFingerprintSubject } from "./types.js";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonical(child)]),
	);
}

export function fingerprintPolicy(
	snapshot: PolicySnapshot,
	request: ProcessModelPolicyFingerprintSubject,
): string {
	const start = request.currentStart;
	const prepared =
		start.state.kind === "starting" ||
		start.state.kind === "accepted" ||
		start.state.kind === "bootstrap_failed"
			? { ...start.state.start, availabilityRevision: undefined }
			: null;
	const material = canonical({
		version: 3,
		workerStaticConfig: snapshot.workerStaticConfig,
		process: {
			id: request.process.id,
			processId: request.process.processId,
			selectedTurnId: request.process.selectedTurnId,
		},
		start: {
			id: start.id,
			turnId: start.turnId,
			turnType: start.turnType,
			proposedTurnRecordId: start.proposedTurnRecordId,
			startKind: start.startKind,
			recoveryTurnRecordId: start.recoveryTurnRecordId,
			continuation: start.continuation,
			prepared,
		},
	});
	return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}
