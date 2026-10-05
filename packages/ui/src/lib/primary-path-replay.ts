import {
	compareTimestampStrings,
	type PrimaryPathUiSnapshot,
	type PrimaryPathWsFrame,
} from "@leitwerk-dev/protocol";
import { applyPrimaryPathFrame } from "./primary-path-detail.js";

export function shouldReplayPrimaryPathFrameAfterSnapshot(
	frame: Pick<PrimaryPathWsFrame, "sentAt" | "eventSequence">,
	snapshot: Pick<PrimaryPathUiSnapshot, "rebuiltAt" | "throughEventSequence">,
): boolean {
	if (frame.eventSequence !== undefined) return frame.eventSequence > snapshot.throughEventSequence;
	return compareTimestampStrings(frame.sentAt, snapshot.rebuiltAt) > 0;
}

export function replayPrimaryPathFramesAfterSnapshot(
	snapshot: PrimaryPathUiSnapshot,
	frames: readonly PrimaryPathWsFrame[],
): PrimaryPathUiSnapshot {
	let nextSnapshot = structuredClone(snapshot);
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
