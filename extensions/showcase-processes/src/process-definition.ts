import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AutomaticOutcomeBuilder,
	type Codec,
	createEmptyStructuralProcessState,
	type FormDefinition,
	flow,
	type HumanFlowBuilder,
	parseStructuralProcessState,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { fileExternal } from "./file-external.js";
import { filesystemWatcherSource } from "./filesystem-watcher.js";
import {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
	resolvePoemLeafMarkdown,
} from "./poem-leaf-outcome.js";
import {
	externalPromptCompletionTurnDescription,
	externalPromptCompletionTurnId,
} from "./turns/external-complete.js";
import {
	buildDefaultPoemPrompt,
	buildDraftPoemInstruction,
	buildReviewPoemInstruction,
	buildRevisePoemInstruction,
	poemCreatorActionIds,
} from "./turns/poem-creator.js";
import {
	buildSinglePromptInstruction,
	buildSinglePromptWithToolInstruction,
} from "./turns/run-single-prompt.js";

interface PromptProcessParams {
	prompt: string;
}

interface PoemCreatorState extends StructuralProcessState {
	latestReviewMarkdown: string | null;
	latestReviewSummary: string | null;
	latestReviewOutcome: "no_issues" | "leave_feedback" | null;
}

const promptProcessParamsCodec: Codec<PromptProcessParams> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const structuralStateCodec: Codec<StructuralProcessState> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

const poemCreatorStateCodec: Codec<PoemCreatorState> = {
	parse(value) {
		const structural = parseStructuralProcessState(value);
		const record =
			typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
		const latestReviewOutcome =
			typeof record.latestReviewOutcome === "string"
				? record.latestReviewOutcome === "issues_found"
					? "leave_feedback"
					: record.latestReviewOutcome === "no_issues" ||
							record.latestReviewOutcome === "leave_feedback"
						? record.latestReviewOutcome
						: null
				: null;
		return {
			...structural,
			latestReviewMarkdown:
				typeof record.latestReviewMarkdown === "string" ? record.latestReviewMarkdown : null,
			latestReviewSummary:
				typeof record.latestReviewSummary === "string" ? record.latestReviewSummary : null,
			latestReviewOutcome,
		};
	},
	serialize(value) {
		return value;
	},
};

function validateLaunchInput(input: Record<string, unknown>, fallbackPrompt?: string) {
	const inputPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	const prompt = inputPrompt || fallbackPrompt?.trim() || "";
	if (!prompt) {
		return {
			ok: false as const,
			errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
		};
	}
	return {
		ok: true as const,
		prompt,
	};
}

function buildPromptTitleSourceFields(prompt: string, label = "Prompt") {
	return [{ label, value: prompt }] as const;
}

function clearReviewRefs(state: PoemCreatorState["semanticEntryRefs"]) {
	return {
		...state,
		review: null,
	};
}

function patchPoemCreatorState(
	state: PoemCreatorState,
	input: {
		latestReviewMarkdown?: PoemCreatorState["latestReviewMarkdown"];
		latestReviewSummary?: PoemCreatorState["latestReviewSummary"];
		latestReviewOutcome?: PoemCreatorState["latestReviewOutcome"];
		semanticEntryRefs?: PoemCreatorState["semanticEntryRefs"];
		clearReviewRefs?: boolean;
	},
): PoemCreatorState {
	const nextState: PoemCreatorState = {
		...state,
		...("latestReviewMarkdown" in input
			? { latestReviewMarkdown: input.latestReviewMarkdown ?? null }
			: {}),
		...("latestReviewSummary" in input
			? { latestReviewSummary: input.latestReviewSummary ?? null }
			: {}),
		...("latestReviewOutcome" in input
			? { latestReviewOutcome: input.latestReviewOutcome ?? null }
			: {}),
		...("semanticEntryRefs" in input ? { semanticEntryRefs: input.semanticEntryRefs } : {}),
	};
	if (!input.clearReviewRefs) {
		return nextState;
	}
	return {
		...nextState,
		semanticEntryRefs: clearReviewRefs(nextState.semanticEntryRefs),
	};
}

function buildPoemLeafReview(state: PoemCreatorState) {
	if (!state.latestReviewOutcome) {
		return null;
	}
	return {
		outcome: state.latestReviewOutcome,
		summary: state.latestReviewSummary,
		feedback: state.latestReviewOutcome === "leave_feedback" ? state.latestReviewMarkdown : null,
	};
}

