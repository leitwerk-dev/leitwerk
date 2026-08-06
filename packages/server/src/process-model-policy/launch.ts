import {
	type LaunchModelConfigInput,
	normalizeLaunchModelConfigInput,
	parseStrictInstanceTurnConfigsJson,
	serializeInstanceTurnConfigs,
} from "@leitwerk-dev/domain";
import type {
	LaunchPlanPreparationIssue,
	LaunchPlanPreparationIssueCode,
	LaunchPlanPreparationResultLike,
	ProcessLaunchPlan,
} from "@leitwerk-dev/process-sdk";
import { resolveDefault, resolveTurn, validateSelection } from "./evaluate.js";
import { modelConfigurationFromLaunchInput } from "./input.js";
import type {
	PolicySnapshot,
	PrepareLaunchPlanOptions,
	ProcessModelPolicyEvaluation,
} from "./types.js";

type ModelTarget =
	| { readonly kind: "default_model" }
	| { readonly kind: "turn_model"; readonly turnId: string }
	| { readonly kind: "selected_turn_model"; readonly turnId: string | null };

function target(kind: ModelTarget["kind"], turnId?: string | null): ModelTarget {
	if (kind === "turn_model") return { kind, turnId: turnId ?? "" };
	if (kind === "selected_turn_model") return { kind, turnId: turnId ?? null };
	return { kind };
}

function targetLabel(modelTarget: ModelTarget): string {
	switch (modelTarget.kind) {
		case "default_model":
			return "default model";
		case "turn_model":
			return `turn '${modelTarget.turnId}'`;
		case "selected_turn_model":
			return modelTarget.turnId ? `selected turn '${modelTarget.turnId}'` : "selected turn model";
	}
}

function issue(code: LaunchPlanPreparationIssueCode, message: string): LaunchPlanPreparationIssue {
	return { code, message };
}

function mergeModelConfig(
	base: LaunchModelConfigInput,
	override: LaunchModelConfigInput,
): LaunchModelConfigInput {
	const normalizedBase = normalizeLaunchModelConfigInput(base);
	const normalizedOverride = normalizeLaunchModelConfigInput(override);
	const overrideTurnConfigs = normalizedOverride.turnConfigs ?? {};
	return {
		defaultModelProfileId:
			normalizedOverride.defaultModelProfileId ?? normalizedBase.defaultModelProfileId ?? null,
		turnConfigs:
			Object.keys(overrideTurnConfigs).length > 0
				? overrideTurnConfigs
				: (normalizedBase.turnConfigs ?? {}),
	};
}

function issueForPolicy(
	result: Exclude<ProcessModelPolicyEvaluation, { ok: true }>,
	processId: string,
	modelTarget: ModelTarget,
): LaunchPlanPreparationIssue {
	const profileId = result.selection?.modelProfileId ?? "";
	if (result.code === "unknown_model_profile") {
		return issue(
			result.code,
			`Unknown model profile '${profileId}' for ${targetLabel(modelTarget)}`,
		);
	}
	if (result.code === "model_profile_not_allowed") {
		return issue(
			result.code,
			`Model profile '${profileId}' is not allowed for process '${processId}' (${targetLabel(modelTarget)})`,
		);
	}
	const turnId = modelTarget.kind === "selected_turn_model" ? (modelTarget.turnId ?? "") : "";
	return issue("model_required", `A model is required for turn '${turnId}'`);
}

