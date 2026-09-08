import type {
	ProcessInstance,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import { PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES } from "@leitwerk-dev/protocol";
import {
	buildPrimaryPathSnapshotFromTree,
	type PrimaryPathSnapshotProjectionInput,
} from "../primary-path-snapshot.js";
import type { ProcessSessionTreeReadResult } from "../process-session-store.js";
import {
	mergeProcessEventWindowsAscending,
	PRIMARY_PATH_ACTIVE_TURN_EVENT_LIMIT,
	type RouteDeps,
} from "./process-route-helpers.js";

export type CapturedPrimaryPathState = PrimaryPathSnapshotProjectionInput;

export class ProcessPrimaryPathAssembler {
	constructor(private readonly deps: RouteDeps) {}

	capture(
		instanceId: string,
		overrides: {
			process?: ProcessInstance;
			turnRecords?: readonly ProcessTurnRecord[];
			turnAnnotations?: readonly ProcessTurnAnnotation[];
			workerLease?: PrimaryPathSnapshotProjectionInput["workerLease"];
		} = {},
	): CapturedPrimaryPathState | null {
		const process = overrides.process ?? this.deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		const turnRecords = overrides.turnRecords ?? this.deps.turnRecords.listByInstance(process.id);
		const currentTurnRecordId =
			process.currentExecution?.kind === "worker_start"
				? (() => {
						const start = this.deps.turnStarts.getById(process.currentExecution.id);
						return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
					})()
				: null;
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
			workerLease:
				overrides.workerLease !== undefined
					? overrides.workerLease
					: this.deps.leases.getByInstance(process.id),
			turnRecords,
			turnAnnotations:
				overrides.turnAnnotations ?? this.deps.turnAnnotations.listByInstance(process.id),
			events,
			eventWindowTruncated,
		};
	}

	project(captured: CapturedPrimaryPathState, session: ProcessSessionTreeReadResult) {
		return buildPrimaryPathSnapshotFromTree({
			...captured,
			tree: session.parsedTree,
		});
	}

	async assemble(instanceId: string) {
		const captured = this.capture(instanceId);
		if (!captured) {
			return null;
		}
		const session = await this.deps.sessionReader.readSessionTree(instanceId);
		return this.project(captured, session);
	}
}
