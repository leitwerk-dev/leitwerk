import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { CreateProcessEventInput } from "../db/process-event-repo.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { Broadcaster } from "../ws/broadcast.js";

export function recordWorkerLifecycleEvent(
	deps: Pick<RepositoryBundle, "events"> & { broadcaster: Broadcaster },
	{ level, message, ...event }: CreateProcessEventInput & { level: string; message: string },
): void {
	deps.events.create(event);
	deps.broadcaster.broadcast(
		createDurableWsFrame({
			type: "process.event",
			instanceId: event.instanceId,
			payload: { eventType: event.eventType, level, message },
		}),
	);
}
