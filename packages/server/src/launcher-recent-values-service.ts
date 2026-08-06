import {
	DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT,
	normalizeLauncherRecentValue,
} from "@leitwerk-dev/domain";
import {
	findUiLauncherById,
	type ProcessLauncherService,
	type UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";
import type { RepositoryBundle } from "./db/repositories.js";

export interface LauncherRecentValuesService {
	list(launcherId: string): Record<string, readonly string[]>;
	record(launcherId: string, launcherInput: Record<string, unknown>): void;
}

function listRememberedStringFieldIds(launcher: UiLauncherSummary): string[] {
	return launcher.launchConfigSchema.fields
		.filter((field) => field.rememberRecentValues === true)
		.map((field) => field.id);
}

export function createLauncherRecentValuesService(input: {
	repos: Pick<RepositoryBundle, "launcherRecentValues">;
	launcherService: ProcessLauncherService;
	limit?: number;
}): LauncherRecentValuesService {
	const limit = input.limit ?? DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT;
	return {
		list(launcherId: string): Record<string, readonly string[]> {
			const launcher = findUiLauncherById(input.launcherService, launcherId);
			if (!launcher) return {};
			const rememberedFieldIds = new Set(listRememberedStringFieldIds(launcher));
			if (rememberedFieldIds.size === 0) return {};
			const valuesByField: Record<string, string[]> = {};
			for (const value of input.repos.launcherRecentValues.listByLauncher(launcherId)) {
				if (!rememberedFieldIds.has(value.fieldId)) continue;
				const fieldValues = valuesByField[value.fieldId] ?? [];
				if (fieldValues.length >= limit || fieldValues.includes(value.value)) continue;
				fieldValues.push(value.value);
				valuesByField[value.fieldId] = fieldValues;
			}
			return valuesByField;
		},

		record(launcherId: string, launcherInput: Record<string, unknown>): void {
			const launcher = findUiLauncherById(input.launcherService, launcherId);
			if (!launcher) return;
			for (const fieldId of listRememberedStringFieldIds(launcher)) {
				const value = normalizeLauncherRecentValue(launcherInput[fieldId]);
				if (!value) continue;
				input.repos.launcherRecentValues.recordValue({ launcherId, fieldId, value, limit });
			}
		},
	};
}