function createMarkdownLeafOutcome(rendererId: string) {
	return {
		rendererId,
		capture(ctx: {
			params: PromptProcessParams;
			leaf: { entryId: string; turnRecordId: string | null };
			turnRecord: { turnResultMarkdown: string | null } | null;
		}) {
			const markdown = ctx.turnRecord?.turnResultMarkdown?.trim() ?? "";
			return {
				rendererId,
				schemaVersion: 1,
				props: {
					prompt: ctx.params.prompt,
					markdown: markdown.length > 0 ? markdown : null,
					leafEntryId: ctx.leaf.entryId,
					turnRecordId: ctx.leaf.turnRecordId,
				},
				fallbackMarkdown: markdown.length > 0 ? markdown : null,
			};
		},
	};
}

function createPoemLeafOutcome(rendererId: string) {
	return {
		rendererId,
		capture(ctx: {
			params: PromptProcessParams;
			state: PoemCreatorState;
			leaf: { entryId: string; turnRecordId: string | null };
			turnRecord: { turnResultMarkdown: string | null } | null;
			readTreeEntry(entryId: string): { message?: { content?: unknown } } | null;
			readLeafEntry(): { message?: { content?: unknown } } | null;
			readTurnRecord(turnRecordId: string): { turnResultMarkdown: string | null } | null;
		}) {
			const reviewLeafEntryId = ctx.state.semanticEntryRefs.review?.entryId ?? null;
			const review = buildPoemLeafReview(ctx.state);
			const isReviewLeaf = reviewLeafEntryId !== null && ctx.leaf.entryId === reviewLeafEntryId;
			const primaryPoemLeafRef = ctx.state.semanticEntryRefs.currentPrimaryPathLeaf;
			const primaryPoemTurnRecord = primaryPoemLeafRef?.turnRecordId
				? ctx.readTurnRecord(primaryPoemLeafRef.turnRecordId)
				: null;
			const markdown = isReviewLeaf
				? resolvePoemLeafMarkdown({
						turnResultMarkdown: primaryPoemTurnRecord?.turnResultMarkdown,
						leafEntry: primaryPoemLeafRef ? ctx.readTreeEntry(primaryPoemLeafRef.entryId) : null,
					})
				: resolvePoemLeafMarkdown({
						turnResultMarkdown: ctx.turnRecord?.turnResultMarkdown,
						leafEntry: ctx.readLeafEntry(),
					});
			if (isReviewLeaf && !review) {
				throw new Error("Poem review leaf outcome requires latestReviewOutcome state");
			}
			if (isReviewLeaf && !markdown) {
				throw new Error("Poem review leaf outcome requires a readable primary poem leaf");
			}
			const fallbackMarkdown = buildPoemLeafOutcomeFallbackMarkdown({
				markdown,
				review: isReviewLeaf ? review : null,
			});
			return {
				rendererId,
				schemaVersion: 1,
				props: buildPoemLeafOutcomePayload({
					prompt: ctx.params.prompt,
					markdown,
					review: isReviewLeaf ? review : null,
				}),
				fallbackMarkdown: fallbackMarkdown || null,
			};
		},
	};
}

const poemTurnIds = {
	draftPoem: "draft_poem",
	poemReview: "poem_review",
	reviewPoemDraft: "review_poem_draft",
	poemReviewFeedback: "poem_review_feedback",
} as const;

const poemRevisionForm: FormDefinition = {
	id: poemCreatorActionIds.requestRevision,
	title: "Request poem revision",
	fields: [
		{
			id: "message",
			label: "Revision request",
			kind: "textarea",
			primaryPrompt: true,
			required: true,
			publish: true,
			description: "Tell the next primary-branch poem draft what should change.",
		},
	],
	submitLabel: "Request revision",
};

const poemReviewChangesForm: FormDefinition = {
	id: poemCreatorActionIds.requestReviewChanges,
	title: "Request review changes",
	fields: [
		{
			id: "message",
			label: "Review revision request",
			kind: "textarea",
			primaryPrompt: true,
			required: true,
			publish: true,
			description: "Tell the review branch how to revise its review output.",
		},
	],
	submitLabel: "Request review changes",
};

