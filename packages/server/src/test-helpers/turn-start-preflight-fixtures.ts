import type { ProcessEngineDeps } from "../process-engine/types.js";

export interface SuccessfulLlmTurnStartOptions {
	profileId?: string;
	providerId?: string;
	modelId?: string;
	thinkingLevel?: string;
	piResourceSnapshotDigest?: string;
	workerRuntimeProfileId?: string;
}

/** Creates a preflight double that successfully prepares every new LLM turn start. */
export function prepareSuccessfulLlmTurnStarts(
	options: SuccessfulLlmTurnStartOptions = {},
): NonNullable<ProcessEngineDeps["prepareTurnStarts"]> {
	return async (_current, writes) => {
		let prepared = false;
		for (const write of writes.turnStartWrites) {
			if (write.kind !== "create" || write.input.turnType !== "llm") continue;
			prepared = true;
			write.input.state = {
				kind: "starting",
				start: {
					kind: "llm",
					model: {
						profileId: options.profileId ?? "fixture-profile",
						providerId: options.providerId ?? "fixture-provider",
						modelId: options.modelId ?? "fixture-model",
						thinkingLevel: options.thinkingLevel ?? "off",
					},
					providerOptions: {},
					providerWorkerConfig: null,
					piResourceSnapshotDigest: options.piResourceSnapshotDigest ?? "fixture-resource-digest",
					workerRuntimeProfileId: options.workerRuntimeProfileId ?? "local",
					piSettings: {},
				},
			};
		}
		if (prepared) {
			writes.processPatch.lifecycleStatus = "active";
			writes.workerIntent = { kind: "restart_worker" };
		}
		return { ok: true };
	};
}
