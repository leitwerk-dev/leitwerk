import type { ToolCallRendererDefinition } from "@leitwerk-dev/process-sdk";

export const poemCreatorActionIds = {
	completePoem: "complete_poem",
	requestRevision: "request_poem_revision",
	runAutoReview: "run_poem_auto_review",
	acceptReview: "accept_poem_review",
	requestReviewChanges: "request_poem_review_changes",
	dismissReview: "dismiss_poem_review",
} as const;

function formatGermanyDay(now: Date): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/Berlin",
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(now);
}

export function buildDefaultPoemPrompt(now = new Date()): string {
	const germanyDay = formatGermanyDay(now);
	return `Write a short poem in Markdown that is either inspired by ${germanyDay} in Germany or by the craft of building cloud software. Keep it vivid, warm, and concise.`;
}

export function buildDraftPoemInstruction(promptText: string): string {
	return `Write a short poem in Markdown that clearly responds to the operator's prompt.

Prompt:
${promptText}

Requirements:
- include a title as a Markdown heading
- keep the poem concise
- make the imagery clearly connected to the prompt
- render each poetic line with an explicit HTML <br> so line breaks survive rendering
- do not rely on single Markdown newlines alone for poem line formatting
- only the primary branch should write or revise the poem directly`;
}

export function buildRevisePoemInstruction(revisionGuidance: string): string {
	return `Continue from the current poem on this branch and revise it according to this request:

${revisionGuidance}

Preserve the parts of the current poem that the request does not ask you to change. Return the complete revised poem in the same Markdown format.`;
}

export function buildReviewPoemInstruction(promptText: string, poemDraftMarkdown: string): string {
	return `Review the latest poem draft against the operator's prompt.

Prompt:
${promptText}

Poem draft to review:
${poemDraftMarkdown}

You are reviewing the poem only. Do not draft, rewrite, or directly edit the poem. Only produce review feedback.

Explicit <br> line breaks in the poem body are expected for rendering and count as correct formatting.

If the poem is strong, relevant, and well-formed Markdown, call no_issues with a brief confirmation summary.
If the poem misses the prompt, needs revision, or is awkwardly structured, call leave_feedback with a brief summary and concise plain-text feedback.`;
}

export const leaveFeedbackToolRenderer: ToolCallRendererDefinition = {
	toolName: "leave_feedback",
	title: "Feedback",
	fields: [
		{
			id: "message",
			label: "Feedback",
			kind: "plaintext",
			source: "arguments",
			path: "message",
		},
	],
};
