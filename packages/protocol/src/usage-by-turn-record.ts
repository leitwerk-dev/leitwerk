import type { ProcessEvent } from "@leitwerk-dev/domain";
import {
	mergeUsageSnapshots,
	normalizeUsageSnapshot,
	type UsageSnapshot,
} from "./usage-snapshot.js";
import { asWsEventPayloadRecord, readWsEventTurnRecordId } from "./ws-event-payloads.js";

/** @internal */
export type UsageSnapshotByTurnRecordId = Record<string, UsageSnapshot>;

/** @internal */
export function buildUsageSnapshotsByTurnRecordId(
	events: readonly ProcessEvent[],
): UsageSnapshotByTurnRecordId {
	const snapshots: UsageSnapshotByTurnRecordId = {};
	for (const event of events) {
		if (event.eventType !== "pi.usage") {
			continue;
		}
		const payload = asWsEventPayloadRecord(event.data);
		const turnRecordId = readWsEventTurnRecordId(payload);
		if (!turnRecordId) {
			continue;
		}
		const usage = normalizeUsageSnapshot(payload);
		if (!usage) {
			continue;
		}
		const merged = mergeUsageSnapshots(snapshots[turnRecordId] ?? null, usage);
		if (merged) {
			snapshots[turnRecordId] = merged;
		}
	}
	return snapshots;
}
