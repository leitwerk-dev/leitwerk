import { type ProcessInstance, parseStrictInstanceTurnConfigsJson } from "@leitwerk-dev/domain";
import type { ProcessModelConfigPatch } from "@leitwerk-dev/protocol/http-contracts";
import type {
	ProcessModelAvailabilitySnapshot,
	ServerProcessModelPolicy,
} from "./process-model-policy/index.js";
import {
	presentProcessModelConfiguration,
	presentProcessModelPolicyFailure,
} from "./process-model-policy-presenter.js";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function profile(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && value.trim().length > 0);
}
/** Parse sparse input without dropping explicit clears. @internal */
export function parseProcessModelConfigPatch(value: unknown): ProcessModelConfigPatch {
	if (
		!record(value) ||
		Object.keys(value).some((key) => key !== "defaultModelProfileId" && key !== "turnConfigs")
	)
		throw new Error("Expected defaultModelProfileId and/or turnConfigs");
	const patch: ProcessModelConfigPatch = {};
	if (Object.hasOwn(value, "defaultModelProfileId")) {
		if (!profile(value.defaultModelProfileId))
			throw new Error("defaultModelProfileId must be a profile ID or null");
		patch.defaultModelProfileId = value.defaultModelProfileId?.trim() ?? null;
	}
	if (Object.hasOwn(value, "turnConfigs")) {
		if (!record(value.turnConfigs)) throw new Error("turnConfigs must be an object");
		patch.turnConfigs = Object.fromEntries(
			Object.entries(value.turnConfigs).map(([id, config]) => {
				if (!record(config) || Object.keys(config).length !== 1 || !profile(config.modelProfileId))
					throw new Error(`Step '${id}' requires modelProfileId as a profile ID or null`);
				return [id, { modelProfileId: config.modelProfileId?.trim() ?? null }];
			}),
		);
	}
	return patch;
}

/** Shared preview/save validation and sparse merge against the latest persisted settings. @internal */
export function prepareProcessModelConfig(input: {
	process: ProcessInstance;
	patch: ProcessModelConfigPatch;
	policy: ServerProcessModelPolicy;
	availability: ProcessModelAvailabilitySnapshot;
}) {
	const { process, policy, availability } = input;
	const patch = parseProcessModelConfigPatch(input.patch);
	if (process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted")
		throw new Error("Completed and aborted processes have read-only model settings");
	const parsed = parseStrictInstanceTurnConfigsJson(process.processId, process.turnConfigsJson);
	if (!parsed.ok)
		throw new Error("Saved model configuration is malformed and must be repaired before editing");
	const current = policy.project({ kind: "process_configuration", process, availability });
	const turns = new Map(current.turns.map((turn) => [turn.turnId, turn]));
	const turnConfigs = { ...parsed.value };
	for (const [id, config] of Object.entries(patch.turnConfigs ?? {})) {
		const turn = turns.get(id);
		if (!turn) throw new Error(`Step '${id}' is unknown or does not use a model`);
		if (turn.fixedModelProfileId) throw new Error(`Step '${id}' uses a fixed system model`);
		if (config.modelProfileId === null) delete turnConfigs[id];
		else turnConfigs[id] = { ...turnConfigs[id], modelProfileId: config.modelProfileId };
	}
	const selections = [
		patch.defaultModelProfileId,
		...Object.values(patch.turnConfigs ?? {}).map((config) => config.modelProfileId),
	];
	for (const id of selections) {
		if (!id) continue;
		const validation = policy.evaluate({
			kind: "runtime_selection",
			processId: process.processId,
			availability,
			selection: {
				modelProfileId: id,
				provenance: { kind: "explicit", source: "instance_default" },
			},
		});
		if (!validation.ok) throw new Error(presentProcessModelPolicyFailure(validation));
	}
	const settings = {
		defaultModelProfileId: Object.hasOwn(patch, "defaultModelProfileId")
			? (patch.defaultModelProfileId ?? null)
			: process.defaultModelProfileId,
		turnConfigsJson: Object.hasOwn(patch, "turnConfigs")
			? JSON.stringify(turnConfigs)
			: process.turnConfigsJson,
	};
	const candidate = { ...process, ...settings };
	return {
		settings,
		modelConfiguration: presentProcessModelConfiguration(
			policy.project({ kind: "process_configuration", process: candidate, availability }),
		),
	};
}