export const singlePromptProcess = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_process")
	.displayName("Single Prompt")
	.entry("run_single_prompt")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt")
			.description("Run a single operator-provided prompt and finish on turn end")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptInstruction(ctx.params.prompt))
			.end("completed")
			.complete(),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_process.single_prompt_ui",
		label: "Single Prompt",
		description: "Run one prompt and finish on turn end",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt",
				description:
					"Run a one-shot prompt. The shared launcher shell chooses the model configuration.",
			},
			launchConfigSchema: {
				id: "single_prompt_form",
				title: "Single Prompt",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello.",
						description:
							"The exact prompt sent to Pi for this one-shot run. This version finishes when the assistant turn ends normally.",
					},
				],
				submitLabel: "Run Prompt",
			},
			resolveDefaults() {
				return {
					prompt: "",
				};
			},
			resolveLaunchConfig(input) {
				const validated = validateLaunchInput(input);
				if (!validated.ok) {
					return validated;
				}
				return {
					ok: true,
					launchConfig: {
						processId: "single_prompt_process",
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt),
						startTurnId: "run_single_prompt",
					},
				};
			},
		},
	})
	.define();

export const singlePromptWithToolProcess = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_with_tool_process")
	.displayName("Single Prompt + Done Tool")
	.entry("run_single_prompt_with_tool")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt_with_tool")
			.description("Run a single operator-provided prompt and require the done tool")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptWithToolInstruction(ctx.params.prompt))
			.outcomeTool("done", (tool) =>
				tool
					.description("Mark the prompt run as complete")
					.requiredString("summary", "Short summary of the result")
					.complete(),
			),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_with_tool_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_with_tool_process.single_prompt_with_tool_ui",
		label: "Single Prompt + Done Tool",
		description: "Run one prompt and require an explicit done tool",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt + Done Tool",
				description:
					"Run a one-shot prompt and force an explicit done tool call. The shared launcher shell chooses the model configuration.",
			},
			launchConfigSchema: {
				id: "single_prompt_with_tool_form",
				title: "Single Prompt + Done Tool",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello, then call the done tool with a short summary.",
						description:
							"The exact prompt sent to Pi for this one-shot run. This version requires the explicit done outcome tool.",
					},
				],
				submitLabel: "Run Prompt + Tool",
			},
			resolveDefaults() {
				return {
					prompt: "",
				};
			},
			resolveLaunchConfig(input) {
				const validated = validateLaunchInput(input);
				if (!validated.ok) {
					return validated;
				}
				return {
					ok: true,
					launchConfig: {
						processId: "single_prompt_with_tool_process",
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt),
						startTurnId: "run_single_prompt_with_tool",
					},
				};
			},
		},
	})
	.define();

type SmokeOutcomeBuilder = AutomaticOutcomeBuilder<PromptProcessParams, StructuralProcessState>;
type SmokeRunFn = (ctx: {
	params: PromptProcessParams;
}) =>
	| { params: Record<string, unknown>; markdown: string }
	| Promise<{ params: Record<string, unknown>; markdown: string }>;

/**
 * Builds one of the Kubernetes smoke fixtures: an automatic worker run turn that
 * hands off to a wait turn with a `complete` action (and an optional `run_again`
 * action), plus a UI launcher. The three fixtures share this skeleton and differ
 * only in their ids, run body, and outcome parameter shape.
 */
