import type { FutureLaunchSummary, UiLauncherSummary } from "./api.js";
import { formatDefinition } from "./format.js";

export interface FutureLaunchDetailItem {
	label: string;
	value: string;
}

export interface FutureLaunchDetailSection {
	id: string;
	title: string;
	items: FutureLaunchDetailItem[];
}

function stringifyValue(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? "Yes" : "No";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? null : trimmed;
	}
	if (Array.isArray(value)) {
		const values = value.map(stringifyValue).filter((item): item is string => Boolean(item));
		return values.length > 0 ? values.join(", ") : null;
	}
	if (typeof value === "object") {
		return JSON.stringify(value, null, 2);
	}
	return String(value);
}

function fieldLabel(launcher: UiLauncherSummary | null, fieldId: string): string {
	const configuredLabel = launcher?.launchConfigSchema.fields.find(
		(field) => field.id === fieldId,
	)?.label;
	if (configuredLabel) {
		return configuredLabel;
	}
	return formatDefinition(fieldId.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

function addSection(
	sections: FutureLaunchDetailSection[],
	id: string,
	title: string,
	items: FutureLaunchDetailItem[],
) {
	const visibleItems = items.filter((item) => item.value.trim() !== "");
	if (visibleItems.length > 0) {
		sections.push({ id, title, items: visibleItems });
	}
}

function isBranchField(fieldId: string): boolean {
	const normalized = fieldId.toLowerCase();
	return normalized.includes("branch") || normalized.includes("merge") || normalized.includes("mr");
}

function isProjectField(fieldId: string): boolean {
	const normalized = fieldId.toLowerCase();
	return (
		normalized.includes("repo") ||
		normalized.includes("project") ||
		normalized.includes("component") ||
		normalized.includes("path")
	);
}

function isInstructionField(fieldId: string): boolean {
	const normalized = fieldId.toLowerCase();
	return (
		normalized.includes("instruction") ||
		normalized.includes("prompt") ||
		normalized.includes("description") ||
		normalized.includes("summary")
	);
}

export function buildFutureLaunchDetailSections(
	futureLaunch: FutureLaunchSummary,
	launcher: UiLauncherSummary | null,
): FutureLaunchDetailSection[] {
	const sections: FutureLaunchDetailSection[] = [];
	addSection(sections, "schedule", "Schedule", [
		{ label: "Launches", value: futureLaunch.nextRunAt },
		{
			label: "Recurrence",
			value:
				futureLaunch.scheduleKind === "cron"
					? (futureLaunch.cronExpression ?? "Cron schedule")
					: "One time",
		},
	]);
	addSection(sections, "process", "Process", [
		{ label: "Process", value: launcher?.displayName ?? futureLaunch.launcherLabel },
		{ label: "Title", value: futureLaunch.launchTitle ?? futureLaunch.title },
	]);

	const projectItems: FutureLaunchDetailItem[] = [];
	const branchItems: FutureLaunchDetailItem[] = [];
	const instructionItems: FutureLaunchDetailItem[] = [];
	const otherItems: FutureLaunchDetailItem[] = [];
	for (const [fieldId, rawValue] of Object.entries(futureLaunch.launcherInput)) {
		const value = stringifyValue(rawValue);
		if (!value) {
			continue;
		}
		const item = { label: fieldLabel(launcher, fieldId), value };
		if (isBranchField(fieldId)) {
			branchItems.push(item);
		} else if (isProjectField(fieldId)) {
			projectItems.push(item);
		} else if (isInstructionField(fieldId)) {
			instructionItems.push(item);
		} else {
			otherItems.push(item);
		}
	}
	addSection(sections, "projects", "Projects / repositories", projectItems);
	addSection(sections, "branches", "Branches / MR settings", branchItems);
	addSection(sections, "instructions", "Instructions", instructionItems);
	addSection(sections, "details", "Selected fields", otherItems);

	const modelItems: FutureLaunchDetailItem[] = [];
	if (typeof futureLaunch.modelConfig.defaultModelProfileId === "string") {
		modelItems.push({
			label: "Default model",
			value: futureLaunch.modelConfig.defaultModelProfileId,
		});
	}
	for (const [turnId, config] of Object.entries(futureLaunch.modelConfig.turnConfigs ?? {})) {
		if (typeof config?.modelProfileId === "string" && config.modelProfileId.trim() !== "") {
			modelItems.push({ label: formatDefinition(turnId), value: config.modelProfileId });
		}
	}
	addSection(sections, "runtime", "Runtime / model settings", modelItems);
	return sections;
}
