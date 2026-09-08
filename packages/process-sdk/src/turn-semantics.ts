import {
	assertValidProcessProductName,
	defaultProcessTurnStartSelection,
	type ProcessTurnStartFallback,
	type ProcessTurnStartSelection,
	resolveProcessTurnStartSelection,
} from "@leitwerk-dev/domain";
import type {
	AutomaticTurnDefinition,
	ExternalTurnDefinition,
	HumanTurnDefinition,
	LlmTurnDefinition,
	ProcessToolOutcomeSpec,
	TurnDefinition,
} from "./define-process.js";
import { llmTurn, resolveHumanTurnView } from "./define-process.js";
import { validatePiBuiltInToolArray } from "./pi-config.js";
import { REQUIRED_MARKDOWN_RESULT_TURN_RESULT } from "./tool-renderers.js";
import {
	type OutcomeToolParameterSpec,
	type ProcessActionPreviewDefinition,
	type ProcessActionSchedulingDefinition,
	RESERVED_INTEGRATION_TOOL_NAMES,
	type TurnBranchType,
} from "./types.js";

export function isLlmTurnDefinition<TParams = unknown, TState = unknown>(
	turnDef: TurnDefinition<TParams, TState>,
): turnDef is LlmTurnDefinition<string, TParams, TState> {
	return turnDef.kind === "llm";
}

export function isAutomaticTurnDefinition<TParams = unknown, TState = unknown>(
	turnDef: TurnDefinition<TParams, TState>,
): turnDef is AutomaticTurnDefinition<string, TParams, TState> {
	return turnDef.kind === "automatic";
}

export function isHumanTurnDefinition<TParams = unknown, TState = unknown>(
	turnDef: TurnDefinition<TParams, TState>,
): turnDef is HumanTurnDefinition<TParams, TState> {
	return turnDef.kind === "human";
}

export function isExternalTurnDefinition<TParams = unknown, TState = unknown>(
	turnDef: TurnDefinition<TParams, TState>,
): turnDef is ExternalTurnDefinition<TParams, TState> {
	return turnDef.kind === "external";
}

export function defaultTurnStartSelection(branchType: TurnBranchType): ProcessTurnStartFallback {
	return defaultProcessTurnStartSelection(branchType);
}

export function resolveLlmTurnStartSelection<TOutcome extends string = string>(
	turnDef: Pick<LlmTurnDefinition<TOutcome>, "branchType" | "startFrom">,
): ProcessTurnStartSelection {
	return resolveProcessTurnStartSelection(turnDef);
}

export function resolveLlmTurnRestorePrimaryLeafAfterTurn<TOutcome extends string = string>(
	turnDef: Pick<LlmTurnDefinition<TOutcome>, "branchType" | "restorePrimaryLeafAfterTurn">,
): boolean {
	return turnDef.restorePrimaryLeafAfterTurn ?? turnDef.branchType !== "primary";
}

export function validateProcessActionPreviewDefinition(
	preview: ProcessActionPreviewDefinition | undefined,
	context: string,
): string[] {
	if (!preview) {
		return [];
	}
	if (preview.kind === "trigger") {
		return preview.trigger.trim() ? [] : [`${context} must declare a non-empty trigger preview`];
	}
	if (preview.kind === "terminal") {
		return [];
	}
	if (preview.turnId === null || preview.turnId.trim()) {
		return [];
	}
	return [`${context} must declare a non-empty fixed turn id when turnId is not null`];
}

export function validateProcessActionSchedulingDefinition(
	scheduling: ProcessActionSchedulingDefinition | undefined,
	context: string,
): string[] {
	return validateProcessActionPreviewDefinition(scheduling?.preview, context);
}

function hasDuplicateBy<TItem>(
	items: readonly TItem[],
	selectKey: (item: TItem) => string,
): boolean {
	const ids = new Set<string>();
	for (const item of items) {
		const key = selectKey(item);
		if (ids.has(key)) {
			return true;
		}
		ids.add(key);
	}
	return false;
}

