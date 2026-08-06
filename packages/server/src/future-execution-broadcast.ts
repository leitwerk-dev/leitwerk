import type { FutureExecution } from "@leitwerk-dev/domain";
import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { Broadcaster } from "./ws/broadcast.js";

export function broadcastFutureExecutionUpdated(
	broadcaster: Broadcaster,
	futureExecution: Pick<FutureExecution, "id" | "kind" | "instanceId">,
	operation: "created" | "updated" | "deleted",
): void {
	broadcaster.broadcast(
		createDurableWsFrame({
			type: "future.updated",
			payload: {
				futureExecutionId: futureExecution.id,
				operation,
				kind: futureExecution.kind,
			},
			...(futureExecution.instanceId ? { instanceId: futureExecution.instanceId } : {}),
		}),
	);
}
