import { type ProcessInstance, trimToNull } from "@leitwerk-dev/domain";
import { existingTurnSelectionFromProcess, modelConfigurationFromProcess } from "./input.js";
import type {
	PersistedModelIntegrity,
	PersistedModelIntegrityIssue,
	PolicySnapshot,
} from "./types.js";

/**
 * Inspects only durable encoding and relational invariants. Catalog membership,
 * allowlists, provider availability, and credentials are deliberately excluded:
 * those are properties of the current server configuration, not persisted data.
 */
export function inspectPersistedModelIntegrity(
	snapshot: PolicySnapshot,
	process: ProcessInstance,
): PersistedModelIntegrity {
	const issues: PersistedModelIntegrityIssue[] = [];
	const configuration = modelConfigurationFromProcess(process);
	if (configuration.kind === "invalid") {
		issues.push(...configuration.issues);
	} else {
		const llmTurnIds = snapshot.processesById.get(process.processId)?.llmTurnIds ?? new Set();
		for (const turnId of configuration.turnProfileIds.keys()) {
			if (!llmTurnIds.has(turnId)) {
				issues.push({ code: "model_config_requires_llm_turn", turnId });
			}
		}
	}

	const selectedProfileId = trimToNull(process.selectedTurnModelProfileId);
	if (selectedProfileId) {
		if (!process.selectedTurnId) {
			const isPendingLaunchSelection =
				process.lifecycleStatus === "discovered" &&
				process.planRevision === 0 &&
				process.selectedTurnModelKind === "explicit" &&
				process.selectedTurnModelSource === "launch_override";
			if (!isPendingLaunchSelection)
				issues.push({
					code: "selected_model_requires_selected_turn",
					modelProfileId: selectedProfileId,
				});
		} else {
			const llmTurnIds = snapshot.processesById.get(process.processId)?.llmTurnIds ?? new Set();
			if (!llmTurnIds.has(process.selectedTurnId)) {
				issues.push({
					code: "selected_model_requires_llm_turn",
					turnId: process.selectedTurnId,
					modelProfileId: selectedProfileId,
				});
			} else {
				const selection = existingTurnSelectionFromProcess(process);
				if (selection.kind === "invalid") issues.push(...selection.issues);
			}
		}
	}

	return issues.length === 0 ? { kind: "valid" } : { kind: "malformed", issues };
}