function validateOutcomeTurnResultContract<TParams = unknown, TState = unknown>(
	turnKindLabel: string,
	turnId: string,
	outcomes: Partial<Record<string, ProcessToolOutcomeSpec<TParams, TState>>> | undefined,
	turnEnd: unknown,
): string[] {
	const errors: string[] = [];
	const hasOutcomeTools = Object.keys(outcomes ?? {}).length > 0;
	const hasTurnEndResult = turnEnd !== undefined;
	if (!hasOutcomeTools && !hasTurnEndResult) {
		errors.push(
			`${turnKindLabel} turn '${turnId}' must declare at least one outcome tool or a turnEnd result`,
		);
	}
	if (hasOutcomeTools && hasTurnEndResult) {
		errors.push(`${turnKindLabel} turn '${turnId}' cannot declare both outcomes and turnEnd`);
	}
	return errors;
}

function isValidOutcomeToolArrayItemType(type: unknown): boolean {
	return type === "string" || type === "number" || type === "boolean" || type === "object";
}

function validateOutcomeToolParameters<TParams = unknown, TState = unknown>(
	turnKindLabel: string,
	turnId: string,
	outcomes: Partial<Record<string, ProcessToolOutcomeSpec<TParams, TState>>> | undefined,
): string[] {
	const errors: string[] = [];
	for (const [outcome, outcomeSpec] of Object.entries(outcomes ?? {}) as Array<
		[string, ProcessToolOutcomeSpec<TParams, TState>]
	>) {
		if (outcomeSpec.publishedProduct) {
			try {
				assertValidProcessProductName(outcomeSpec.publishedProduct);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
			const parameterName = outcomeSpec.turnResultMarkdownParameter?.trim() ?? "";
			if (!parameterName) {
				errors.push(
					`${turnKindLabel} turn '${turnId}' outcome '${outcome}' publishes product '${outcomeSpec.publishedProduct}' but does not declare a turn-result markdown parameter`,
				);
			} else if (!Object.hasOwn(outcomeSpec.parameters, parameterName)) {
				errors.push(
					`${turnKindLabel} turn '${turnId}' outcome '${outcome}' publishes product '${outcomeSpec.publishedProduct}' from missing parameter '${parameterName}'`,
				);
			}
		}
		for (const [paramName, paramSpec] of Object.entries(outcomeSpec.parameters) as Array<
			[string, OutcomeToolParameterSpec]
		>) {
			if (paramSpec.minItems !== undefined && paramSpec.type !== "array") {
				errors.push(
					`${turnKindLabel} turn '${turnId}' outcome '${outcome}' parameter '${paramName}' uses minItems but is not an array`,
				);
			}
			if (paramSpec.minimum !== undefined && paramSpec.type !== "number") {
				errors.push(
					`${turnKindLabel} turn '${turnId}' outcome '${outcome}' parameter '${paramName}' uses minimum but is not a number`,
				);
			}
			if (paramSpec.items !== undefined && paramSpec.type !== "array") {
				errors.push(
					`${turnKindLabel} turn '${turnId}' outcome '${outcome}' parameter '${paramName}' declares array items but is not an array`,
				);
			}
			if (paramSpec.type === "array") {
				if (!paramSpec.items) {
					errors.push(
						`${turnKindLabel} turn '${turnId}' outcome '${outcome}' parameter '${paramName}' is an array and must declare items`,
					);
				} else if (!isValidOutcomeToolArrayItemType(paramSpec.items.type)) {
					errors.push(
						`${turnKindLabel} turn '${turnId}' outcome '${outcome}' parameter '${paramName}' declares unsupported array item type '${String(paramSpec.items.type)}'`,
					);
				}
			}
		}
	}
	return errors;
}

function assertNoValidationErrors(errors: readonly string[]): void {
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
}

function validateTurnStartSelection(
	turnId: string,
	startFrom: ProcessTurnStartSelection,
	context = "startFrom",
): string[] {
	const errors: string[] = [];
	if (startFrom.kind === "entry" && startFrom.entryId.trim() === "") {
		errors.push(`LLM turn '${turnId}' ${context} entry id must be non-empty`);
	}
	if (startFrom.kind === "product_ref") {
		try {
			assertValidProcessProductName(startFrom.productName);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if ("fallback" in startFrom && startFrom.fallback) {
		errors.push(...validateTurnStartSelection(turnId, startFrom.fallback, `${context} fallback`));
	}
	return errors;
}

export function validateLlmTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
>(turnId: string, turnDef: LlmTurnDefinition<TOutcome, TParams, TState>): string[] {
	const errors: string[] = [];
	const declaredOutcomes = turnDef.outcomes;
	const startFrom = resolveLlmTurnStartSelection(turnDef);

	if ((turnDef.completionMode ?? "turn_end") !== "turn_end") {
		errors.push(`LLM turn '${turnId}' must use completionMode 'turn_end'`);
	}

	const declaredTurnEnd = turnDef.turnEnd;
	errors.push(
		...validateOutcomeTurnResultContract("LLM", turnId, declaredOutcomes, declaredTurnEnd),
	);

	if (turnDef.branchType === "root_branch" && startFrom.kind === "current_leaf") {
		errors.push(
			`LLM turn '${turnId}' uses branchType 'root_branch' but starts from the current leaf`,
		);
	}

	if (turnDef.branchType === "leaf_branch" && startFrom.kind === "session_root") {
		errors.push(
			`LLM turn '${turnId}' uses branchType 'leaf_branch' but starts from the session root`,
		);
	}

	errors.push(...validateTurnStartSelection(turnId, startFrom));

	if (turnDef.askQuestions !== undefined && turnDef.askQuestions !== true) {
		errors.push(`LLM turn '${turnId}' askQuestions must be true when declared`);
	}

	if (!Array.isArray(turnDef.availableTools)) {
		errors.push(`LLM turn '${turnId}' must declare availableTools as an array`);
	} else {
		errors.push(
			...validatePiBuiltInToolArray(turnDef.availableTools, `LLM turn '${turnId}' availableTools`),
		);
	}

	if (turnDef.integrationTools !== undefined) {
		if (!Array.isArray(turnDef.integrationTools)) {
			errors.push(`LLM turn '${turnId}' integrationTools must be an array`);
		} else {
			const seen = new Set<string>();
			const conflictingNames = new Set<string>([
				...RESERVED_INTEGRATION_TOOL_NAMES,
				...Object.keys(declaredOutcomes ?? {}),
			]);
			for (const name of turnDef.integrationTools) {
				if (typeof name !== "string" || name.trim() === "") {
					errors.push(`LLM turn '${turnId}' integration tool names must be non-empty strings`);
					continue;
				}
				if (seen.has(name)) {
					errors.push(`LLM turn '${turnId}' declares duplicate integration tool '${name}'`);
				}
				if (conflictingNames.has(name)) {
					errors.push(
						`LLM turn '${turnId}' integration tool '${name}' conflicts with a built-in, framework, or outcome tool`,
					);
				}
				seen.add(name);
			}
		}
	}

	if (turnDef.turnResultMarkdown?.mode === "tool_call") {
		if (turnDef.turnResultMarkdown.toolName.trim() === "") {
			errors.push(
				`LLM turn '${turnId}' tool-call turnResultMarkdown must use a non-empty toolName`,
			);
		}
		if (turnDef.turnResultMarkdown.path.trim() === "") {
			errors.push(`LLM turn '${turnId}' tool-call turnResultMarkdown must use a non-empty path`);
		}
	}
	if (turnDef.turnResultMarkdown?.mode === "outcome_tool_argument") {
		const parameterName = turnDef.turnResultMarkdown.parameterName.trim();
		const outcomeEntries = Object.entries(declaredOutcomes ?? {}) as Array<
			[string, ProcessToolOutcomeSpec<TParams, TState>]
		>;
		if (parameterName === "") {
			errors.push(
				`LLM turn '${turnId}' outcome-tool turnResultMarkdown must use a non-empty parameterName`,
			);
		}
		if (outcomeEntries.length === 0) {
			errors.push(
				`LLM turn '${turnId}' outcome-tool turnResultMarkdown requires at least one outcome tool`,
			);
		}
		for (const [outcomeId, spec] of outcomeEntries) {
			if (parameterName in spec.parameters) {
				errors.push(
					`LLM turn '${turnId}' outcome tool '${outcomeId}' cannot declare reserved markdown parameter '${parameterName}'`,
				);
			}
		}
	}

	errors.push(...validateOutcomeToolParameters("LLM", turnId, declaredOutcomes));

	return errors;
}

export function validateAutomaticTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
>(turnId: string, turnDef: AutomaticTurnDefinition<TOutcome, TParams, TState>): string[] {
	const errors: string[] = [];
	const declaredOutcomes = turnDef.outcomes;
	const declaredTurnEnd = turnDef.turnEnd;
	errors.push(
		...validateOutcomeTurnResultContract("Automatic", turnId, declaredOutcomes, declaredTurnEnd),
	);
	errors.push(...validateOutcomeToolParameters("Automatic", turnId, declaredOutcomes));

	return errors;
}

export function validateHumanTurnDefinition<TParams = unknown, TState = unknown>(
	turnId: string,
	turnDef: HumanTurnDefinition<TParams, TState>,
): string[] {
	const errors: string[] = [];

	try {
		resolveHumanTurnView({ turnId, turn: turnDef });
	} catch (error: unknown) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (turnDef.reviewProduct) {
		try {
			assertValidProcessProductName(turnDef.reviewProduct);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	const actionEntries = Object.entries(turnDef.actions) as Array<
		[string, HumanTurnDefinition<TParams, TState>["actions"][string]]
	>;
	if (actionEntries.length === 0) {
		errors.push(`Human turn '${turnId}' must declare at least one action`);
	}
	for (const [actionId, action] of actionEntries) {
		if (!action.acceptanceState) {
			errors.push(`Human turn '${turnId}' is missing an acceptance state for action '${actionId}'`);
		}
		errors.push(
			...validateProcessActionPreviewDefinition(
				action.preview,
				`Human turn '${turnId}' action '${actionId}' preview`,
			),
		);
	}

	const externalTriggers = actionEntries.flatMap(([actionId, action]) =>
		(action.externalTriggers ?? []).map((trigger) => ({ actionId, trigger })),
	);
	if (hasDuplicateBy(externalTriggers, ({ trigger }) => trigger.id)) {
		errors.push(`Human turn '${turnId}' contains duplicate external trigger ids`);
	}
	if (hasDuplicateBy(externalTriggers, ({ actionId }) => actionId)) {
		errors.push(`Human turn '${turnId}' contains duplicate external trigger action ids`);
	}
	for (const { actionId, trigger } of externalTriggers) {
		if (trigger.id.trim() === "") {
			errors.push(`Human turn '${turnId}' contains an external trigger with an empty id`);
		}
		if (actionId.trim() === "") {
			errors.push(
				`Human turn '${turnId}' external trigger '${trigger.id}' must declare a non-empty actionId`,
			);
		}
		if (trigger.label.trim() === "") {
			errors.push(
				`Human turn '${turnId}' external trigger '${trigger.id}' must declare a non-empty label`,
			);
		}
		if (trigger.description.trim() === "") {
			errors.push(
				`Human turn '${turnId}' external trigger '${trigger.id}' must declare a non-empty description`,
			);
		}
	}

	const externalActionEntries = Object.entries(turnDef.externalActions ?? {});
	if (hasDuplicateBy(externalActionEntries, ([externalActionId]) => externalActionId)) {
		errors.push(`Human turn '${turnId}' contains duplicate external action ids`);
	}
	for (const [externalActionId, externalAction] of externalActionEntries) {
		if (externalActionId.trim() === "") {
			errors.push(`Human turn '${turnId}' contains an external action with an empty id`);
		}
		if (externalAction.id !== externalActionId) {
			errors.push(
				`Human turn '${turnId}' external action '${externalActionId}' has mismatched id '${externalAction.id}'`,
			);
		}
		if (externalAction.source.kind.trim() === "") {
			errors.push(
				`Human turn '${turnId}' external action '${externalActionId}' must declare a non-empty source kind`,
			);
		}
		const targetCount =
			(externalAction.to !== undefined ? 1 : 0) +
			(externalAction.complete === true ? 1 : 0) +
			(externalAction.lifecycleStatus !== undefined ? 1 : 0);
		if (targetCount !== 1) {
			errors.push(
				`Human turn '${turnId}' external action '${externalActionId}' must declare exactly one target`,
			);
		}
		if (externalAction.publishInput) {
			try {
				assertValidProcessProductName(externalAction.publishInput.productName);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
			if (externalAction.publishInput.inputField.trim() === "") {
				errors.push(
					`Human turn '${turnId}' external action '${externalActionId}' publishInput must declare a non-empty inputField`,
				);
			}
			if (externalAction.complete === true || externalAction.lifecycleStatus !== undefined) {
				errors.push(
					`Human turn '${turnId}' external action '${externalActionId}' cannot publish input on a terminal route`,
				);
			}
		}
	}

	const notesFields = turnDef.notesFields ?? [];
	if (hasDuplicateBy(notesFields, (field) => field.id)) {
		const noteIds = new Set<string>();
		for (const field of notesFields) {
			if (noteIds.has(field.id)) {
				errors.push(`Human turn '${turnId}' contains duplicate notes field id '${field.id}'`);
				break;
			}
			noteIds.add(field.id);
		}
	}

	return errors;
}

export function validateExternalTurnDefinition<TParams = unknown, TState = unknown>(
	turnId: string,
	turnDef: ExternalTurnDefinition<TParams, TState>,
): string[] {
	const errors: string[] = [];
	if (turnDef.transitions.length === 0) {
		errors.push(`External turn '${turnId}' must declare at least one source transition`);
	}
	for (const [index, transition] of turnDef.transitions.entries()) {
		if (transition.source.kind.trim() === "") {
			errors.push(
				`External turn '${turnId}' source transition ${index} must declare a non-empty kind`,
			);
		}
		const targetCount =
			(transition.to !== undefined ? 1 : 0) +
			(transition.complete === true ? 1 : 0) +
			(transition.lifecycleStatus !== undefined ? 1 : 0);
		if (targetCount !== 1) {
			errors.push(
				`External turn '${turnId}' source transition ${index} must declare exactly one target`,
			);
		}
	}
	return errors;
}

export function validateTurnDefinition<TParams = unknown, TState = unknown>(
	turnId: string,
	turnDef: TurnDefinition<TParams, TState>,
): string[];
export function validateTurnDefinition<TParams = unknown, TState = unknown>(
	turnDef: TurnDefinition<TParams, TState>,
): string[];
export function validateTurnDefinition<TParams = unknown, TState = unknown>(
	turnIdOrDef: string | TurnDefinition<TParams, TState>,
	turnDef?: TurnDefinition<TParams, TState>,
): string[] {
	const effectiveTurnDef = typeof turnIdOrDef === "string" ? turnDef : turnIdOrDef;
	const effectiveTurnId =
		typeof turnIdOrDef === "string"
			? turnIdOrDef
			: ((turnIdOrDef as { id?: string }).id ?? "unknown_turn");
	if (!effectiveTurnDef) {
		return ["Turn definition is required"];
	}
	return isLlmTurnDefinition(effectiveTurnDef)
		? validateLlmTurnDefinition(effectiveTurnId, effectiveTurnDef)
		: isAutomaticTurnDefinition(effectiveTurnDef)
			? validateAutomaticTurnDefinition(effectiveTurnId, effectiveTurnDef)
			: isHumanTurnDefinition(effectiveTurnDef)
				? validateHumanTurnDefinition(effectiveTurnId, effectiveTurnDef)
				: validateExternalTurnDefinition(effectiveTurnId, effectiveTurnDef);
}

export function assertValidLlmTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
>(turnId: string, turnDef: LlmTurnDefinition<TOutcome, TParams, TState>): void {
	assertNoValidationErrors(validateLlmTurnDefinition(turnId, turnDef));
}

export function createRootBranchReviewTurn<
	TOutcome extends string,
	TParams = unknown,
	TState = unknown,
>(
	def: Omit<
		LlmTurnDefinition<TOutcome, TParams, TState>,
		"kind" | "branchType" | "completionMode" | "startFrom" | "restorePrimaryLeafAfterTurn"
	> &
		Partial<
			Pick<
				LlmTurnDefinition<TOutcome, TParams, TState>,
				"completionMode" | "startFrom" | "restorePrimaryLeafAfterTurn"
			>
		>,
): LlmTurnDefinition<TOutcome, TParams, TState> {
	const {
		completionMode = "turn_end",
		startFrom = { kind: "session_root" },
		restorePrimaryLeafAfterTurn = true,
		turnResultMarkdown = REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
		...rest
	} = def;

	return llmTurn({
		completionMode,
		branchType: "root_branch",
		startFrom,
		restorePrimaryLeafAfterTurn,
		turnResultMarkdown,
		...rest,
	});
}
