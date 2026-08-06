import { findQuickActionField } from "../../chronicle/lib/action-bindings.js";
import {
	buildLauncherScheduleTimeString,
	localScheduleDateTimePartsToIso,
} from "../../components/launcher-schedule.js";
import {
	deleteFutureExecution,
	fetchProcessActionModelPreview,
	type ProcessActionModelPreview,
	type ProcessActionSummary,
	type ProcessDetailData,
	postProcessAbortTurn,
	postProcessAction,
	postProcessRetry,
	postProcessStartupRetry,
	postProcessTurnContinue,
	updateScheduledAction,
} from "../../lib/api.js";
import { createProcessDetailActionDrafts } from "./process-detail-action-drafts.svelte.js";
import {
	createProcessDetailMutations,
	type ProcessDetailMutationKey,
} from "./process-detail-mutations.svelte.js";

interface KeyedActionModelPreview {
	requestKey: string;
	preview: ProcessActionModelPreview;
}

interface ActionModelPreviewInput {
	actionId: string;
	input: Record<string, unknown>;
}

interface ActionRunOptions {
	nextTurnModelProfileId?: string | null;
	schedule?: { mode: "now" | "once"; runAt?: string | null };
}

interface ActionFormState {
	actionId: string;
	presentation: "collapsed" | "expanded";
	editingScheduledActionId: string | null;
}

function selectedActionFormState(
	actionId: string,
	presentation: "collapsed" | "expanded" = "collapsed",
	editingScheduledActionId: string | null = null,
): ActionFormState {
	return { actionId, presentation, editingScheduledActionId };
}

function preferredActionId(actions: readonly ProcessActionSummary[]): string | null {
	return actions.find((action) => findQuickActionField(action))?.id ?? actions[0]?.id ?? null;
}

function actionModelPreviewRequestKey(
	instanceId: string,
	action: ProcessActionSummary,
	input: Record<string, unknown>,
): string {
	return JSON.stringify({ instanceId, actionId: action.id, input });
}