/** Validates, resolves, and sanitizes all model configuration carried by a launch plan. */
export function prepareLaunchPlan(
	snapshot: PolicySnapshot,
	launchPlan: ProcessLaunchPlan,
	opts: PrepareLaunchPlanOptions = {},
): LaunchPlanPreparationResultLike {
	if (launchPlan.processId !== launchPlan.processInput.processId) {
		return {
			ok: false,
			launchPlan,
			modelConfig: normalizeLaunchModelConfigInput(opts.modelConfig ?? {}),
			errors: [
				issue(
					"process_id_mismatch",
					`Launch plan process '${launchPlan.processId}' does not match input process '${launchPlan.processInput.processId}'`,
				),
			],
		};
	}

	const invalidMode = opts.invalidModelConfig ?? "reject";
	const warnings: LaunchPlanPreparationIssue[] = [];
	const errors: LaunchPlanPreparationIssue[] = [];
	const report = (issue: LaunchPlanPreparationIssue): void => {
		if (invalidMode === "reject") errors.push(issue);
		else warnings.push(issue);
	};
	const parsed = parseStrictInstanceTurnConfigsJson(
		launchPlan.processId,
		launchPlan.processInput.turnConfigsJson,
	);
	if (!parsed.ok) {
		const message =
			parsed.error.reason === "invalid_json"
				? "turnConfigsJson must be valid JSON"
				: parsed.error.reason === "not_object"
					? "turnConfigsJson must be an object"
					: `turnConfigsJson.${parsed.error.turnId ?? "<unknown>"} must be an object`;
		report(issue(parsed.error.code, message));
	}
	const baseConfig: LaunchModelConfigInput = {
		defaultModelProfileId: launchPlan.processInput.defaultModelProfileId ?? null,
		turnConfigs: parsed.ok ? parsed.value : {},
	};
	const normalized = normalizeLaunchModelConfigInput(
		mergeModelConfig(
			opts.replaceModelConfig ? { defaultModelProfileId: null, turnConfigs: {} } : baseConfig,
			opts.modelConfig ?? {},
		),
	);
	const policy = snapshot.processesById.get(launchPlan.processId);
	const llmTurns = policy?.llmTurnIds ?? new Set<string>();
	const validTurns: Record<string, { modelProfileId: string }> = {};
	let defaultModelProfileId = normalized.defaultModelProfileId ?? null;
	const modelIssue = (
		profileId: string | null,
		modelTarget: ModelTarget,
	): LaunchPlanPreparationIssue | null => {
		if (!profileId) return null;
		const result = validateSelection(snapshot, launchPlan.processId, {
			modelProfileId: profileId,
			provenance: { kind: "explicit", source: "instance_default" },
		});
		return result.ok ? null : issueForPolicy(result, launchPlan.processId, modelTarget);
	};
	const validate = (profileId: string | null, modelTarget: ModelTarget): boolean => {
		const issue = modelIssue(profileId, modelTarget);
		if (!issue) return true;
		report(issue);
		return false;
	};
	if (!validate(defaultModelProfileId, target("default_model"))) defaultModelProfileId = null;
	for (const [turnId, config] of Object.entries(normalized.turnConfigs ?? {})) {
		const profileId = config.modelProfileId?.trim() || null;
		if (!llmTurns.has(turnId)) {
			report(
				issue(
					"unknown_llm_turn",
					`Turn '${turnId}' is not a known LLM turn for process '${launchPlan.processId}'`,
				),
			);
			continue;
		}
		if (profileId && validate(profileId, target("turn_model", turnId))) {
			validTurns[turnId] = { modelProfileId: profileId };
		}
	}

	const selectedTurnId = launchPlan.startTurnId ?? launchPlan.processInput.selectedTurnId;
	const selectedProfileId = launchPlan.processInput.selectedTurnModelProfileId?.trim() || null;
	let selectedModelProfileId = selectedProfileId;
	const selectedTurnIssue: LaunchPlanPreparationIssue | null = !selectedProfileId
		? null
		: !selectedTurnId
			? issue(
					"selected_turn_model_requires_selected_turn",
					`Selected turn model profile '${selectedProfileId}' requires a selected turn`,
				)
			: !llmTurns.has(selectedTurnId)
				? issue(
						"selected_turn_model_requires_llm_turn",
						`Selected turn model profile '${selectedProfileId}' requires selected turn '${selectedTurnId}' to be an LLM turn`,
					)
				: modelIssue(selectedProfileId, target("selected_turn_model", selectedTurnId));
	if (selectedTurnIssue) {
		report(selectedTurnIssue);
		if (invalidMode !== "reject") selectedModelProfileId = null;
	}

	const modelConfig = { defaultModelProfileId, turnConfigs: validTurns };
	let initialDefaultModelProfileId = null;
	const configuration = modelConfigurationFromLaunchInput(launchPlan.processId, modelConfig);
	const defaultResult = resolveDefault(snapshot, configuration);
	if (defaultResult.ok)
		initialDefaultModelProfileId = defaultResult.selection?.modelProfileId ?? null;
	if (selectedTurnId && !selectedModelProfileId) {
		const turnResult = resolveTurn(
			snapshot,
			configuration,
			selectedTurnId,
			"resolve",
			{ kind: "none" },
			{ kind: "inherit" },
		);
		if (!turnResult.ok && turnResult.code === "model_required") {
			report(
				issueForPolicy(
					turnResult,
					launchPlan.processId,
					target("selected_turn_model", selectedTurnId),
				),
			);
		}
	}
	if (errors.length > 0) {
		const rejectedLaunchPlan = parsed.ok
			? {
					...launchPlan,
					processInput: {
						...launchPlan.processInput,
						defaultModelProfileId: normalized.defaultModelProfileId ?? null,
						turnConfigsJson: serializeInstanceTurnConfigs(normalized.turnConfigs ?? {}),
					},
				}
			: launchPlan;
		return { ok: false, launchPlan: rejectedLaunchPlan, modelConfig: normalized, errors };
	}
	return {
		ok: true,
		modelConfig,
		warnings,
		launchPlan: {
			...launchPlan,
			processInput: {
				...launchPlan.processInput,
				defaultModelProfileId,
				selectedTurnModelProfileId: selectedModelProfileId,
				selectedTurnModelKind: selectedModelProfileId ? "explicit" : null,
				selectedTurnModelSource: selectedModelProfileId ? "launch_override" : null,
				initialDefaultModelProfileId,
				turnConfigsJson: serializeInstanceTurnConfigs(validTurns),
			},
		},
	};
}
