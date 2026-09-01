import type { WsFrame } from "@leitwerk-dev/protocol";

type LaunchUpdatedFrame = Extract<WsFrame, { type: "launch.updated" }>;
type Listener = (frame: LaunchUpdatedFrame) => void;

const listeners = new Set<Listener>();

export function dispatchLaunchUpdated(frame: WsFrame): boolean {
	if (frame.type !== "launch.updated") return false;
	for (const listener of listeners) listener(frame as LaunchUpdatedFrame);
	return true;
}

export function onLaunchUpdated(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
