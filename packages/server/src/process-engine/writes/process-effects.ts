import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ProcessLifecycleEffects } from "@leitwerk-dev/process-sdk";
import type { Writes } from "./writes.js";

export function appendProcessEffects(
	writes: Writes,
	process: ProcessInstance,
	effects: ProcessLifecycleEffects,
) {
	for (const [field, value] of Object.entries(effects.processPatch ?? {})) {
		const key = field as keyof typeof writes.processPatch;
		if ((process as unknown as Record<string, unknown>)[field] === value) {
			continue;
		}
		(writes.processPatch as Record<string, unknown>)[key] = value;
		if (!writes.changedFields.includes(field)) {
			writes.changedFields.push(field);
		}
	}

	for (const broadcast of effects.broadcasts ?? []) {
		writes.broadcasts.push({
			type: broadcast.type,
			payload: broadcast.payload,
			instanceId: process.id,
		} as never);
	}
}