export function createProcessDetailActions(args: {
	get instanceId(): string;
	get detail(): ProcessDetailData | null;
	reload: () => Promise<void>;
}) {
	const mutations = createProcessDetailMutations();
	let actionFormState = $state<ActionFormState | null>(null);
	let observedProcessId = $state<string | null>(null);
	let openActionModelPreviewState = $state<KeyedActionModelPreview | null>(null);
	let openActionModelPreviewLoadingKey = $state<string | null>(null);
	let actionModelPreviewInput = $state<ActionModelPreviewInput | null>(null);
	let actionModelPreviewLoadToken = 0;

	const isTerminalProcess = $derived.by(() => {
		const lifecycleStatus = args.detail?.process.lifecycleStatus ?? null;
		return lifecycleStatus === "completed" || lifecycleStatus === "aborted";
	});
	const scheduledActionDetail = $derived(args.detail?.scheduledAction ?? null);
	const availableActions = $derived(isTerminalProcess ? [] : (args.detail?.actions ?? []));
	const editingScheduledActionId = $derived(actionFormState?.editingScheduledActionId ?? null);
	const selectedActionId = $derived(actionFormState?.actionId ?? null);
	const openActionFormId = $derived(
		actionFormState?.presentation === "expanded" ? actionFormState.actionId : null,
	);
	const actionSectionActions = $derived.by(() => {
		if (scheduledActionDetail) {
			return editingScheduledActionId === scheduledActionDetail.id
				? [scheduledActionDetail.action]
				: [];
		}
		return availableActions;
	});

	const drafts = createProcessDetailActionDrafts({
		get scheduledAction() {
			return scheduledActionDetail;
		},
		get editingScheduledActionId() {
			return editingScheduledActionId;
		},
	});

	const openActionForModelPreview = $derived.by(() => {
		if (!openActionFormId) {
			return null;
		}
		return actionSectionActions.find((action) => action.id === openActionFormId) ?? null;
	});
	const openActionModelPreviewRequestInput = $derived.by(() => {
		const openAction = openActionForModelPreview;
		return openAction && actionModelPreviewInput?.actionId === openAction.id
			? actionModelPreviewInput.input
			: null;
	});
	const openActionModelPreviewRequestKey = $derived.by(() => {
		const detail = args.detail;
		const openAction = openActionForModelPreview;
		const input = openActionModelPreviewRequestInput;
		if (!detail || !openAction?.supportsNextTurnModelOverride || !input) return null;
		return actionModelPreviewRequestKey(detail.process.id, openAction, input);
	});
	const openActionModelPreview = $derived.by(() => {
		const requestKey = openActionModelPreviewRequestKey;
		if (!requestKey || openActionModelPreviewState?.requestKey !== requestKey) {
			return null;
		}
		return openActionModelPreviewState.preview;
	});
	const openActionModelPreviewLoading = $derived.by(() => {
		const requestKey = openActionModelPreviewRequestKey;
		return requestKey !== null && openActionModelPreviewLoadingKey === requestKey;
	});

	$effect(() => {
		const processId = args.detail?.process.id ?? null;
		const actions = actionSectionActions;
		if (processId !== observedProcessId) {
			reset();
			observedProcessId = processId;
		}
		if (!processId) return;

		if (actionFormState) {
			const editingId = actionFormState.editingScheduledActionId;
			const editIsValid =
				!editingId ||
				(scheduledActionDetail?.id === editingId &&
					scheduledActionDetail.action.id === actionFormState.actionId);
			if (editIsValid && actions.some((action) => action.id === actionFormState.actionId)) return;
			if (editingId) mutations.clearErrors(["cancel-scheduled-action"]);
		}

		const fallbackId = preferredActionId(actions);
		if (!fallbackId && !actionFormState) return;
		actionFormState = fallbackId ? selectedActionFormState(fallbackId) : null;
	});

	$effect(() => {
		const detail = args.detail;
		const openAction = openActionForModelPreview;
		const requestKey = openActionModelPreviewRequestKey;
		if (!detail || !openAction?.supportsNextTurnModelOverride || !requestKey) {
			openActionModelPreviewLoadingKey = null;
			actionModelPreviewLoadToken += 1;
			return;
		}
		if (openActionModelPreviewState?.requestKey === requestKey) {
			return;
		}
		if (openActionModelPreviewLoadingKey === requestKey) {
			return;
		}
		const requestInput = openActionModelPreviewRequestInput;
		if (!requestInput) return;
		const token = ++actionModelPreviewLoadToken;
		openActionModelPreviewLoadingKey = requestKey;
		void fetchProcessActionModelPreview(detail.process.id, openAction.id, requestInput)
			.then((preview) => {
				if (token !== actionModelPreviewLoadToken) {
					return;
				}
				openActionModelPreviewState = { requestKey, preview };
			})
			.catch((error) => {
				if (token !== actionModelPreviewLoadToken) {
					return;
				}
				openActionModelPreviewState = {
					requestKey,
					preview: {
						kind: "unavailable",
						turnId: null,
						description: null,
						unavailableReason: "action_failed",
						unavailableMessage:
							error instanceof Error
								? error.message
								: "We couldn't refresh the action model preview",
					},
				};
			})
			.finally(() => {
				if (
					token === actionModelPreviewLoadToken &&
					openActionModelPreviewLoadingKey === requestKey
				) {
					openActionModelPreviewLoadingKey = null;
				}
			});
	});

	function actionMutationKey(actionId: string): ProcessDetailMutationKey {
		return `action:${actionId}`;
	}

	function firstActionError(): string | null {
		for (const action of actionSectionActions) {
			const error = mutations.errorFor(actionMutationKey(action.id));
			if (error) {
				return error;
			}
		}
		return null;
	}

	function snapshotActionModelPreview(action: ProcessActionSummary) {
		actionModelPreviewInput = { actionId: action.id, input: drafts.buildActionPayload(action) };
	}

	function commitActionPreview(actionId: string) {
		if (openActionFormId !== actionId) return;
		const action = actionSectionActions.find((candidate) => candidate.id === actionId);
		if (action) snapshotActionModelPreview(action);
	}

	function setActionFieldValue(
		actionId: string,
		field: Parameters<typeof drafts.setActionFieldValue>[1],
		value: string | number | boolean,
	) {
		drafts.setActionFieldValue(actionId, field, value);
		if (field.kind !== "text" && field.kind !== "textarea") commitActionPreview(actionId);
	}

	function reset() {
		drafts.reset();
		mutations.reset();
		actionFormState = null;
		openActionModelPreviewState = null;
		openActionModelPreviewLoadingKey = null;
		actionModelPreviewInput = null;
		actionModelPreviewLoadToken += 1;
	}

	function setSelectedAction(actionId: string, presentation: ActionFormState["presentation"]) {
		const action = actionSectionActions.find((candidate) => candidate.id === actionId);
		if (!action) return;
		mutations.clearErrors();
		if (presentation === "expanded") snapshotActionModelPreview(action);
		const editingId =
			actionFormState?.actionId === actionId ? actionFormState.editingScheduledActionId : null;
		actionFormState = selectedActionFormState(actionId, presentation, editingId);
	}

	function selectAction(actionId: string) {
		setSelectedAction(actionId, "collapsed");
	}

	function expandActionForm(actionId: string) {
		setSelectedAction(actionId, "expanded");
	}

	function collapseActionForm() {
		if (!actionFormState) return;
		mutations.clearErrors();
		actionFormState = selectedActionFormState(
			actionFormState.actionId,
			"collapsed",
			actionFormState.editingScheduledActionId,
		);
	}

	function previewForCurrentActionInput(
		action: ProcessActionSummary,
	): ProcessActionModelPreview | null {
		const detail = args.detail;
		if (!detail || !action.supportsNextTurnModelOverride) return null;
		const requestKey = actionModelPreviewRequestKey(
			detail.process.id,
			action,
			drafts.buildActionPayload(action),
		);
		return openActionModelPreviewState?.requestKey === requestKey
			? openActionModelPreviewState.preview
			: null;
	}

	function buildActionRunOptions(action: ProcessActionSummary): ActionRunOptions {
		const preview = previewForCurrentActionInput(action);
		const nextTurnModelProfileId =
			preview?.kind === "llm_turn"
				? drafts.getActionModelOverrideValue(action.id).trim() || undefined
				: undefined;
		const modelOptions = nextTurnModelProfileId ? { nextTurnModelProfileId } : {};
		if (!action.supportsScheduling) return modelOptions;

		if (drafts.getActionScheduleMode(action.id) === "now") {
			return { ...modelOptions, schedule: { mode: "now" } };
		}
		const scheduledAt = drafts.getActionScheduledAtLocalParts(action.id);
		return {
			...modelOptions,
			schedule: {
				mode: "once",
				runAt: localScheduleDateTimePartsToIso({
					date: scheduledAt.date,
					time: buildLauncherScheduleTimeString(scheduledAt),
				}),
			},
		};
	}

	async function submitActionDecision(action: ProcessActionSummary) {
		const opts = buildActionRunOptions(action);
		const scheduledAction = scheduledActionDetail;
		const isEditingScheduledAction =
			scheduledAction !== null && editingScheduledActionId === scheduledAction.id;
		await mutations.runMutation(
			actionMutationKey(action.id),
			async () => {
				if (isEditingScheduledAction) {
					await updateScheduledAction(scheduledAction.id, drafts.buildActionPayload(action), {
						nextTurnModelProfileId: opts.nextTurnModelProfileId ?? null,
						schedule: opts.schedule ?? { mode: "now" },
					});
				} else {
					await postProcessAction(
						args.instanceId,
						action.id,
						drafts.buildActionPayload(action),
						opts,
					);
				}
				actionFormState = null;
				drafts.reset();
				await args.reload();
			},
			{ fallbackErrorMessage: `Couldn't run "${action.label}"` },
		);
	}

	function editScheduledAction() {
		const scheduledAction = scheduledActionDetail;
		if (!scheduledAction || mutations.isAnyBusy()) {
			return;
		}
		mutations.clearErrors();
		snapshotActionModelPreview(scheduledAction.action);
		actionFormState = selectedActionFormState(
			scheduledAction.action.id,
			"expanded",
			scheduledAction.id,
		);
	}

	async function cancelScheduledAction() {
		const scheduledAction = scheduledActionDetail;
		if (!scheduledAction) {
			return;
		}
		await mutations.runMutation(
			"cancel-scheduled-action",
			async () => {
				await deleteFutureExecution(scheduledAction.id);
				actionFormState = null;
				drafts.reset();
				await args.reload();
			},
			{ fallbackErrorMessage: "Couldn't cancel this scheduled action" },
		);
	}

	async function continueFailedTurn(
		turnRecordId: string,
		prompt?: string | null,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) {
		await mutations.runMutation(
			`continue:${turnRecordId}`,
			async () => {
				await postProcessTurnContinue(
					args.instanceId,
					turnRecordId,
					prompt ?? undefined,
					nextTurnModelProfileId,
					providerOptions,
				);
				await args.reload();
			},
			{ fallbackErrorMessage: "Couldn't continue this failed turn", clearErrorKeys: ["retry"] },
		);
	}

	async function retryFailedTurn(
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) {
		await mutations.runMutation(
			"retry",
			async () => {
				await postProcessRetry(args.instanceId, nextTurnModelProfileId, providerOptions);
				await args.reload();
			},
			{ fallbackErrorMessage: "Couldn't retry this failed turn" },
		);
	}

	async function retryStartup(
		startRecordId: string,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) {
		await mutations.runMutation(
			"retry-startup",
			async () => {
				await postProcessStartupRetry(
					args.instanceId,
					startRecordId,
					nextTurnModelProfileId,
					providerOptions,
				);
				await args.reload();
			},
			{ fallbackErrorMessage: "Couldn't retry worker startup" },
		);
	}

	async function abortRunningTurn() {
		await mutations.runMutation(
			"abort-turn",
			async () => {
				await postProcessAbortTurn(args.instanceId);
				// The worker manufactures the turn failure asynchronously; refresh so the
				// parked recovery state (continue / go back) appears once it lands.
				await args.reload();
			},
			{ fallbackErrorMessage: "Couldn't stop this turn" },
		);
	}

	function actionFieldDomId(actionId: string, fieldId: string): string {
		return `process-action-${actionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${fieldId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	}

	return {
		get editingScheduledActionId() {
			return editingScheduledActionId;
		},
		get selectedActionId() {
			return selectedActionId;
		},
		get openActionFormId() {
			return openActionFormId;
		},
		get availableActions() {
			return availableActions;
		},
		get actionSectionActions() {
			return actionSectionActions;
		},
		get openActionModelPreview() {
			return openActionModelPreview;
		},
		get openActionModelPreviewLoading() {
			return openActionModelPreviewLoading;
		},
		get actionBusyId() {
			const activeKey = mutations.activeMutationKey;
			if (!activeKey) {
				return null;
			}
			if (activeKey.startsWith("action:")) {
				return activeKey.slice("action:".length);
			}
			return "__global__";
		},
		get actionError() {
			return firstActionError();
		},
		get continueBusyTurnRecordId() {
			const activeKey = mutations.activeMutationKey;
			return activeKey?.startsWith("continue:") ? activeKey.slice("continue:".length) : null;
		},
		get continueError() {
			for (const [key, message] of Object.entries(mutations.mutationErrors)) {
				if (key.startsWith("continue:") && message) {
					return { turnRecordId: key.slice("continue:".length), message };
				}
			}
			return null;
		},
		get retryBusy() {
			return mutations.isBusy("retry");
		},
		get retryError() {
			return mutations.errorFor("retry");
		},
		get startupRetryBusy() {
			return mutations.isBusy("retry-startup");
		},
		get startupRetryError() {
			return mutations.errorFor("retry-startup");
		},
		get abortTurnBusy() {
			return mutations.isBusy("abort-turn");
		},
		get abortTurnError() {
			return mutations.errorFor("abort-turn");
		},
		get scheduledActionBusy() {
			return mutations.isBusy("cancel-scheduled-action");
		},
		get scheduledActionError() {
			return mutations.errorFor("cancel-scheduled-action");
		},
		...drafts,
		setActionFieldValue,
		commitActionPreview,
		actionFieldDomId,
		selectAction,
		expandActionForm,
		collapseActionForm,
		submitActionDecision,
		editScheduledAction,
		cancelScheduledAction,
		continueFailedTurn,
		retryFailedTurn,
		retryStartup,
		abortRunningTurn,
		reset,
	};
}
