import * as v from "valibot";
import { trimToNull } from "./string-normalize.js";

export interface InstanceTurnConfigInput {
	modelProfileId?: string | null;
}

export type InstanceTurnConfigMap = Record<string, InstanceTurnConfigInput>;

export interface LaunchModelConfigInput {
	defaultModelProfileId?: string | null;
	turnConfigs?: InstanceTurnConfigMap;
}

export interface InstanceTurnConfigsJsonError {
	code: "invalid_turn_configs_json";
	processId: string;
	reason: "invalid_json" | "not_object" | "turn_config_not_object";
	turnId?: string;
}

const jsonObjectSchema = v.custom<Record<string, unknown>>(
	(value): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value),
	"Expected object",
);

const instanceTurnConfigSchema = v.pipe(
	jsonObjectSchema,
	v.object({
		modelProfileId: v.optional(v.unknown()),
	}),
);

const strictInstanceTurnConfigsJsonSchema = v.pipe(
	v.string(),
	v.parseJson(),
	jsonObjectSchema,
	v.record(v.string(), instanceTurnConfigSchema),
);

function normalizeInstanceTurnConfigs(
	turnConfigs: Record<string, { modelProfileId?: unknown }>,
): InstanceTurnConfigMap {
	const next: InstanceTurnConfigMap = {};
	for (const [turnId, turnConfig] of Object.entries(turnConfigs)) {
		const modelProfileId = trimToNull(turnConfig.modelProfileId);
		next[turnId] = modelProfileId ? { modelProfileId } : {};
	}
	return next;
}

function getFirstIssuePathKey(issue: v.BaseIssue<unknown>): string | undefined {
	const pathItem = issue.path?.[0] as { key?: unknown } | undefined;
	return typeof pathItem?.key === "string" ? pathItem.key : undefined;
}

export function parseStrictInstanceTurnConfigsJson(
	processId: string,
	turnConfigsJson: string | null | undefined,
): { ok: true; value: InstanceTurnConfigMap } | { ok: false; error: InstanceTurnConfigsJsonError } {
	if (!turnConfigsJson) return { ok: true, value: {} };
	const result = v.safeParse(strictInstanceTurnConfigsJsonSchema, turnConfigsJson, {
		abortEarly: true,
	});
	if (!result.success) {
		const issue = result.issues[0];
		if (issue?.type === "parse_json") {
			return {
				ok: false,
				error: { code: "invalid_turn_configs_json", processId, reason: "invalid_json" },
			};
		}
		const turnId = issue ? getFirstIssuePathKey(issue) : undefined;
		return {
			ok: false,
			error: {
				code: "invalid_turn_configs_json",
				processId,
				reason: turnId !== undefined ? "turn_config_not_object" : "not_object",
				...(turnId !== undefined ? { turnId } : {}),
			},
		};
	}
	return { ok: true, value: normalizeInstanceTurnConfigs(result.output) };
}

export function serializeInstanceTurnConfigs(turnConfigs: InstanceTurnConfigMap): string | null {
	const normalizedEntries = Object.entries(turnConfigs)
		.map(([turnId, turnConfig]) => {
			const modelProfileId = trimToNull(turnConfig.modelProfileId);
			return [turnId, modelProfileId ? { modelProfileId } : {}] as const;
		})
		.filter(([, turnConfig]) => Object.keys(turnConfig).length > 0);
	return normalizedEntries.length === 0
		? null
		: JSON.stringify(Object.fromEntries(normalizedEntries));
}

export function normalizeLaunchModelConfigInput(
	input: LaunchModelConfigInput,
): LaunchModelConfigInput {
	const defaultModelProfileId = trimToNull(input.defaultModelProfileId);
	const nextTurnConfigs: InstanceTurnConfigMap = {};
	for (const [turnId, turnConfig] of Object.entries(input.turnConfigs ?? {})) {
		const modelProfileId = trimToNull(turnConfig.modelProfileId);
		if (modelProfileId) nextTurnConfigs[turnId] = { modelProfileId };
	}
	return { defaultModelProfileId, turnConfigs: nextTurnConfigs };
}
