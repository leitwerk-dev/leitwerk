<script lang="ts">
import {
	type FutureLaunchSummary,
	fetchLauncherDefaults,
	fetchLauncherModelConfigPreview,
	fetchLauncherOptions,
	fetchLauncherRecentValues,
	type LauncherFieldDefinition,
	type LauncherFieldOptionDefinition,
	type LauncherModelConfigDefaults,
	type LauncherModelConfigPreview,
	type LauncherTurnModelConfigPreview,
	type LauncherValidationError,
	launchLauncher,
	type ProcessRetryConfig,
	previewCronExpression,
	type ScheduleConfigInput,
	type UiLauncherSummary,
	updateScheduledLaunch,
} from "../lib/api.js";
import { getBrowserStorage } from "../lib/browser-storage.js";
import { formatLocalDateTime24Hour, formatUtcDateTime24Hour } from "../lib/format.js";
import {
	normalizeLauncherRecentValues,
	readLauncherRecentValues,
	writeLauncherRecentValue,
} from "../lib/launcher-recent-values.js";
import FormFieldRenderer from "./FormFieldRenderer.svelte";
import {
	buildLauncherDefaultsNotice,
	getFirstLauncherFieldIdWithErrors,
	normalizeLauncherValidationErrors,
} from "./launcher-form-copy.js";
import {
	buildLauncherModelSummaryView,
	describeDefaultModelDisplayLine,
	describeTurnModelDisplayLine,
	getDefaultModelBlankOptionLabel,
	getDefaultModelSelectableProfiles,
	getLauncherModelCustomizationState,
	getTurnModelBlankOptionLabel,
} from "./launcher-model-config.js";
import {
	buildLauncherScheduleTimeString,
	currentLocalScheduleDateTimeParts,
	isoToLocalScheduleDateTimeParts,
	localScheduleDateTimePartsToIso,
	splitLauncherScheduleTimeString,
} from "./launcher-schedule.js";
import ScheduleDateTimePicker from "./ScheduleDateTimePicker.svelte";
import SkillSelector from "./SkillSelector.svelte";

type LauncherFieldInputValue = boolean | string;

interface Props {
	launcher: UiLauncherSummary;
	initialRelaunchDraft?: ProcessRetryConfig | null;
	initialTitle?: string | null;
	initialValues?: Record<string, unknown> | null;
	initialSkillIds?: readonly string[] | null;
	initialModelConfig?: LauncherModelConfigDefaults | null;
	initialSchedule?: ScheduleConfigInput | null;
	editingFutureLaunch?: FutureLaunchSummary | null;
	onLaunched: (instanceId: string, launchWarning?: string | null) => void;
	onScheduled?: (futureExecution: FutureLaunchSummary) => void;
}

let {
	launcher,
	initialRelaunchDraft = null,
	initialTitle = undefined,
	initialValues = null,
	initialSkillIds = null,
	initialModelConfig = null,
	initialSchedule = null,
	editingFutureLaunch = null,
	onLaunched,
	onScheduled,
}: Props = $props();

let titleInputValue = $state("");
let selectedSkillIds = $state<string[]>([]);
let fieldInputValues = $state<Record<string, LauncherFieldInputValue>>({});
let fieldOptionsById = $state<Record<string, readonly LauncherFieldOptionDefinition[]>>({});
let recentFieldValuesById = $state<Record<string, readonly string[]>>({});
let defaultModelProfileId = $state("");
let turnModelProfileIds = $state<Record<string, string>>({});
let advancedModelConfigOpen = $state(false);
let turnModelProfileIdsBeforeEditing = $state<Record<string, string> | null>(null);
let loadingDefaults = $state(true);
let defaultsError = $state<string | null>(null);
let defaultsWarnings = $state<LauncherValidationError[]>([]);
let optionsError = $state<string | null>(null);
let modelConfigPreview = $state<LauncherModelConfigPreview | null>(null);
let recommendedDefaultModelPreview = $state<LauncherModelConfigPreview["defaultModel"] | null>(
	null,
);
let modelConfigPreviewLoading = $state(false);
let modelConfigPreviewError = $state<string | null>(null);
let submitBusy = $state(false);
let submitError = $state<string | null>(null);
let submitSuccess = $state<string | null>(null);
let formErrors = $state<string[]>([]);
let fieldErrors = $state<Record<string, string[]>>({});
let scheduleMode = $state<ScheduleConfigInput["mode"]>("now");
let scheduledRunOnDate = $state("");
let scheduledRunAtHour = $state("");
let scheduledRunAtMinute = $state("");
let cronExpression = $state("");
let cronPreviewAt = $state<string | null>(null);
let cronPreviewError = $state<string | null>(null);
let cronPreviewBusy = $state(false);
let defaultsLoadToken = 0;
let optionsLoadToken = 0;
let modelConfigPreviewLoadToken = 0;
let cronPreviewToken = 0;
let deferredDependentRefreshValues: Record<string, LauncherFieldInputValue> | null = null;

const launcherSkills = $derived(launcher.skills ?? []);
const modelCustomizationState = $derived(
	getLauncherModelCustomizationState({ defaultModelProfileId, turnModelProfileIds }),
);
const defaultModelDisplayLine = $derived(
	describeDefaultModelDisplayLine(modelConfigPreview?.defaultModel ?? null),
);
const modelSummaryView = $derived(
	buildLauncherModelSummaryView({
		preview: modelConfigPreview,
		hasCustomizations: modelCustomizationState.hasCustomizations,
	}),
);
const recommendedDefaultModelProfile = $derived(
	recommendedDefaultModelPreview?.profile ??
		(defaultModelProfileId.trim() === ""
			? (modelConfigPreview?.defaultModel.profile ?? null)
			: null),
);
const defaultModelBlankOptionLabel = $derived(
	getDefaultModelBlankOptionLabel(recommendedDefaultModelProfile),
);
const defaultModelSelectableProfiles = $derived(
	getDefaultModelSelectableProfiles({
		availableProfiles: launcher.modelConfigSchema?.availableProfiles ?? [],
		recommendedProfile: recommendedDefaultModelProfile,
	}),
);
const defaultsNotice = $derived(
	buildLauncherDefaultsNotice({
		fields: launcher.launchConfigSchema.fields,
		values: fieldInputValues,
		warnings: defaultsWarnings,
	}),
);
const fieldErrorCount = $derived(
	Object.values(fieldErrors).reduce((total, messages) => total + messages.length, 0),
);
const cronExamples = [
	{ expression: "0 9 * * 1-5", label: "Weekdays at 09:00 UTC" },
	{ expression: "0 13 * * *", label: "Daily at 13:00 UTC" },
	{ expression: "0 */4 * * *", label: "Every 4 hours" },
	{ expression: "30 8 * * 1", label: "Mondays at 08:30 UTC" },
] as const;
const MAX_PROCESS_TITLE_LENGTH = 80;

function buildTitleDomId(): string {
	return `${launcher.launchConfigSchema.id}-process-title`;
}

function buildFieldDomId(fieldId: string): string {
	return `${launcher.launchConfigSchema.id}-${fieldId}`;
}

function fieldDescriptionDomId(fieldId: string): string {
	return `${buildFieldDomId(fieldId)}-description`;
}

