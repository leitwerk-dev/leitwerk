import {
	type Codec,
	createEmptyStructuralProcessState,
	type FormDefinition,
	flow,
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
	buildDefaultPoemPrompt,
	buildDraftPoemInstruction,
	buildReviewPoemInstruction,
	buildRevisePoemInstruction,
	poemCreatorActionIds,
} from "./turns/poem-creator.js";

/** @internal */
interface PromptProcessParams {
	/** @internal */
	prompt: string;
}

/** @internal */
interface PoemCreatorState extends StructuralProcessState {
	/** @internal */
	latestReviewMarkdown: string | null;
	/** @internal */
	latestReviewSummary: string | null;
	/** @internal */
	latestReviewOutcome: "no_issues" | "leave_feedback" | null;
}

const promptProcessParamsCodec: Codec<PromptProcessParams> = {
	parse(value) {
		const record =
			typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
		return { prompt: typeof record.prompt === "string" ? record.prompt : "" };
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
			record.latestReviewOutcome === "issues_found"
				? "leave_feedback"
				: record.latestReviewOutcome === "no_issues" ||
						record.latestReviewOutcome === "leave_feedback"
					? record.latestReviewOutcome
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

function poemLaunchConfig(prompt: string) {
	return {
		processId: "poem_creator_process",
		params: { prompt },
		titleSourceFields: [{ label: "Poem Prompt", value: prompt }],
		startTurnId: poemTurnIds.draftPoem,
	};
}

function resetPoemReview(state: PoemCreatorState): PoemCreatorState {
	return {
		...state,
		latestReviewMarkdown: null,
		latestReviewSummary: null,
		latestReviewOutcome: null,
		semanticEntryRefs: { ...state.semanticEntryRefs, review: null },
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

const poemDraftReviewSpec = flow
	.human<PromptProcessParams, PoemCreatorState>(poemTurnIds.poemReview)
	.description("Review")
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
			.effect(({ ctx }) => ({ state: resetPoemReview(ctx.state) })),
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
	.description("Review Feedback")
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
			.effect(({ ctx }) => ({ state: resetPoemReview(ctx.state) })),
	).definition;

/** @internal */
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
			.description("Draft Poem")
			.waitFor(({ params, state }) => !!params.prompt.trim() || !!state.productRefs.message)
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
			.state(({ ctx }) => resetPoemReview(ctx.state)),
	)
	.turn({ id: poemTurnIds.poemReview, definition: poemDraftReviewSpec })
	.turn(
		flow
			.llm<PromptProcessParams, PoemCreatorState>(poemTurnIds.reviewPoemDraft)
			.description("Assess Poem")
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
					.resultSummary("summary")
					.requiredString("summary", "Short confirmation summary")
					.markdown("review", {
						description: "Concise review opinion confirming the poem is ready",
						publish: true,
					})
					.to(poemTurnIds.poemReview)
					.state(({ ctx, event }) => ({
						...ctx.state,
						latestReviewMarkdown: null,
						latestReviewSummary:
							typeof event.params.summary === "string" ? event.params.summary : null,
						latestReviewOutcome: "no_issues",
					})),
			)
			.outcomeTool("leave_feedback", (tool) =>
				tool
					.description("Leave concise feedback for the human reviewer")
					.resultSummary("summary")
					.requiredString("summary", "Short summary of the feedback")
					.markdown("message", {
						description: "Concise plain-text feedback describing what to improve",
						publish: true,
					})
					.to(poemTurnIds.poemReviewFeedback)
					.state(({ ctx, event }) => ({
						...ctx.state,
						latestReviewMarkdown:
							typeof event.params.message === "string"
								? event.params.message
								: (ctx.output?.content ?? null),
						latestReviewSummary:
							typeof event.params.summary === "string" ? event.params.summary : null,
						latestReviewOutcome: "leave_feedback",
					})),
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
			resolveDefaults: () => ({ prompt: buildDefaultPoemPrompt() }),
			resolveLaunchConfig(input) {
				const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
				return {
					ok: true,
					launchConfig: poemLaunchConfig(prompt || buildDefaultPoemPrompt().trim()),
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
		resolveLaunchConfig: (event) => poemLaunchConfig(event.content.trim()),
	})
	.define();
