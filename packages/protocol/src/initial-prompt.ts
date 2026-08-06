import type { FutureExecutionOverviewItem, FutureExecutionSummary } from "./http-contracts.js";

// Best-effort extraction of an operator-facing prompt/command from launch params
// for compact overview and detail read models. Process launchers use several
// established field names; keep this priority list shared so server and browser
// projections cannot drift.
export const INITIAL_PROMPT_FIELD_PRIORITY = [
	"initialPrompt",
	"prompt",
	"taskPrompt",
	"userPrompt",
	"instructions",
	"instruction",
	"initialCommand",
	"command",
	"query",
	"message",
	"requestedChange",
	"request",
	"description",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePromptValue(value: string): string | null {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

export function truncatePromptPreview(
	value: string | null | undefined,
	maxLength = 180,
): string | null {
	const normalized = typeof value === "string" ? normalizePromptValue(value) : null;
	return normalized && normalized.length > maxLength
		? `${normalized.slice(0, maxLength).trimEnd()}…`
		: normalized;
}

function readStringField(record: Record<string, unknown>, fieldName: string): string | null {
	const exact = record[fieldName];
	if (typeof exact === "string") {
		return normalizePromptValue(exact);
	}

	const normalizedFieldName = fieldName.toLowerCase();
	for (const [key, value] of Object.entries(record)) {
		if (key.toLowerCase() !== normalizedFieldName || typeof value !== "string") {
			continue;
		}
		return normalizePromptValue(value);
	}

	return null;
}

export function extractInitialPromptFromValue(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}

	for (const fieldName of INITIAL_PROMPT_FIELD_PRIORITY) {
		const prompt = readStringField(value, fieldName);
		if (prompt) {
			return prompt;
		}
	}

	return null;
}

export function extractInitialPromptFromParamsJson(
	paramsJson: string | null | undefined,
): string | null {
	if (!paramsJson) {
		return null;
	}

	try {
		return extractInitialPromptFromValue(JSON.parse(paramsJson));
	} catch {
		return null;
	}
}

export function extractInitialPromptPreviewFromParamsJson(
	paramsJson: string | null | undefined,
	maxLength = 180,
): string | null {
	return truncatePromptPreview(extractInitialPromptFromParamsJson(paramsJson), maxLength);
}

export function projectFutureExecutionOverview(
	summary: FutureExecutionSummary,
): FutureExecutionOverviewItem {
	const common = {
		id: summary.id,
		scheduleKind: summary.scheduleKind,
		processId: summary.processId,
		nextRunAt: summary.nextRunAt,
		cronExpression: summary.cronExpression,
		title: summary.title,
		status: summary.status ?? "scheduled",
		blockedReason: summary.blockedReason ?? null,
		initialPromptPreview:
			summary.kind === "launch"
				? truncatePromptPreview(extractInitialPromptFromValue(summary.launcherInput))
				: null,
	};
	return summary.kind === "action"
		? {
				...common,
				kind: "action",
				instanceId: summary.instanceId,
				actionId: summary.actionId,
				actionLabel: summary.actionLabel,
			}
		: {
				...common,
				kind: "launch",
				instanceId: null,
				launcherId: summary.launcherId,
				launcherLabel: summary.launcherLabel,
			};
}