function fieldOptionDescriptionDomId(fieldId: string): string {
	return `${buildFieldDomId(fieldId)}-option-description`;
}

function fieldErrorsDomId(fieldId: string): string {
	return `${buildFieldDomId(fieldId)}-errors`;
}

function focusLauncherField(fieldId: string) {
	queueMicrotask(() => {
		const field = document.getElementById(buildFieldDomId(fieldId));
		if (!(field instanceof HTMLElement)) {
			return;
		}
		field.focus();
		if (typeof field.scrollIntoView === "function") {
			field.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	});
}

function hasSelectableFields(): boolean {
	return launcher.launchConfigSchema.fields.some((field) => field.kind === "select");
}

function hasModelConfigFields(): boolean {
	return (launcher.modelConfigSchema?.llmTurns.length ?? 0) > 0;
}

function clearDeferredDependentRefresh() {
	deferredDependentRefreshValues = null;
}

function flushDeferredDependentRefresh() {
	if (!deferredDependentRefreshValues) {
		clearDeferredDependentRefresh();
		return;
	}
	const pendingValues = deferredDependentRefreshValues;
	clearDeferredDependentRefresh();
	refreshDependentLauncherState(pendingValues);
}

function getFieldDependentRefreshMode(field: LauncherFieldDefinition): "immediate" | "deferred" {
	return field.kind === "textarea" ? "deferred" : "immediate";
}

function createDefaultModelProfileId(modelConfig: LauncherModelConfigDefaults): string {
	return typeof modelConfig.defaultModelProfileId === "string"
		? modelConfig.defaultModelProfileId
		: "";
}

function createTurnModelProfileIds(
	modelConfig: LauncherModelConfigDefaults,
): Record<string, string> {
	const nextValues: Record<string, string> = {};
	for (const turn of launcher.modelConfigSchema?.llmTurns ?? []) {
		const configuredValue = modelConfig.turnConfigs?.[turn.turnId]?.modelProfileId;
		nextValues[turn.turnId] = typeof configuredValue === "string" ? configuredValue : "";
	}
	return nextValues;
}

function loadRecentFieldValuesFromStorage(): Record<string, readonly string[]> {
	const storage = getBrowserStorage();
	if (!storage) {
		return {};
	}
	const nextValues: Record<string, readonly string[]> = {};
	for (const field of launcher.launchConfigSchema.fields) {
		if (field.kind !== "text" || field.rememberRecentValues !== true) {
			continue;
		}
		nextValues[field.id] = readLauncherRecentValues(storage, launcher.id, field.id);
	}
	return nextValues;
}

function mergeRecentFieldValues(
	...sources: readonly Record<string, readonly string[]>[]
): Record<string, readonly string[]> {
	const nextValues: Record<string, readonly string[]> = {};
	for (const field of launcher.launchConfigSchema.fields) {
		if (field.kind !== "text" || field.rememberRecentValues !== true) {
			continue;
		}
		nextValues[field.id] = normalizeLauncherRecentValues(
			sources.flatMap((source) => source[field.id] ?? []),
		);
	}
	return nextValues;
}

async function loadRecentFieldValues(): Promise<Record<string, readonly string[]>> {
	const localValues = loadRecentFieldValuesFromStorage();
	try {
		return mergeRecentFieldValues(await fetchLauncherRecentValues(launcher.id), localValues);
	} catch {
		return localValues;
	}
}

function rememberSuccessfulLauncherFieldValues(launcherInput: Record<string, unknown>) {
	const storage = getBrowserStorage();
	if (!storage) {
		return;
	}
	const nextValues = { ...recentFieldValuesById };
	for (const field of launcher.launchConfigSchema.fields) {
		if (field.kind !== "text" || field.rememberRecentValues !== true) {
			continue;
		}
		nextValues[field.id] = writeLauncherRecentValue(
			storage,
			launcher.id,
			field.id,
			typeof launcherInput[field.id] === "string" ? (launcherInput[field.id] as string) : "",
		);
	}
	recentFieldValuesById = nextValues;
}

function createInitialSchedule(): ScheduleConfigInput {
	if (!initialSchedule) {
		return { mode: "now" };
	}
	return {
		mode: initialSchedule.mode,
		...(typeof initialSchedule.runAt === "string" ? { runAt: initialSchedule.runAt } : {}),
		...(typeof initialSchedule.cronExpression === "string"
			? { cronExpression: initialSchedule.cronExpression }
			: {}),
	};
}

function coerceFieldInputValue(
	field: LauncherFieldDefinition,
	value: unknown,
): LauncherFieldInputValue {
	switch (field.kind) {
		case "boolean":
			return value === true;
		case "number":
			if (typeof value === "number" && Number.isFinite(value)) {
				return String(value);
			}
			return typeof value === "string" ? value : "";
		default:
			if (typeof value === "string") {
				return value;
			}
			return value == null ? "" : String(value);
	}
}

function createFieldInputValues(
	defaults: Record<string, unknown>,
): Record<string, LauncherFieldInputValue> {
	const nextValues: Record<string, LauncherFieldInputValue> = {};
	for (const field of launcher.launchConfigSchema.fields) {
		nextValues[field.id] = coerceFieldInputValue(field, defaults[field.id]);
	}
	return nextValues;
}

function buildLaunchInputFromValues(
	values: Record<string, LauncherFieldInputValue>,
): Record<string, unknown> {
	const nextInput: Record<string, unknown> = {};
	for (const field of launcher.launchConfigSchema.fields) {
		const value = values[field.id];
		switch (field.kind) {
			case "boolean":
				nextInput[field.id] = value === true;
				break;
			case "number": {
				const rawValue = typeof value === "string" ? value : "";
				if (rawValue === "") {
					continue;
				}
				const normalizedValue = Number(rawValue);
				nextInput[field.id] = Number.isFinite(normalizedValue) ? normalizedValue : rawValue;
				break;
			}
			default:
				nextInput[field.id] = typeof value === "string" ? value : "";
		}
	}
	return nextInput;
}

function buildLaunchInput(): Record<string, unknown> {
	return buildLaunchInputFromValues(fieldInputValues);
}

function buildSubmittedTitle(): string | null {
	return titleInputValue.trim() === "" ? null : titleInputValue;
}

function buildLaunchModelConfigFromValues(input: {
	defaultModelProfileId: string;
	turnModelProfileIds: Record<string, string>;
}): LauncherModelConfigDefaults {
	const turnConfigs = Object.fromEntries(
		Object.entries(input.turnModelProfileIds)
			.filter(([, value]) => value.trim() !== "")
			.map(([turnId, modelProfileId]) => [turnId, { modelProfileId }]),
	);
	return {
		...(input.defaultModelProfileId.trim() !== ""
			? { defaultModelProfileId: input.defaultModelProfileId.trim() }
			: {}),
		...(Object.keys(turnConfigs).length > 0 ? { turnConfigs } : {}),
	};
}

function buildLaunchModelConfig(): LauncherModelConfigDefaults {
	return buildLaunchModelConfigFromValues({
		defaultModelProfileId,
		turnModelProfileIds,
	});
}

function shouldAutoOpenAdvancedModelConfig(modelConfig: LauncherModelConfigDefaults): boolean {
	return (
		getLauncherModelCustomizationState({
			defaultModelProfileId: createDefaultModelProfileId(modelConfig),
			turnModelProfileIds: createTurnModelProfileIds(modelConfig),
		}).turnOverrideCount > 0
	);
}

function clearSubmissionState() {
	submitError = null;
	submitSuccess = null;
	formErrors = [];
	fieldErrors = {};
}

function getTurnModelPreview(turnId: string): LauncherTurnModelConfigPreview["effective"] | null {
	return modelConfigPreview?.turns.find((turn) => turn.turnId === turnId)?.effective ?? null;
}

function getTurnModelDisplayLine(turnId: string, description: string) {
	return describeTurnModelDisplayLine({
		turnId,
		description,
		effective: getTurnModelPreview(turnId),
		defaultLine: defaultModelDisplayLine,
	});
}

function getRememberedRecentValues(field: LauncherFieldDefinition): readonly string[] {
	if (field.kind !== "text" || field.rememberRecentValues !== true) {
		return [];
	}
	return recentFieldValuesById[field.id] ?? [];
}

async function loadModelConfigPreview(
	values: Record<string, LauncherFieldInputValue>,
	previewModelConfig: LauncherModelConfigDefaults,
) {
	if (!hasModelConfigFields()) {
		modelConfigPreview = null;
		recommendedDefaultModelPreview = null;
		modelConfigPreviewLoading = false;
		modelConfigPreviewError = null;
		return;
	}

	const token = ++modelConfigPreviewLoadToken;
	modelConfigPreviewLoading = modelConfigPreview === null;
	modelConfigPreviewError = null;
	try {
		const nextPreview = await fetchLauncherModelConfigPreview(
			launcher.id,
			buildLaunchInputFromValues(values),
			previewModelConfig,
		);
		if (token !== modelConfigPreviewLoadToken) {
			return;
		}
		modelConfigPreview = nextPreview;
		if ((previewModelConfig.defaultModelProfileId ?? "").trim() === "") {
			recommendedDefaultModelPreview = nextPreview.defaultModel;
		}
	} catch (error) {
		if (token !== modelConfigPreviewLoadToken) {
			return;
		}
		modelConfigPreviewError =
			error instanceof Error ? error.message : "We couldn't refresh the model preview";
	} finally {
		if (token === modelConfigPreviewLoadToken) {
			modelConfigPreviewLoading = false;
		}
	}
}

async function loadOptions(values: Record<string, LauncherFieldInputValue>) {
	if (!hasSelectableFields()) {
		fieldOptionsById = {};
		optionsError = null;
		return;
	}

	const token = ++optionsLoadToken;
	optionsError = null;
	try {
		const options = await fetchLauncherOptions(launcher.id, buildLaunchInputFromValues(values));
		if (token !== optionsLoadToken) {
			return;
		}
		fieldOptionsById = options;
	} catch (error) {
		if (token !== optionsLoadToken) {
			return;
		}
		optionsError =
			error instanceof Error ? error.message : "We couldn't refresh the available options";
	}
}

function refreshDependentLauncherState(values: Record<string, LauncherFieldInputValue>) {
	const nextModelConfig = buildLaunchModelConfigFromValues({
		defaultModelProfileId,
		turnModelProfileIds,
	});
	void loadOptions(values);
	void loadModelConfigPreview(values, nextModelConfig);
}

function scheduleDependentLauncherRefresh(
	values: Record<string, LauncherFieldInputValue>,
	mode: "immediate" | "deferred",
) {
	if (mode === "immediate") {
		clearDeferredDependentRefresh();
		refreshDependentLauncherState(values);
		return;
	}
	deferredDependentRefreshValues = values;
}

async function loadDefaults() {
	const token = ++defaultsLoadToken;
	clearDeferredDependentRefresh();
	loadingDefaults = true;
	defaultsError = null;
	defaultsWarnings = [];
	optionsError = null;
	modelConfigPreviewError = null;
	clearSubmissionState();
	titleInputValue = "";
	selectedSkillIds = [];
	fieldInputValues = createFieldInputValues({});
	fieldOptionsById = {};
	recentFieldValuesById = loadRecentFieldValuesFromStorage();
	modelConfigPreview = null;
	modelConfigPreviewLoading = false;
	defaultModelProfileId = "";
	turnModelProfileIds = createTurnModelProfileIds({});
	advancedModelConfigOpen = false;
	turnModelProfileIdsBeforeEditing = null;
	scheduleMode = "now";
	scheduledRunOnDate = "";
	scheduledRunAtHour = "";
	scheduledRunAtMinute = "";
	cronExpression = "";
	cronPreviewAt = null;
	cronPreviewError = null;

	try {
		const { defaults, title, modelConfig, warnings } = await fetchLauncherDefaults(launcher.id);
		if (token !== defaultsLoadToken) {
			return;
		}
		const relaunchDraft = initialRelaunchDraft;
		const draftValues = relaunchDraft?.launcherInput ?? initialValues;
		const mergedDefaults = draftValues ? { ...defaults, ...draftValues } : defaults;
		const draftTitle = relaunchDraft ? relaunchDraft.title : initialTitle;
		const mergedTitle = draftTitle !== undefined ? (draftTitle ?? "") : (title ?? "");
		const mergedModelConfig = relaunchDraft?.modelConfig ?? initialModelConfig ?? modelConfig;
		defaultsWarnings = warnings ?? [];
		const nextValues = createFieldInputValues(mergedDefaults);
		const initialScheduleConfig = createInitialSchedule();
		titleInputValue = mergedTitle;
		selectedSkillIds = [...(relaunchDraft?.skillIds ?? initialSkillIds ?? [])];
		fieldInputValues = nextValues;
		recentFieldValuesById = await loadRecentFieldValues();
		if (token !== defaultsLoadToken) {
			return;
		}
		defaultModelProfileId = createDefaultModelProfileId(mergedModelConfig);
		turnModelProfileIds = createTurnModelProfileIds(mergedModelConfig);
		advancedModelConfigOpen = shouldAutoOpenAdvancedModelConfig(mergedModelConfig);
		turnModelProfileIdsBeforeEditing = advancedModelConfigOpen
			? createTurnModelProfileIds(mergedModelConfig)
			: null;
		scheduleMode = initialScheduleConfig.mode;
		const initialScheduleDateTimeParts =
			initialScheduleConfig.mode === "once" && typeof initialScheduleConfig.runAt === "string"
				? isoToLocalScheduleDateTimeParts(initialScheduleConfig.runAt)
				: { date: "", time: "" };
		const initialScheduleTimeParts = splitLauncherScheduleTimeString(
			initialScheduleDateTimeParts.time,
		);
		scheduledRunOnDate = initialScheduleDateTimeParts.date;
		scheduledRunAtHour = initialScheduleTimeParts.hour;
		scheduledRunAtMinute = initialScheduleTimeParts.minute;
		cronExpression =
			initialScheduleConfig.mode === "cron" &&
			typeof initialScheduleConfig.cronExpression === "string"
				? initialScheduleConfig.cronExpression
				: "";
		void loadOptions(nextValues);
		void loadModelConfigPreview(nextValues, mergedModelConfig);
	} catch (error) {
		if (token !== defaultsLoadToken) {
			return;
		}
		defaultsError = error instanceof Error ? error.message : "We couldn't load the starter values";
	} finally {
		if (token === defaultsLoadToken) {
			loadingDefaults = false;
		}
	}
}

$effect(() => {
	launcher;
	initialRelaunchDraft;
	initialTitle;
	initialValues;
	initialSkillIds;
	initialModelConfig;
	initialSchedule;
	editingFutureLaunch?.id;
	void loadDefaults();
	return () => {
		clearDeferredDependentRefresh();
		defaultsLoadToken += 1;
		optionsLoadToken += 1;
		modelConfigPreviewLoadToken += 1;
		cronPreviewToken += 1;
	};
});

function getStringValue(fieldId: string): string {
	const value = fieldInputValues[fieldId];
	return typeof value === "string" ? value : "";
}

function getNumberValue(fieldId: string): string {
	const value = fieldInputValues[fieldId];
	return typeof value === "string" ? value : "";
}

function getBooleanValue(fieldId: string): boolean {
	return fieldInputValues[fieldId] === true;
}

function getFieldErrors(fieldId: string): string[] {
	return fieldErrors[fieldId] ?? [];
}

function getFieldOptions(field: LauncherFieldDefinition): readonly LauncherFieldOptionDefinition[] {
	const baseOptions = fieldOptionsById[field.id] ?? field.options ?? [];
	const currentValue = getStringValue(field.id).trim();
	if (
		field.kind !== "select" ||
		currentValue === "" ||
		baseOptions.some((option) => option.value === currentValue)
	) {
		return baseOptions;
	}
	return [{ value: currentValue, label: currentValue }, ...baseOptions];
}

function getSelectedFieldOption(
	field: LauncherFieldDefinition,
): LauncherFieldOptionDefinition | null {
	if (field.kind !== "select") {
		return null;
	}
	const currentValue = getStringValue(field.id).trim();
	if (currentValue === "") {
		return null;
	}
	return getFieldOptions(field).find((option) => option.value === currentValue) ?? null;
}

function updateFieldErrorState(fieldId: string) {
	if (!fieldErrors[fieldId]) {
		return;
	}
	const nextFieldErrors = { ...fieldErrors };
	delete nextFieldErrors[fieldId];
	fieldErrors = nextFieldErrors;
}

function setFieldValue(
	field: LauncherFieldDefinition,
	value: LauncherFieldInputValue,
	options: { dependentRefresh?: "immediate" | "deferred" } = {},
) {
	const nextValues = {
		...fieldInputValues,
		[field.id]: value,
	};
	fieldInputValues = nextValues;
	updateFieldErrorState(field.id);
	submitError = null;
	formErrors = [];
	scheduleDependentLauncherRefresh(
		nextValues,
		options.dependentRefresh ?? getFieldDependentRefreshMode(field),
	);
}

function setDefaultModelProfileValue(value: string) {
	defaultModelProfileId = value;
	submitError = null;
	formErrors = [];
	clearDeferredDependentRefresh();
	void loadModelConfigPreview(
		fieldInputValues,
		buildLaunchModelConfigFromValues({
			defaultModelProfileId: value,
			turnModelProfileIds,
		}),
	);
}

function setTurnModelProfileValue(turnId: string, value: string) {
	const nextTurnModelProfileIds = {
		...turnModelProfileIds,
		[turnId]: value,
	};
	turnModelProfileIds = nextTurnModelProfileIds;
	submitError = null;
	formErrors = [];
	clearDeferredDependentRefresh();
	void loadModelConfigPreview(
		fieldInputValues,
		buildLaunchModelConfigFromValues({
			defaultModelProfileId,
			turnModelProfileIds: nextTurnModelProfileIds,
		}),
	);
}

function openModelConfigEditor() {
	turnModelProfileIdsBeforeEditing = { ...turnModelProfileIds };
	advancedModelConfigOpen = true;
}

function closeModelConfigEditor() {
	turnModelProfileIdsBeforeEditing = null;
	advancedModelConfigOpen = false;
}

function cancelModelConfigEditing() {
	const nextTurnModelProfileIds = turnModelProfileIdsBeforeEditing ?? { ...turnModelProfileIds };
	turnModelProfileIds = nextTurnModelProfileIds;
	submitError = null;
	formErrors = [];
	modelConfigPreviewError = null;
	clearDeferredDependentRefresh();
	closeModelConfigEditor();
	void loadModelConfigPreview(
		fieldInputValues,
		buildLaunchModelConfigFromValues({
			defaultModelProfileId,
			turnModelProfileIds: nextTurnModelProfileIds,
		}),
	);
}

function resetModelConfigToRecommended() {
	const nextTurnModelProfileIds = createTurnModelProfileIds({});
	turnModelProfileIds = nextTurnModelProfileIds;
	submitError = null;
	formErrors = [];
	modelConfigPreviewError = null;
	clearDeferredDependentRefresh();
	void loadModelConfigPreview(
		fieldInputValues,
		buildLaunchModelConfigFromValues({
			defaultModelProfileId,
			turnModelProfileIds: nextTurnModelProfileIds,
		}),
	);
}

function resetCronPreviewState(invalidatePending = false) {
	if (invalidatePending) {
		cronPreviewToken += 1;
	}
	cronPreviewAt = null;
	cronPreviewError = null;
	cronPreviewBusy = false;
}

function clearScheduleSubmissionState() {
	submitError = null;
	submitSuccess = null;
}

function prefillScheduledRunAtFromNowIfBlank() {
	if (scheduledRunOnDate !== "" || scheduledRunAtHour !== "" || scheduledRunAtMinute !== "") {
		return;
	}
	const currentParts = currentLocalScheduleDateTimeParts();
	const currentTimeParts = splitLauncherScheduleTimeString(currentParts.time);
	scheduledRunOnDate = currentParts.date;
	scheduledRunAtHour = currentTimeParts.hour;
	scheduledRunAtMinute = currentTimeParts.minute;
}

function setScheduleMode(value: ScheduleConfigInput["mode"]) {
	scheduleMode = value;
	if (value === "once") {
		prefillScheduledRunAtFromNowIfBlank();
	}
	clearScheduleSubmissionState();
	if (value !== "cron") {
		resetCronPreviewState(true);
	}
}

function setScheduledRunDate(value: string) {
	scheduledRunOnDate = value;
	clearScheduleSubmissionState();
}

function setScheduledRunHour(value: string) {
	scheduledRunAtHour = value;
	clearScheduleSubmissionState();
}

function setScheduledRunMinute(value: string) {
	scheduledRunAtMinute = value;
	clearScheduleSubmissionState();
}

function getScheduledRunTimeValue(): string {
	return buildLauncherScheduleTimeString({
		hour: scheduledRunAtHour,
		minute: scheduledRunAtMinute,
	});
}

function getScheduledRunAtIso(): string | null {
	return localScheduleDateTimePartsToIso({
		date: scheduledRunOnDate,
		time: getScheduledRunTimeValue(),
	});
}

function buildScheduleConfig(): ScheduleConfigInput {
	if (scheduleMode === "once") {
		return {
			mode: "once",
			runAt: getScheduledRunAtIso(),
		};
	}
	if (scheduleMode === "cron") {
		return {
			mode: "cron",
			cronExpression,
		};
	}
	return { mode: "now" };
}

function applyCronExample(expression: string) {
	cronExpression = expression;
	submitError = null;
	submitSuccess = null;
}

async function refreshCronPreview(expression: string) {
	const trimmedExpression = expression.trim();
	if (scheduleMode !== "cron") {
		resetCronPreviewState(true);
		return;
	}
	if (!trimmedExpression) {
		resetCronPreviewState(true);
		return;
	}
	const token = ++cronPreviewToken;
	cronPreviewBusy = true;
	cronPreviewError = null;
	try {
		const nextRunAt = await previewCronExpression(trimmedExpression);
		if (token !== cronPreviewToken) {
			return;
		}
		cronPreviewAt = nextRunAt;
	} catch (error) {
		if (token !== cronPreviewToken) {
			return;
		}
		cronPreviewAt = null;
		cronPreviewError = error instanceof Error ? error.message : "Couldn't preview this cron";
	} finally {
		if (token === cronPreviewToken) {
			cronPreviewBusy = false;
		}
	}
}

$effect(() => {
	const mode = scheduleMode;
	const expression = cronExpression;
	if (mode !== "cron") {
		resetCronPreviewState(true);
		return;
	}
	void refreshCronPreview(expression);
});
function applyValidationErrors(errors: readonly LauncherValidationError[]) {
	const normalized = normalizeLauncherValidationErrors(launcher.launchConfigSchema.fields, errors);
	fieldErrors = normalized.fieldErrors;
	formErrors = normalized.formErrors;

	const firstInvalidFieldId = getFirstLauncherFieldIdWithErrors(
		launcher.launchConfigSchema.fields,
		normalized.fieldErrors,
	);
	if (firstInvalidFieldId) {
		focusLauncherField(firstInvalidFieldId);
	}
}

function getFieldDescribedBy(field: LauncherFieldDefinition): string | undefined {
	const ids: string[] = [];
	if (field.description) {
		ids.push(fieldDescriptionDomId(field.id));
	}
	if (field.kind === "select" && getSelectedFieldOption(field)?.description) {
		ids.push(fieldOptionDescriptionDomId(field.id));
	}
	if (getFieldErrors(field.id).length > 0) {
		ids.push(fieldErrorsDomId(field.id));
	}
	return ids.length > 0 ? ids.join(" ") : undefined;
}

function submitButtonLabel(): string {
	if (submitBusy) {
		return editingFutureLaunch
			? scheduleMode === "now"
				? "Running now…"
				: "Saving schedule…"
			: scheduleMode === "now"
				? "Starting process…"
				: "Saving schedule…";
	}
	if (editingFutureLaunch) {
		return scheduleMode === "now" ? "Run now" : "Save schedule";
	}
	if (scheduleMode === "now") {
		return launcher.launchConfigSchema.submitLabel ?? "Start process";
	}
	return scheduleMode === "cron" ? "Save cron schedule" : "Schedule process";
}

async function handleSubmit(event: SubmitEvent) {
	event.preventDefault();
	clearDeferredDependentRefresh();
	clearSubmissionState();
	submitBusy = true;

	try {
		const schedule = buildScheduleConfig();
		if (schedule.mode === "once" && !schedule.runAt) {
			submitError = "Choose a future date and time.";
			focusLauncherField("schedule-date");
			return;
		}
		if (schedule.mode === "cron" && !cronExpression.trim()) {
			submitError = "Enter a cron expression.";
			focusLauncherField("schedule-cron");
			return;
		}
		const title = buildSubmittedTitle();
		const launcherInput = buildLaunchInput();
		const modelConfig = buildLaunchModelConfig();
		const result = editingFutureLaunch
			? await updateScheduledLaunch(
					editingFutureLaunch.id,
					title,
					launcherInput,
					modelConfig,
					schedule,
					selectedSkillIds,
				)
			: await launchLauncher(
					launcher.id,
					title,
					launcherInput,
					modelConfig,
					schedule,
					selectedSkillIds,
				);
		switch (result.kind) {
			case "success":
				rememberSuccessfulLauncherFieldValues(launcherInput);
				onLaunched(result.process.id);
				return;
			case "scheduled":
				rememberSuccessfulLauncherFieldValues(launcherInput);
				if (onScheduled) {
					onScheduled(result.futureExecution);
					return;
				}
				submitSuccess =
					result.futureExecution.scheduleKind === "cron"
						? `Saved cron schedule. Next run: ${formatLocalDateTime24Hour(result.futureExecution.nextRunAt)}.`
						: `Scheduled for ${formatLocalDateTime24Hour(result.futureExecution.nextRunAt)}.`;
				return;
			case "partial_success":
				rememberSuccessfulLauncherFieldValues(launcherInput);
				onLaunched(result.process.id, result.warning);
				return;
			case "validation_error":
				applyValidationErrors(result.errors);
				return;
			case "failure":
				submitError = result.error;
				return;
		}
	} catch (error) {
		submitError = error instanceof Error ? error.message : "We couldn't start this process";
	} finally {
		submitBusy = false;
	}
}
</script>

<div class="launcher-form" data-launcher-id={launcher.id} aria-busy={submitBusy || loadingDefaults}>
	{#if loadingDefaults}
		<p class="state-msg">Loading the starter values for this process…</p>
	{:else if defaultsError}
		<div class="state-block error" role="status">
			<div class="state-copy">
				<p class="state-title">We couldn't prepare this form yet.</p>
				<p class="state-msg error">{defaultsError}</p>
			</div>
			<button
				type="button"
				class="secondary-button"
				data-pressable="true"
				onclick={() => void loadDefaults()}
			>
				Retry
			</button>
		</div>
	{:else}
		{#if optionsError}
			<p class="state-msg error refresh-error" role="status">
				We couldn't refresh the latest options, so we're showing the last set we loaded.
			</p>
		{/if}
		{#if modelConfigPreviewError}
			<p class="state-msg error refresh-error" role="status">
				We couldn't refresh the current model preview, so we're showing the last preview we loaded.
			</p>
		{/if}
		{#if defaultsNotice}
			<div
				class="state-block warning"
				data-section="launcher-defaults-notice"
				data-tone={defaultsNotice.tone}
				data-field-count={defaultsNotice.fieldIds.length}
				role="status"
			>
				<div class="state-copy">
					<p class="state-title">{defaultsNotice.title}</p>
					<p class="state-msg">{defaultsNotice.message}</p>
					{#if defaultsNotice.details.length > 0}
						<ul class="warning-list">
							{#each defaultsNotice.details as detail (detail)}
								<li class="state-msg warning">{detail}</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		{/if}

		{#if submitError || formErrors.length > 0 || fieldErrorCount > 0}
			<div
				class="form-error-banner"
				data-section="launcher-form-error-banner"
				data-field-error-count={fieldErrorCount}
				data-form-error-count={formErrors.length}
				role="alert"
			>
				<p class="form-error-title">
					{fieldErrorCount > 0 ? "Check the highlighted fields." : "We couldn't continue yet."}
				</p>
				{#if fieldErrorCount > 0}
					<p>Complete the required details, then try again.</p>
				{/if}
				{#if submitError}
					<p>{submitError}</p>
				{/if}
				{#if formErrors.length > 0}
					<ul>
						{#each formErrors as message (message)}
							<li>{message}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if submitSuccess}
			<div class="state-block success" role="status">
				<div class="state-copy">
					<p class="state-title">Saved</p>
					<p class="state-msg">{submitSuccess}</p>
				</div>
			</div>
		{/if}

		<form class="launcher-fields" novalidate onsubmit={handleSubmit}>
			<div class="field-group title-field">
				<label class="field-label" for={buildTitleDomId()}>Title</label>
				<input
					id={buildTitleDomId()}
					data-launcher-form-field
					type="text"
					value={titleInputValue}
					placeholder="Optional title"
					maxlength={MAX_PROCESS_TITLE_LENGTH}
					oninput={(event) => {
						titleInputValue = (event.currentTarget as HTMLInputElement).value;
						clearSubmissionState();
					}}
				/>
				<p class="field-description">Leave blank to generate a title later.</p>
			</div>
			{#each launcher.launchConfigSchema.fields as field (field.id)}
				<FormFieldRenderer
					{field}
					id={buildFieldDomId(field.id)}
					value={field.kind === "boolean"
						? getBooleanValue(field.id)
						: field.kind === "number"
							? getNumberValue(field.id)
							: getStringValue(field.id)}
					errors={getFieldErrors(field.id)}
					descriptionId={fieldDescriptionDomId(field.id)}
					errorId={fieldErrorsDomId(field.id)}
					describedBy={getFieldDescribedBy(field)}
					marker="launcher"
					textareaRows={5}
					options={getFieldOptions(field)}
					selectedOptionDescription={getSelectedFieldOption(field)?.description ?? null}
					selectedOptionDescriptionId={fieldOptionDescriptionDomId(field.id)}
					recentValues={getRememberedRecentValues(field)}
					layout="split"
					onValueChange={(changedField, value) => setFieldValue(changedField, value)}
					onTextBlur={flushDeferredDependentRefresh}
					onRecentValue={(changedField, value) =>
						setFieldValue(changedField, value, { dependentRefresh: "immediate" })}
				/>
			{/each}

			{#if launcherSkills.length > 0}
				<SkillSelector skills={launcherSkills} bind:selectedIds={selectedSkillIds} />
			{/if}

			{#if hasModelConfigFields()}
				<section class="field-group model-config-group" data-section="launcher-model-config">
					<div class="model-config-intro">
						<p class="field-label">Model setup</p>
						<p class="field-description">
							Recommended models are ready to use. Change the default model here, or customize individual steps when needed.
						</p>
					</div>

					<div
						class="field-group model-config-default-group"
						data-section="launcher-model-config-default"
						data-effective-source={modelConfigPreview?.defaultModel.source ?? "none"}
						data-effective-profile-id={defaultModelDisplayLine.profile?.id ?? ""}
						data-model-state={defaultModelDisplayLine.state}
					>
						<div class="model-config-default-row">
							<label class="field-label model-step-title" for={`${launcher.launchConfigSchema.id}-default-model-profile`}>
								Default model
							</label>
							<select
								id={`${launcher.launchConfigSchema.id}-default-model-profile`}
								class="model-config-default-select"
								value={defaultModelProfileId}
								onchange={(event) =>
									setDefaultModelProfileValue((event.currentTarget as HTMLSelectElement).value)}
							>
								<option value="">{defaultModelBlankOptionLabel}</option>
								{#each defaultModelSelectableProfiles as option (option.id)}
									<option value={option.id} disabled={option.availability !== "available"}>
										{option.label}{option.availability !== "available"
											? ` — ${option.availability ?? "unavailable"}`
											: ""}
									</option>
								{/each}
							</select>
						</div>
						{#if modelConfigPreviewLoading && modelConfigPreview === null}
							<p class="field-description model-config-status-note">Refreshing the current recommendation…</p>
						{/if}
					</div>

					<div class="model-config-status-row">
						<div
							class="model-config-status"
							data-section="launcher-model-config-summary"
							data-summary-mode={modelSummaryView.mode}
							data-customization-mode={modelCustomizationState.mode}
							data-customization-count={modelCustomizationState.totalCustomizedChoices}
							data-preview-loading={modelConfigPreviewLoading}
							data-editing={advancedModelConfigOpen ? "true" : "false"}
							data-override-count={modelCustomizationState.turnOverrideCount}
							role="status"
							aria-live="polite"
						>
							<div class="model-config-summary-header">
								<p class="field-label model-config-summary-title" data-section="launcher-model-config-summary-copy">
									Models Per Step
								</p>
								<div class="model-config-actions-row">
									<button
										type="button"
										class="model-config-link-button"
										data-action="toggle-model-config-editor"
										aria-expanded={advancedModelConfigOpen}
										onclick={() => {
											if (advancedModelConfigOpen) {
												closeModelConfigEditor();
												return;
											}
											openModelConfigEditor();
										}}
									>
										{advancedModelConfigOpen ? "(done)" : "(edit)"}
									</button>
									{#if advancedModelConfigOpen}
										<button
											type="button"
											class="model-config-link-button"
											data-action="cancel-model-config-editor"
											onclick={cancelModelConfigEditing}
										>
											(cancel)
										</button>
									{/if}
									{#if !advancedModelConfigOpen && modelCustomizationState.turnOverrideCount > 0}
										<button
											type="button"
											class="model-config-link-button model-config-reset-link"
											data-action="reset-model-config"
											onclick={resetModelConfigToRecommended}
										>
											(reset)
										</button>
									{/if}
								</div>
							</div>
							{#if modelSummaryView.turns.length > 0}
								<div
									class="model-config-turn-list-shell"
									data-section="launcher-model-config-turn-list"
									data-open={advancedModelConfigOpen ? "true" : "false"}
									data-customization-mode={modelCustomizationState.mode}
									data-override-count={modelCustomizationState.turnOverrideCount}
								>
									<ul
										class="model-config-summary-turn-list"
										data-section="launcher-model-config-summary-turn-list"
									>
										{#each modelSummaryView.turns as turn, index (turn.turnId)}
											{@const turnDisplayLine = getTurnModelDisplayLine(turn.turnId, turn.label)}
											<li
												class="model-config-summary-turn"
												role="listitem"
												data-turn-id={turn.turnId}
												data-turn-index={index + 1}
												data-model-state={turnDisplayLine.state}
												data-effective-source={turn.source}
												data-effective-profile-id={turn.profile?.id ?? ""}
												data-model-name={turn.modelName ?? ""}
												data-adjusted={turn.isAdjusted ? "true" : "false"}
												data-editing={advancedModelConfigOpen ? "true" : "false"}
											>
												<span class="model-config-summary-turn-label">{turn.label}</span>
												{#if advancedModelConfigOpen}
													<select
														id={`${launcher.launchConfigSchema.id}-${turn.turnId}-model-profile`}
														class="model-config-summary-turn-select"
														value={turnModelProfileIds[turn.turnId] ?? ""}
														onchange={(event) =>
															setTurnModelProfileValue(
																turn.turnId,
																(event.currentTarget as HTMLSelectElement).value,
															)}
													>
														<option value="">{getTurnModelBlankOptionLabel()}</option>
												{#each launcher.modelConfigSchema?.availableProfiles ?? [] as option (option.id)}
													<option
														value={option.id}
														disabled={option.availability !== undefined && option.availability !== "available"}
													>
														{option.label}{option.availability && option.availability !== "available"
															? ` — ${option.availability}`
															: ""}
													</option>
												{/each}
													</select>
												{:else}
													<span class="model-config-summary-turn-model">
														{turn.modelName ?? "No model available"}
													</span>
												{/if}
												<div class="model-config-summary-turn-side">
													{#if turn.isAdjusted}
														<span class="model-config-summary-turn-adjusted">Adjusted</span>
													{/if}
												</div>
											</li>
										{/each}
									</ul>
								</div>
							{/if}
						</div>
					</div>
				</section>
			{/if}

			<section class="field-group schedule-group" data-section="launcher-schedule-config">
				<div class="model-config-header">
					<div>
						<p class="field-label">When to run</p>
						<p class="field-description">
							Store schedules in UTC, while this form shows times in your local timezone.
						</p>
					</div>
				</div>

				<div class="schedule-mode-grid" role="radiogroup" aria-label="When to run">
					<label class="schedule-choice" data-selected={scheduleMode === "now"}>
						<input
							type="radio"
							name={`${launcher.launchConfigSchema.id}-schedule-mode`}
							checked={scheduleMode === "now"}
							onchange={() => setScheduleMode("now")}
						/>
						<span>Start now</span>
					</label>
					<label class="schedule-choice" data-selected={scheduleMode === "once"}>
						<input
							type="radio"
							name={`${launcher.launchConfigSchema.id}-schedule-mode`}
							checked={scheduleMode === "once"}
							onchange={() => setScheduleMode("once")}
						/>
						<span>Start later</span>
					</label>
					<label class="schedule-choice" data-selected={scheduleMode === "cron"}>
						<input
							type="radio"
							name={`${launcher.launchConfigSchema.id}-schedule-mode`}
							checked={scheduleMode === "cron"}
							onchange={() => setScheduleMode("cron")}
						/>
						<span>Run on cron</span>
					</label>
				</div>

				{#if scheduleMode === "once"}
					{@const scheduledRunAtIso = getScheduledRunAtIso()}
					<div class="field-group nested-field-group schedule-date-time-group">
						<label class="field-label" for={`${launcher.launchConfigSchema.id}-schedule-date`}>
							Start at
						</label>
						<ScheduleDateTimePicker
							dateId={`${launcher.launchConfigSchema.id}-schedule-date`}
							hourId={`${launcher.launchConfigSchema.id}-schedule-hour`}
							minuteId={`${launcher.launchConfigSchema.id}-schedule-minute`}
							dateValue={scheduledRunOnDate}
							hourValue={scheduledRunAtHour}
							minuteValue={scheduledRunAtMinute}
							dataSection="launcher-schedule-once-picker"
							onDateChange={setScheduledRunDate}
							onHourChange={setScheduledRunHour}
							onMinuteChange={setScheduledRunMinute}
						/>
						{#if scheduledRunAtIso}
							<p class="field-description">
								Runs at {formatLocalDateTime24Hour(scheduledRunAtIso)} · {formatUtcDateTime24Hour(scheduledRunAtIso)}
							</p>
						{/if}
						<p class="field-description">The server stores this in UTC and catches it up after a restart.</p>
					</div>
				{:else if scheduleMode === "cron"}
					<div class="field-group nested-field-group">
						<label class="field-label" for={`${launcher.launchConfigSchema.id}-schedule-cron`}>
							Cron expression
						</label>
						<input
							id={`${launcher.launchConfigSchema.id}-schedule-cron`}
							type="text"
							placeholder="0 9 * * 1-5"
							value={cronExpression}
							oninput={(event) => {
								cronExpression = (event.currentTarget as HTMLInputElement).value;
								submitError = null;
								submitSuccess = null;
							}}
						/>
						<p class="field-description">Cron uses 5 fields and runs in UTC.</p>
						<div class="cron-example-list" data-section="launcher-cron-examples">
							{#each cronExamples as example (example.expression)}
								<button
									type="button"
									class="cron-example-chip"
									data-cron-example={example.expression}
									onclick={() => applyCronExample(example.expression)}
								>
									<span class="cron-example-expression">{example.expression}</span>
									<span class="cron-example-label">{example.label}</span>
								</button>
							{/each}
						</div>
						{#if cronPreviewBusy}
							<p class="field-description">Checking the next run…</p>
						{:else if cronPreviewAt}
							<p class="field-description">
								Next run: {formatLocalDateTime24Hour(cronPreviewAt)} · {formatUtcDateTime24Hour(cronPreviewAt)}
							</p>
						{:else if cronPreviewError}
							<p class="field-description schedule-error">{cronPreviewError}</p>
						{/if}
					</div>
				{/if}
			</section>

			<div class="form-footer">
				<button
					class="submit-button"
					type="submit"
					disabled={submitBusy || loadingDefaults}
					data-pressable="true"
				>
					{submitButtonLabel()}
				</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.launcher-form {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		width: min(100%, 920px);
	}

	.launcher-fields {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.field-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		padding: var(--space-lg) 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.title-field {
		display: grid;
		grid-template-columns: minmax(188px, 0.36fr) minmax(0, 1fr);
		gap: var(--space-xs) var(--space-lg);
		align-items: start;
		padding-bottom: var(--space-lg);
	}

	.title-field .field-label {
		grid-column: 1;
		padding-top: var(--space-xs);
	}

	.title-field input {
		grid-column: 2;
		grid-row: 1 / span 2;
	}

	.title-field .field-description {
		grid-column: 1;
		max-width: 24ch;
	}

	.model-config-group,
	.schedule-group {
		margin-top: var(--space-sm);
		padding: var(--space-lg);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 42%, transparent 58%);
	}

	.model-config-group {
		gap: var(--space-md);
	}

	.schedule-group {
		gap: var(--space-sm);
	}

	.model-config-intro,
	.model-config-turn-list-shell {
		display: grid;
		gap: 8px;
	}

	.model-config-status-row {
		display: grid;
		gap: 8px;
	}

	.model-config-status {
		display: grid;
		gap: 12px;
		max-width: 72ch;
	}

	.model-config-summary-header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 16px;
	}

	.model-config-summary-title {
		margin: 0;
	}

	.model-config-turn-list-shell {
		display: grid;
		gap: 0;
	}

	.model-config-summary-turn-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0;
	}

	.model-config-summary-turn {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(240px, 320px) auto;
		align-items: center;
		gap: 12px 16px;
		min-height: 52px;
		padding: 8px 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		color: var(--chronicle-text);
		font-size: 0.9375rem;
		line-height: 1.45;
		background: transparent;
	}

	.model-config-summary-turn-label {
		min-width: 0;
		font-weight: 620;
	}

	.model-config-summary-turn-model {
		min-width: 0;
		color: var(--chronicle-text-muted);
	}

	.model-config-summary-turn-select {
		min-width: 0;
		max-width: 100%;
	}

	.model-config-summary-turn-side {
		display: flex;
		justify-content: flex-end;
		min-width: 72px;
	}

	.model-config-summary-turn-adjusted {
		color: var(--chronicle-link);
		font-size: 0.8125rem;
		font-weight: 620;
		line-height: 1.4;
	}

	.model-config-summary-turn[data-adjusted="true"] .model-config-summary-turn-label,
	.model-config-summary-turn[data-adjusted="true"] .model-config-summary-turn-model {
		color: color-mix(in srgb, var(--chronicle-accent) 74%, var(--chronicle-text) 26%);
	}

	.model-config-status-note {
		color: color-mix(in srgb, var(--chronicle-accent) 68%, var(--chronicle-text) 32%);
	}

	.model-config-actions-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px 14px;
	}

	.model-config-link-button {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--chronicle-link);
		font: inherit;
		font-size: 0.95rem;
		font-weight: 620;
		line-height: 1.4;
		cursor: pointer;
		text-decoration: none;
	}

	.model-config-link-button:hover {
		color: color-mix(in srgb, var(--chronicle-accent) 78%, var(--chronicle-text) 22%);
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}

	.model-config-reset-link {
		color: color-mix(in srgb, var(--chronicle-link) 88%, var(--chronicle-text) 12%);
	}

	.model-config-default-group {
		display: grid;
		gap: 10px;
		padding: 14px 0;
		border-top: 0;
		background: transparent;
	}

	.model-config-default-row {
		display: grid;
		grid-template-columns: minmax(188px, 0.36fr) minmax(0, 1fr);
		gap: var(--space-xs) var(--space-lg);
		align-items: center;
	}

	.model-config-default-select {
		min-width: 0;
	}

	.model-step-title {
		display: block;
	}

	.launcher-fields > .field-group:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.field-label {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.4;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.field-description,
	.state-msg {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}


	input,
	select {
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
		border-radius: 14px;
		background: color-mix(in srgb, white 88%, var(--chronicle-panel-muted) 12%);
		color: var(--chronicle-text);
		padding: 12px 14px;
		font: inherit;
		transition:
			border-color var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart),
			box-shadow var(--duration-fast) var(--ease-out-quart);
	}

	input::placeholder {
		color: var(--chronicle-text-faint);
	}

	input:hover,
	select:hover {
		border-color: color-mix(in srgb, var(--chronicle-accent) 20%, var(--chronicle-border) 80%);
	}

	input:focus-visible,
	select:focus-visible,
	.cron-example-chip:focus-visible,
	.secondary-button:focus-visible,
	.model-config-link-button:focus-visible,
	.submit-button:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--chronicle-accent) 72%, white 28%);
		outline-offset: 2px;
	}


	.cron-example-chip {
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 82%, white 18%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 95%, white 5%);
		color: var(--chronicle-text);
		border-radius: 999px;
		padding: 6px 12px;
		font: inherit;
		cursor: pointer;
		transition:
			transform var(--duration-fast) var(--ease-out-quart),
			border-color var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart);
	}

	.cron-example-chip:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 28%, var(--chronicle-border-strong) 72%);
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
	}


	.form-error-banner ul {
		margin: 0;
		padding-left: 18px;
	}

	.form-error-banner li,
	.form-error-banner p {
		color: var(--chronicle-danger-text);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.form-error-banner {
		display: grid;
		gap: 8px;
		padding: 14px 16px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 36%, var(--chronicle-border) 64%);
		border-radius: 16px;
		background: color-mix(in srgb, white 90%, var(--chronicle-danger) 10%);
	}

	.form-error-title,
	.state-title {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.4;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.state-block {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px;
		border-radius: 16px;
		background: var(--chronicle-panel-muted);
		border: 1px solid var(--chronicle-border);
	}

	.state-block.error {
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		border-color: color-mix(in srgb, var(--chronicle-danger) 34%, var(--chronicle-border) 66%);
	}

	.state-block.success {
		background: color-mix(in srgb, white 94%, var(--chronicle-success) 6%);
		border-color: color-mix(in srgb, var(--chronicle-success) 28%, var(--chronicle-border) 72%);
	}

	.state-block.warning {
		background: color-mix(in srgb, white 94%, var(--chronicle-warning, #d97706) 6%);
		border-color: color-mix(
			in srgb,
			var(--chronicle-warning, #d97706) 28%,
			var(--chronicle-border) 72%
		);
	}

	.state-copy {
		display: grid;
		gap: 6px;
	}

	.state-msg.error,
	.refresh-error,
	.schedule-error {
		color: var(--chronicle-danger-text);
	}

	.state-msg.warning {
		color: color-mix(in srgb, var(--chronicle-text) 78%, var(--chronicle-warning, #d97706) 22%);
	}

	.warning-list {
		margin: 0;
		padding-left: 18px;
		display: grid;
		gap: 6px;
	}

	.schedule-mode-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(176px, 1fr));
		gap: var(--space-sm);
	}

	.schedule-date-time-group {
		gap: 10px;
	}

	.cron-example-list {
		display: grid;
		gap: 8px;
	}

	.cron-example-chip {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 14px;
		border-radius: 14px;
		padding: 10px 12px;
	}

	.cron-example-expression {
		font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.875rem;
		font-weight: 620;
	}

	.cron-example-label {
		font-size: 0.875rem;
		line-height: 1.45;
		color: var(--chronicle-text-muted);
	}

	.form-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-sm);
		margin-top: var(--space-lg);
		padding-top: var(--space-lg);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.secondary-button,
	.submit-button {
		min-height: 46px;
		padding: 0 16px;
		border-radius: 999px;
		font: inherit;
		font-weight: 620;
		cursor: pointer;
		transition:
			transform var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart),
			border-color var(--duration-fast) var(--ease-out-quart),
			box-shadow var(--duration-fast) var(--ease-out-quart);
	}

	.secondary-button {
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
	}

	.submit-button {
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 72%, var(--chronicle-text) 28%);
		background: var(--chronicle-accent);
		color: var(--chronicle-text-on-accent);
		box-shadow: 0 8px 18px color-mix(in srgb, var(--chronicle-accent) 28%, transparent 72%);
	}

	.secondary-button:hover,
	.submit-button:hover {
		transform: translateY(-1px);
	}

	.submit-button:disabled,
	.secondary-button:disabled {
		opacity: 0.62;
		cursor: default;
		transform: none;
		box-shadow: none;
	}

	@container (max-width: 600px) {
		.title-field,
		.model-config-default-row {
			grid-template-columns: 1fr;
		}

		.title-field .field-label,
		.title-field input,
		.title-field .field-description {
			grid-column: 1;
			grid-row: auto;
		}

		.title-field .field-label {
			padding-top: 0;
		}
	}

	@media (max-width: 860px) {
		.title-field,
		.model-config-default-row,
		.model-config-summary-turn {
			grid-template-columns: 1fr;
		}

		.title-field .field-label,
		.title-field input,
		.title-field .field-description {
			grid-column: 1;
			grid-row: auto;
		}

		.title-field .field-label {
			padding-top: 0;
		}

		.model-config-summary-turn-side {
			justify-content: flex-start;
			min-width: 0;
		}
	}

	@media (max-width: 720px) {
		.model-config-status-row {
			align-items: stretch;
		}

		.model-config-summary-header {
			align-items: flex-start;
		}

		.cron-example-chip {
			justify-content: flex-start;
		}

		.form-footer {
			align-items: stretch;
		}

		.submit-button,
		.secondary-button {
			width: 100%;
			justify-content: center;
		}
	}
</style>
