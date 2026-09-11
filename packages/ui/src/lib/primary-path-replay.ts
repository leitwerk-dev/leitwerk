import {
	compareTimestampStrings,
	type PrimaryPathSnapshot,
	type PrimaryPathUiSnapshot,
	type PrimaryPathWsFrame,
} from "@leitwerk-dev/protocol";
import { applyPrimaryPathFrame, clonePrimaryPathSnapshot } from "./primary-path-detail.js";

export function shouldReplayPrimaryPathFrameAfterSnapshot(
	frame: Pick<PrimaryPathWsFrame, "sentAt" | "eventSequence">,
	snapshot: Pick<PrimaryPathSnapshot, "rebuiltAt"> & { throughEventSequence?: number },
): boolean {
	if (frame.eventSequence !== undefined && snapshot.throughEventSequence !== undefined)
		return frame.eventSequence > snapshot.throughEventSequence;
	return compareTimestampStrings(frame.sentAt, snapshot.rebuiltAt) > 0;
}

export function replayPrimaryPathFramesAfterSnapshot<
	TSnapshot extends PrimaryPathSnapshot | PrimaryPathUiSnapshot,
>(snapshot: TSnapshot, frames: readonly PrimaryPathWsFrame[]): TSnapshot {
	let nextSnapshot = clonePrimaryPathSnapshot(snapshot);
	for (const frame of [...frames].sort((a, b) =>
		a.eventSequence !== undefined && b.eventSequence !== undefined
			? a.eventSequence - b.eventSequence
			: compareTimestampStrings(a.sentAt, b.sentAt),
	)) {
		if (!shouldReplayPrimaryPathFrameAfterSnapshot(frame, nextSnapshot)) {
			continue;
		}
		nextSnapshot = applyPrimaryPathFrame(nextSnapshot, frame);
	}
	return nextSnapshot;
}
