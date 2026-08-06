import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ProcessLeafOutcomeDefinition } from "@leitwerk-dev/process-sdk";
import { type BuiltUiProcessDefinition, buildUiProcessDefinition } from "@leitwerk-dev/process-sdk";

export interface ProcessUiRegistry {
	getUiDefinition(processId: string): BuiltUiProcessDefinition | undefined;
	hasLeafOutcome(processId: string): boolean;
	getLeafOutcomeDefinition(processId: string): ProcessLeafOutcomeDefinition | undefined;
}

export function buildProcessUiRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
): ProcessUiRegistry {
	const uiDefinitions = new Map<string, BuiltUiProcessDefinition>();

	for (const [processId, processDef] of catalog.processes) {
		const definition = buildUiProcessDefinition(processDef);
		if (definition) {
			uiDefinitions.set(processId, definition);
		}
	}

	return {
		getUiDefinition(processId) {
			return uiDefinitions.get(processId);
		},
		hasLeafOutcome(processId) {
			return uiDefinitions.get(processId)?.leafOutcome != null;
		},
		getLeafOutcomeDefinition(processId) {
			return uiDefinitions.get(processId)?.leafOutcome ?? undefined;
		},
	};
}