function defineK8sSmokeProcess(args: {
	processId: string;
	displayName: string;
	runTurnId: string;
	waitTurnId: string;
	runTurnDescription: string;
	outcomeDescription: string;
	describeOutcome?: (outcome: SmokeOutcomeBuilder) => void;
	waitDescription: string;
	waitCommentary?: string;
	runAgain?: { label: string; description: string };
	completeLabel: string;
	launcherId: string;
	launcherDescription: string;
	cardDescription: string;
	formId: string;
	submitLabel: string;
	promptField?: { label: string };
	defaultPrompt: string;
	titleLabel: string;
	run: SmokeRunFn;
}) {
	const promptField = args.promptField;
	const resolveLaunchConfig = promptField
		? (input: Record<string, unknown>) => {
				const validated = validateLaunchInput(input, args.defaultPrompt);
				if (!validated.ok) return validated;
				return {
					ok: true as const,
					launchConfig: {
						processId: args.processId,
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt, args.titleLabel),
						startTurnId: args.runTurnId,
					},
				};
			}
		: () => ({
				ok: true as const,
				launchConfig: {
					processId: args.processId,
					params: { prompt: args.defaultPrompt },
					titleSourceFields: buildPromptTitleSourceFields(args.defaultPrompt, args.titleLabel),
					startTurnId: args.runTurnId,
				},
			});

	const runTurn = flow
		.automatic<PromptProcessParams, StructuralProcessState>(args.runTurnId)
		.description(args.runTurnDescription)
		.run(async (ctx) => {
			const result = await args.run(ctx);
			return { outcome: "ready" as const, ...result };
		})
		.outcome("ready", (outcome) => {
			outcome.description(args.outcomeDescription);
			args.describeOutcome?.(outcome);
			return outcome.to(args.waitTurnId);
		});

	const waitTurn: HumanFlowBuilder<PromptProcessParams, StructuralProcessState> = flow
		.human<PromptProcessParams, StructuralProcessState>(args.waitTurnId)
		.description(args.waitDescription);
	if (args.waitCommentary) {
		waitTurn.commentary(args.waitCommentary);
	}
	if (args.runAgain) {
		const runAgain = args.runAgain;
		waitTurn.action("run_again", (action) =>
			action
				.label(runAgain.label)
				.description(runAgain.description)
				.acceptanceState("neutral")
				.to(args.runTurnId),
		);
	}
	waitTurn.action("complete", (action) =>
		action.label(args.completeLabel).acceptanceState("accepted").complete(),
	);

	return flow
		.process<PromptProcessParams, StructuralProcessState>(args.processId)
		.displayName(args.displayName)
		.entry(args.runTurnId)
		.codecs({ params: promptProcessParamsCodec, state: structuralStateCodec })
		.initialState(() => createEmptyStructuralProcessState())
		.turn(runTurn)
		.turn(waitTurn)
		.launcher({
			id: args.launcherId,
			label: args.displayName,
			description: args.launcherDescription,
			visibility: "ui",
			ui: {
				card: { title: args.displayName, description: args.cardDescription },
				launchConfigSchema: {
					id: args.formId,
					title: args.displayName,
					fields: promptField
						? [{ id: "prompt", label: promptField.label, kind: "text", required: true }]
						: [],
					submitLabel: args.submitLabel,
				},
				...(promptField ? { resolveDefaults: () => ({ prompt: args.defaultPrompt }) } : {}),
				resolveLaunchConfig,
			},
		})
		.define();
}

export const k8sSmokeProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_process",
	displayName: "Kubernetes Smoke",
	runTurnId: "k8s_smoke_run",
	waitTurnId: "k8s_smoke_wait",
	runTurnDescription: "Run a deterministic worker-side Kubernetes smoke step",
	outcomeDescription: "The worker-side smoke step completed",
	describeOutcome: (outcome) => outcome.string("prompt", "The smoke prompt"),
	waitDescription: "Wait after the Kubernetes smoke worker step",
	waitCommentary: "The smoke worker is idle; actions can respawn it on the retained PVC.",
	runAgain: { label: "Run smoke again", description: "Select the worker-side smoke turn again." },
	completeLabel: "Complete smoke",
	launcherId: "k8s_smoke_process.k8s_smoke_ui",
	launcherDescription: "Run a deterministic worker-backed Kubernetes smoke process",
	cardDescription: "Creates a worker pod/PVC and then waits for a follow-up action.",
	formId: "k8s_smoke_form",
	submitLabel: "Run smoke",
	promptField: { label: "Smoke prompt" },
	defaultPrompt: "kind smoke",
	titleLabel: "Smoke",
	run: (ctx) => ({
		params: { prompt: ctx.params.prompt },
		markdown: `Kubernetes smoke worker ran: ${ctx.params.prompt}`,
	}),
});

