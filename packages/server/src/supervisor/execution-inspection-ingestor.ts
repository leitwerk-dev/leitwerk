import type { ExecutionInspectionCapture } from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "../db/repositories.js";

/** Accepted execution ownership is checked before retaining any expanded evidence. */
export function ingestExecutionInspection(
	deps: Pick<RepositoryBundle, "executionInspections" | "turnRecords" | "leases">,
	input: { instanceId: string; workerId: string; turnRecordId: string; capture: unknown },
): boolean {
	const record = deps.turnRecords.getById(input.turnRecordId);
	const lease = deps.leases.getByInstance(input.instanceId);
	if (
		!record ||
		record.instanceId !== input.instanceId ||
		record.status !== "running" ||
		!record.turnStartRecordId ||
		!lease ||
		lease.workerId !== input.workerId ||
		lease.turnStartRecordId !== record.turnStartRecordId ||
		lease.exitedAt !== null
	)
		return false;
	const capture = input.capture as ExecutionInspectionCapture | null;
	if (
		!capture ||
		capture.version !== 1 ||
		typeof capture.id !== "string" ||
		!capture.id ||
		typeof capture.timestamp !== "string" ||
		!capture.fact ||
		!["model_input", "supplied_context", "product_consumed", "entry_link"].includes(
			capture.fact.kind,
		)
	)
		return false;
	if (capture.fact.kind === "supplied_context") {
		for (const product of capture.fact.products) {
			const producer = deps.turnRecords.getById(product.producerTurnRecordId);
			if (
				!producer ||
				producer.instanceId !== input.instanceId ||
				producer.resultPiEntryId !== product.entryId
			)
				return false;
		}
	}
	deps.executionInspections.append({
		...capture,
		id: `${input.turnRecordId}:${capture.id}`,
		instanceId: input.instanceId,
		turnRecordId: record.id,
		startRecordId: record.turnStartRecordId,
		workerLeaseId: lease.id,
	});
	return true;
}
