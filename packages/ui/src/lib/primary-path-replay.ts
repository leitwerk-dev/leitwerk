import {
	compareTimestampStrings,
	type PrimaryPathSnapshot,
	type PrimaryPathWsFrame,
} from "@leitwerk-dev/protocol";
import { applyPrimaryPathFrame, clonePrimaryPathSnapshot } from "./primary-path-detail.js";

export function shouldReplayPrimaryPathFrameAfterSnapshot(
	frame: Pick<PrimaryPathWsFrame, "sentAt">,
	snapshot: Pick<PrimaryPathSnapshot, "rebuiltAt">,
): boolean {
	return compareTimestampStrings(frame.sentAt, snapshot.rebuiltAt) > 0;
}

export function replayPrimaryPathFramesAfterSnapshot<TSnapshot extends PrimaryPathSnapshot>(
	snapshot: TSnapshot,
	frames: readonly PrimaryPathWsFrame[],
): TSnapshot {
	let nextSnapshot = clonePrimaryPathSnapshot(snapshot);
	for (const frame of frames) {
		if (!shouldReplayPrimaryPathFrameAfterSnapshot(frame, nextSnapshot)) {
			continue;
		}
		nextSnapshot = applyPrimaryPathFrame(nextSnapshot, frame);
	}
	return nextSnapshot;
}
