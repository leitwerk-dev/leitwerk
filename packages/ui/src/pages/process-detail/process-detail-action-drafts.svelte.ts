import type { ActionScheduledAtLocalParts } from "../../chronicle/lib/action-bindings.js";
import {
	currentLocalScheduleDateTimeParts,
	isoToLocalScheduleDateTimeParts,
	splitLauncherScheduleTimeString,
} from "../../components/launcher-schedule.js";
import type {
	ProcessActionFieldDefinition,
	ProcessActionSummary,
	ScheduledActionDetail,
} from "../../lib/api.js";

interface ActionDraft {
	fields?: Record<string, string | number | boolean>;
	nextTurnModelProfileId?: string;
	schedule?: {
		mode?: "now" | "once";
		localParts?: Partial<ActionScheduledAtLocalParts>;
	};
}

function toActionScheduledAtLocalParts(parts: {
	date: string;
	time: string;
}): ActionScheduledAtLocalParts {
	return { date: parts.date, ...splitLauncherScheduleTimeString(parts.time) };
}

function currentActionScheduledAtLocalParts(): ActionScheduledAtLocalParts {
	return toActionScheduledAtLocalParts(currentLocalScheduleDateTimeParts());
}

function actionScheduledAtLocalPartsFromIso(iso: string): ActionScheduledAtLocalParts {
	return toActionScheduledAtLocalParts(isoToLocalScheduleDateTimeParts(iso));
}

function defaultActionFieldValue(field: ProcessActionFieldDefinition): string | boolean {
	return field.kind === "boolean" ? false : "";
}

function mergeLocalParts(
	base: ActionScheduledAtLocalParts,
	overrides: Partial<ActionScheduledAtLocalParts> | undefined,
): ActionScheduledAtLocalParts {
	return {
		date: overrides?.date ?? base.date,
		hour: overrides?.hour ?? base.hour,
		minute: overrides?.minute ?? base.minute,
	};
}

function hasBlankLocalParts(parts: ActionScheduledAtLocalParts): boolean {
	return parts.date === "" && parts.hour === "" && parts.minute === "";
}

export function createProcessDetailActionDrafts(args: {
	get scheduledAction(): ScheduledActionDetail | null;
	get editingScheduledActionId(): string | null;
}) {
	let drafts = $state<Record<string, ActionDraft>>({});
	let primaryPrompt = $state<string | undefined>(undefined);

	function scheduledActionDefault(actionId: string): ScheduledActionDetail | null {
		const scheduledAction = args.scheduledAction;
		if (
			!scheduledAction ||
			args.editingScheduledActionId !== scheduledAction.id ||
			scheduledAction.action.id !== actionId
		) {
			return null;
		}
		return scheduledAction;
	}

	function getDraft(actionId: string): ActionDraft {
		return drafts[actionId] ?? {};
	}

	function setDraft(actionId: string, updater: (draft: ActionDraft) => ActionDraft) {
		drafts = {
			...drafts,
			[actionId]: updater(getDraft(actionId)),
		};
	}

	function getActionFieldValue(
		actionId: string,
		field: ProcessActionFieldDefinition,
	): string | number | boolean {
		if (field.primaryPrompt && primaryPrompt !== undefined) return primaryPrompt;
		const draftValue = getDraft(actionId).fields?.[field.id];
		if (draftValue !== undefined) return draftValue;
		const scheduledValue = scheduledActionDefault(actionId)?.input[field.id];
		if (scheduledValue !== undefined) return scheduledValue as string | number | boolean;
		return defaultActionFieldValue(field);
	}

	function setActionFieldValue(
		actionId: string,
		field: ProcessActionFieldDefinition,
		value: string | number | boolean,
	) {
		if (field.primaryPrompt) {
			primaryPrompt = String(value);
			return;
		}
		setDraft(actionId, (draft) => ({
			...draft,
			fields: { ...(draft.fields ?? {}), [field.id]: value },
		}));
	}

	function buildActionPayload(action: ProcessActionSummary): Record<string, unknown> {
		if (!action.form) {
			return {};
		}
		return Object.fromEntries(
			action.form.fields.map((field) => {
				const rawValue = getActionFieldValue(action.id, field);
				if (field.kind === "number") {
					if (typeof rawValue === "number") {
						return [field.id, rawValue];
					}
					const trimmed = String(rawValue).trim();
					if (trimmed === "") {
						return [field.id, rawValue];
					}
					const parsed = Number(trimmed);
					return [field.id, Number.isFinite(parsed) ? parsed : rawValue];
				}
				return [field.id, rawValue];
			}),
		);
	}

	function reset() {
		drafts = {};
		primaryPrompt = undefined;
	}

	function getActionModelOverrideValue(actionId: string): string {
		return (
			getDraft(actionId).nextTurnModelProfileId ??
			scheduledActionDefault(actionId)?.nextTurnModelProfileId ??
			""
		);
	}

	function setActionModelOverrideValue(actionId: string, value: string) {
		setDraft(actionId, (draft) => ({ ...draft, nextTurnModelProfileId: value }));
	}

	function getActionScheduleMode(actionId: string): "now" | "once" {
		return getDraft(actionId).schedule?.mode ?? (scheduledActionDefault(actionId) ? "once" : "now");
	}

	function getActionScheduledAtLocalParts(actionId: string): ActionScheduledAtLocalParts {
		const scheduledAction = scheduledActionDefault(actionId);
		const base = scheduledAction
			? actionScheduledAtLocalPartsFromIso(scheduledAction.nextRunAt)
			: { date: "", hour: "", minute: "" };
		return mergeLocalParts(base, getDraft(actionId).schedule?.localParts);
	}

	function setActionScheduleMode(actionId: string, value: "now" | "once") {
		setDraft(actionId, (draft) => {
			const currentParts = getActionScheduledAtLocalParts(actionId);
			const localParts =
				value === "once" && hasBlankLocalParts(currentParts)
					? currentActionScheduledAtLocalParts()
					: currentParts;
			return {
				...draft,
				schedule: {
					...(draft.schedule ?? {}),
					mode: value,
					localParts,
				},
			};
		});
	}

	function setActionScheduledAtLocalParts(
		actionId: string,
		value: Partial<ActionScheduledAtLocalParts>,
	) {
		setDraft(actionId, (draft) => ({
			...draft,
			schedule: {
				...(draft.schedule ?? {}),
				localParts: {
					...getActionScheduledAtLocalParts(actionId),
					...value,
				},
			},
		}));
	}

	return {
		getActionFieldValue,
		setActionFieldValue,
		buildActionPayload,
		reset,
		getActionModelOverrideValue,
		setActionModelOverrideValue,
		getActionScheduleMode,
		setActionScheduleMode,
		getActionScheduledAtLocalParts,
		setActionScheduledAtLocalParts,
	};
}