export const k8sSmokeSpecializedProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_specialized_process",
	displayName: "Kubernetes Specialized Smoke",
	runTurnId: "k8s_smoke_specialized_run",
	waitTurnId: "k8s_smoke_specialized_wait",
	runTurnDescription: "Verify the specialized Kubernetes worker image tool path",
	outcomeDescription: "The specialized image tool ran",
	describeOutcome: (outcome) => outcome.requiredString("output", "Tool output"),
	waitDescription: "Wait after specialized image verification",
	waitCommentary: "The specialized Kubernetes image was selected and executed its smoke tool.",
	completeLabel: "Complete specialized smoke",
	launcherId: "k8s_smoke_specialized_process.k8s_smoke_specialized_ui",
	launcherDescription: "Run a deterministic worker-backed process on the specialized smoke image",
	cardDescription: "Validates runtime-profile image selection with a deterministic tool.",
	formId: "k8s_smoke_specialized_form",
	submitLabel: "Run specialized smoke",
	defaultPrompt: "specialized",
	titleLabel: "Smoke",
	run: () => {
		const output = execFileSync("leitwerk-specialized-tool", { encoding: "utf8" }).trim();
		return { params: { output }, markdown: output };
	},
});

export const k8sSmokeLongProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_long_process",
	displayName: "Kubernetes Long Smoke",
	runTurnId: "k8s_smoke_long_run",
	waitTurnId: "k8s_smoke_long_wait",
	runTurnDescription: "Stay busy long enough for server restart adoption tests",
	outcomeDescription: "The long smoke step completed",
	waitDescription: "Wait after long smoke",
	completeLabel: "Complete long smoke",
	launcherId: "k8s_smoke_long_process.k8s_smoke_long_ui",
	launcherDescription: "Run a long worker-backed process for server restart adoption tests",
	cardDescription: "Keeps a worker pod busy while the server restarts.",
	formId: "k8s_smoke_long_form",
	submitLabel: "Run long smoke",
	defaultPrompt: "long",
	titleLabel: "Smoke",
	run: async () => {
		await delay(90_000);
		return { params: {}, markdown: "long smoke completed" };
	},
});

export const singlePromptExternalCompleteProcess = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_external_complete_process")
	.displayName("Single Prompt + External Complete")
	.entry("run_single_prompt")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt")
			.description("Run a single operator-provided prompt and finish on turn end")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptInstruction(ctx.params.prompt))
			.end("completed")
			.to(externalPromptCompletionTurnId),
	)
	.turn(
		flow
			.external<PromptProcessParams, StructuralProcessState>(externalPromptCompletionTurnId)
			.description(externalPromptCompletionTurnDescription)
			.from(
				fileExternal.presence({
					path: "/tmp/complete-prompt",
					pollInterval: "1s",
					consume: "delete",
				}),
			)
			.complete(),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_external_complete_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_external_complete_process.single_prompt_external_complete_ui",
		label: "Single Prompt + External Complete",
		description: "Run one prompt, then wait for the external complete trigger file",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt + External Complete",
				description:
					"Run a one-shot prompt, preserve its result in the chronicle, and finish only when the external completion trigger fires.",
			},
			launchConfigSchema: {
				id: "single_prompt_external_complete_form",
				title: "Single Prompt + External Complete",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello, then wait for the external completion file.",
						description:
							"The prompt runs once. After it finishes, the process waits for the configured prompt-complete trigger file (default: /tmp/complete-prompt).",
					},
				],
				submitLabel: "Run Prompt",
			},
			resolveDefaults() {
				return {
					prompt: "",
				};
			},
			resolveLaunchConfig(input) {
				const validated = validateLaunchInput(input);
				if (!validated.ok) {
					return validated;
				}
				return {
					ok: true,
					launchConfig: {
						processId: "single_prompt_external_complete_process",
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt),
						startTurnId: "run_single_prompt",
					},
				};
			},
		},
	})
	.define();

