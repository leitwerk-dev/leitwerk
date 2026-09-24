import { PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES } from "@leitwerk-dev/protocol";
import {
	buildPrimaryPathSnapshotFromTree,
	type PrimaryPathSnapshotProjectionInput,
} from "../primary-path-snapshot.js";
import { resolveCurrentExecutionTurnRecordId } from "../process-execution.js";
import {
	mergeProcessEventWindowsAscending,
	PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT,
	type RouteDeps,
} from "./process-route-helpers.js";

type ProcessPrimaryPathDeps = Pick<
	RouteDeps,
	| "processes"
	| "turnRecords"
	| "turnStarts"
	| "events"
	| "leases"
	| "turnAnnotations"
	| "sessionReader"
>;

export class ProcessPrimaryPathAssembler {
	constructor(private readonly deps: ProcessPrimaryPathDeps) {}

	private capture(instanceId: string): PrimaryPathSnapshotProjectionInput | null {
		const process = this.deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		const turnRecords = this.deps.turnRecords.listByInstance(process.id);
		const currentTurnRecordId = resolveCurrentExecutionTurnRecordId(process, this.deps.turnStarts);
		const activeTurnRecord = currentTurnRecordId
			? turnRecords.find(
					(turnRecord) => turnRecord.id === currentTurnRecordId && turnRecord.status === "running",
				)
			: null;
		const rawActiveTurnEvents = activeTurnRecord
			? this.deps.events.listByInstanceSince(process.id, activeTurnRecord.startedAt, {
					limit: PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT + 1,
					eventTypePrefix: "pi.",
				})
			: [];
		const retainedOperationalEvents = activeTurnRecord
			? this.deps.events.listByInstanceSinceEventTypes(
					process.id,
					activeTurnRecord.startedAt,
					PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
					1_000,
				)
			: [];
		const eventWindowTruncated = rawActiveTurnEvents.length > PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT;
		const events = mergeProcessEventWindowsAscending([
			rawActiveTurnEvents.slice(0, PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT),
			retainedOperationalEvents,
		]);
		return {
			process,
			currentExecutionTurnRecordId: currentTurnRecordId,
			workerLease: this.deps.leases.getByInstance(process.id),
			turnRecords,
			turnAnnotations: this.deps.turnAnnotations.listByInstance(process.id),
			events,
			eventWindowTruncated,
		};
	}

	async assemble(instanceId: string) {
		const captured = this.capture(instanceId);
		if (!captured) {
			return null;
		}
		const session = await this.deps.sessionReader.readSessionTree(instanceId);
		return buildPrimaryPathSnapshotFromTree({ ...captured, tree: session.parsedTree });
	}
}
