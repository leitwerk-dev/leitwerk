import type { ProcessTurnTransition } from "@leitwerk-dev/domain";
import type { ProcessTurnBinding } from "./extension-api.js";

interface ProcessDefinitionInternalRegistry {
	definedProcesses: WeakSet<object>;
	turnTransitions: WeakMap<object, readonly ProcessTurnTransition[]>;
}

const registryKey = Symbol.for("@leitwerk-dev/process-sdk/internal-registry");
const registryHolder = globalThis as typeof globalThis & {
	[registryKey]?: ProcessDefinitionInternalRegistry;
};
if (!registryHolder[registryKey]) {
	registryHolder[registryKey] = {
		definedProcesses: new WeakSet<object>(),
		turnTransitions: new WeakMap<object, readonly ProcessTurnTransition[]>(),
	};
}
const registry = registryHolder[registryKey];

export function markDefinedProcess(value: object): void {
	registry.definedProcesses.add(value);
}

export function isDefinedProcess(value: unknown): boolean {
	return typeof value === "object" && value !== null && registry.definedProcesses.has(value);
}

export function setProcessTurnTransitions(
	binding: object,
	transitions: readonly ProcessTurnTransition[],
): void {
	registry.turnTransitions.set(
		binding,
		transitions.map((transition) => ({ ...transition })),
	);
}

export function getProcessTurnTransitions(
	binding: ProcessTurnBinding<unknown> | undefined,
): readonly ProcessTurnTransition[] {
	if (!binding) {
		return [];
	}
	return registry.turnTransitions.get(binding)?.map((transition) => ({ ...transition })) ?? [];
}
