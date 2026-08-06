import { randomUUID } from "node:crypto";
import type { ProcessInstance } from "@leitwerk-dev/domain";

export function resolveTurnRecordIdForExecution(
	process: Pick<ProcessInstance, "selectedTurnId">,
	turnId: string,
	acceptedTurnRecordId?: string | null,
): string {
	if (
		process.selectedTurnId === turnId &&
		typeof acceptedTurnRecordId === "string" &&
		acceptedTurnRecordId.trim() !== ""
	) {
		return acceptedTurnRecordId;
	}
	return `trn_${randomUUID().replace(/-/g, "")}`;
}