const poemDraftReviewSpec = flow
	.human<PromptProcessParams, PoemCreatorState>(poemTurnIds.poemReview)
	.description("Human review of the drafted poem on the primary branch")
	.reviewProduct("poem-draft")
	.notesFields([
		{
			id: "message",
			label: "Revision notes",
			placeholder: "Ask for a different tone, tighter rhythm, or stronger imagery",
		},
	])
	.commentary(
		"Review the poem on the primary branch, complete it, request another draft, or send it to automated review.",
	)
	.action(poemCreatorActionIds.completePoem, (action) =>
		action
			.label("Complete poem")
			.description("Accept the current poem and finish the process.")
			.acceptanceState("accepted")
			.complete(),
	)
	.action(poemCreatorActionIds.requestRevision, (action) =>
		action
			.label("Request revision")
			.description("Send the poem back for another primary-branch draft.")
			.acceptanceState("requires_changes")
			.form(poemRevisionForm)
			.trigger("revision_requested")
			.schedulable()
			.to(poemTurnIds.draftPoem),
	)
	.action(poemCreatorActionIds.runAutoReview, (action) =>
		action
			.label("Run automated review")
			.description("Send the current poem draft to the LLM reviewer.")
			.acceptanceState("neutral")
			.trigger("operator_re_review")
			.schedulable()
			.to(poemTurnIds.reviewPoemDraft)
			.effect(({ ctx }) => ({
				state: patchPoemCreatorState(ctx.state, {
					latestReviewMarkdown: null,
					latestReviewSummary: null,
					latestReviewOutcome: null,
					clearReviewRefs: true,
				}),
			})),
	)
	.externalAction(
		"poem_review_file",
		fileExternal.instruction({
			path: "/tmp/poem-review-{instanceId}",
			pollInterval: "1s",
			consume: "delete",
		}),
		(external) =>
			external
				.label("Configured poem review file")
				.description("Write revision feedback to the configured poem-review file")
				.publishInput("message", { inputField: "instruction" })
				.to(poemTurnIds.draftPoem),
	).definition;

const poemReviewFeedbackSpec = flow
	.human<PromptProcessParams, PoemCreatorState>(poemTurnIds.poemReviewFeedback)
	.description("Human review of the LLM review output")
	.reviewProduct("message")
	.notesFields([
		{
			id: "message",
			label: "Review feedback notes",
			placeholder: "Explain what the LLM reviewer should change in its review",
		},
	])
	.commentary(
		"Review the review output itself. Accept it to pass the feedback to the primary branch, request changes to continue on the same review branch, or dismiss it and return to the poem decision.",
	)
	.action(poemCreatorActionIds.acceptReview, (action) =>
		action
			.label("Accept review")
			.description(
				"Accept the current review outcome and continue with the primary-branch poem flow.",
			)
			.acceptanceState("accepted")
			.to(poemTurnIds.draftPoem),
	)
	.action(poemCreatorActionIds.requestReviewChanges, (action) =>
		action
			.label("Request review changes")
			.description("Ask the LLM reviewer to revise its review on the review branch.")
			.acceptanceState("requires_changes")
			.form(poemReviewChangesForm)
			.trigger("operator_re_review")
			.schedulable()
			.to(poemTurnIds.reviewPoemDraft),
	)
	.action(poemCreatorActionIds.dismissReview, (action) =>
		action
			.label("Dismiss review")
			.description("Return to the poem decision without applying the review feedback.")
			.acceptanceState("neutral")
			.to(poemTurnIds.poemReview)
			.effect(({ ctx }) => ({
				state: patchPoemCreatorState(ctx.state, {
					latestReviewMarkdown: null,
					latestReviewSummary: null,
					latestReviewOutcome: null,
					clearReviewRefs: true,
				}),
			})),
	).definition;

