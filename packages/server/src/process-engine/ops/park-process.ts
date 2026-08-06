import { buildParkProcessWrites } from "../../process-engine/writes/build-process-park-writes.js";
import { accept } from "../decision.js";
import { defineOperation } from "../operation.js";
import type { ParkProcessLifecyclePayload } from "../types.js";

export interface ParkProcessInput {
	instanceId: string;
	payload: ParkProcessLifecyclePayload;
}

export const ParkProcess = defineOperation<"park_process", ParkProcessInput, void>({
	kind: "park_process",
	label: "Park process",
	decide(ctx, input) {
		const writes = buildParkProcessWrites(ctx.process, input.payload, {
			allowInactiveLifecycle: true,
		});
		return "ok" in writes ? writes : accept({ writes });
	},
});
