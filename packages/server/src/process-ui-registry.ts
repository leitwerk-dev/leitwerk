import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ProcessLeafOutcomeDefinition } from "@leitwerk-dev/process-sdk";
import { buildUiProcessDefinition } from "@leitwerk-dev/process-sdk";

export interface ProcessUiRegistry {
	getLeafOutcomeDefinition(processId: string): ProcessLeafOutcomeDefinition | undefined;
}

export function buildProcessUiRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
): ProcessUiRegistry {
	const leafOutcomes = new Map<string, ProcessLeafOutcomeDefinition>();
	for (const [processId, processDef] of catalog.processes) {
		const leafOutcome = buildUiProcessDefinition(processDef)?.leafOutcome;
		if (leafOutcome) leafOutcomes.set(processId, leafOutcome);
	}

	return {
		getLeafOutcomeDefinition(processId) {
			return leafOutcomes.get(processId);
		},
	};
}