export const poemCreatorProcess = flow
	.process<PromptProcessParams, PoemCreatorState>("poem_creator_process")
	.displayName("Poem Creator")
	.entry(poemTurnIds.draftPoem)
	.codecs({
		params: promptProcessParamsCodec,
		state: poemCreatorStateCodec,
	})
	.initialState(() => ({
		...createEmptyStructuralProcessState(),
		latestReviewMarkdown: null,
		latestReviewSummary: null,
		latestReviewOutcome: null,
	}))
	.turn(
		flow
			.llm<PromptProcessParams, PoemCreatorState>(poemTurnIds.draftPoem)
			.description("Draft poem")
			.fullPrimary()
			.continueFromPrimaryLeaf()
			.optionalConsume("message")
			.buildPrompt(async (ctx) => {
				const message = ctx.input.message?.trim();
				return message
					? buildRevisePoemInstruction(message)
					: buildDraftPoemInstruction(ctx.params.prompt);
			})
			.publish("poem-draft")
			.to(poemTurnIds.poemReview)
			.state(({ ctx }) =>
				patchPoemCreatorState(ctx.state, {
					latestReviewMarkdown: null,
					latestReviewSummary: null,
					latestReviewOutcome: null,
					clearReviewRefs: true,
				}),
			),
	)
	.turn({ id: poemTurnIds.poemReview, definition: poemDraftReviewSpec })
	.turn(
		flow
			.llm<PromptProcessParams, PoemCreatorState>(poemTurnIds.reviewPoemDraft)
			.description("Review poem")
			.rootBranchReview()
			.continueFromReviewBranch()
			.consume("poem-draft")
			.optionalConsume("message")
			.buildPrompt(async (ctx) => {
				const message = ctx.input.message?.trim();
				const poemDraft = ctx.input["poem-draft"];
				if (!poemDraft) {
					throw new Error("Review poem turn requires poem-draft input");
				}
				const reviewInstruction = buildReviewPoemInstruction(ctx.params.prompt, poemDraft);
				return message
					? `${reviewInstruction}\n\nReviewer revision guidance:\n${message}`
					: reviewInstruction;
			})
			.outcomeTool("no_issues", (tool) =>
				tool
					.description("The poem is ready to publish")
					.requiredString("summary", "Short confirmation summary")
					.markdown("review", {
						description: "Concise review opinion confirming the poem is ready",
						publish: true,
					})
					.to(poemTurnIds.poemReview)
					.state(({ ctx, event }) =>
						patchPoemCreatorState(ctx.state, {
							latestReviewMarkdown: null,
							latestReviewSummary:
								typeof event.params.summary === "string" ? event.params.summary : null,
							latestReviewOutcome: "no_issues",
						}),
					),
			)
			.outcomeTool("leave_feedback", (tool) =>
				tool
					.description("Leave concise feedback for the human reviewer")
					.requiredString("summary", "Short summary of the feedback")
					.markdown("message", {
						description: "Concise plain-text feedback describing what to improve",
						publish: true,
					})
					.to(poemTurnIds.poemReviewFeedback)
					.state(({ ctx, event }) =>
						patchPoemCreatorState(ctx.state, {
							latestReviewMarkdown:
								typeof event.params.message === "string"
									? event.params.message
									: (ctx.output?.content ?? null),
							latestReviewSummary:
								typeof event.params.summary === "string" ? event.params.summary : null,
							latestReviewOutcome: "leave_feedback",
						}),
					),
			),
	)
	.turn({ id: poemTurnIds.poemReviewFeedback, definition: poemReviewFeedbackSpec })
	.ui((api) => {
		api.leafOutcome(
			createPoemLeafOutcome("@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome"),
		);
	})
	.launcher({
		id: "poem_creator_process.poem_creator_ui",
		label: "Poem Creator",
		description:
			"Create a poem, review it on the primary branch, and optionally send it through a human-gated llm review loop",
		visibility: "ui",
		ui: {
			card: {
				title: "Poem Creator",
				description:
					"A fast multi-step demo: poem drafting on the primary branch plus a human-gated llm review branch.",
			},
			launchConfigSchema: {
				id: "poem_creator_form",
				title: "Poem Creator",
				fields: [
					{
						id: "prompt",
						label: "Poem Prompt",
						kind: "textarea",
						required: true,
						placeholder:
							"Write a short poem about the weather in Berlin or the joy of shipping cloud software.",
						description:
							"Leave the prefilled prompt as-is to try the feature immediately, or replace it with your own poem idea.",
					},
				],
				submitLabel: "Create Poem",
			},
			resolveDefaults() {
				return {
					prompt: buildDefaultPoemPrompt(),
				};
			},
			resolveLaunchConfig(input) {
				const validated = validateLaunchInput(input, buildDefaultPoemPrompt());
				if (!validated.ok) {
					return validated;
				}
				return {
					ok: true,
					launchConfig: {
						processId: "poem_creator_process",
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt, "Poem Prompt"),
						startTurnId: poemTurnIds.draftPoem,
					},
				};
			},
		},
	})
	.watcher({
		id: "create_poem",
		label: "Create Poem from File",
		description:
			"Launch Poem Creator whenever the configured filesystem watcher finds a prompt file",
		source: filesystemWatcherSource,
		resolveLaunchConfig(event) {
			const prompt = event.content.trim();
			return {
				processId: "poem_creator_process",
				params: { prompt },
				titleSourceFields: buildPromptTitleSourceFields(prompt, "Poem Prompt"),
				startTurnId: poemTurnIds.draftPoem,
			};
		},
	})
	.define();
