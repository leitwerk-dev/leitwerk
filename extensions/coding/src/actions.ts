import type { FormDefinition } from "@leitwerk-dev/process-sdk";

/** @public */
export const codingActionIds = {
	/** @public */
	approvePlan: "approve_plan",
	/** @internal */
	requestRevision: "request_revision",
	/** @internal */
	runReview: "run_review",
	/** @internal */
	simplify: "simplify",
	/** @internal */
	acceptReview: "accept_review",
	/** @internal */
	requestReviewChanges: "request_review_changes",
	/** @internal */
	dismissReview: "dismiss_review",
	/** @public */
	finalizeChange: "finalize_change",
} as const;

function notesForm(id: string, title: string, label: string, description: string): FormDefinition {
	return {
		id,
		title,
		fields: [
			{ id: "message", label, kind: "textarea", primaryPrompt: true, required: true, description },
		],
		submitLabel: title,
	};
}

/** @internal */
export const requestRevisionForm = notesForm(
	codingActionIds.requestRevision,
	"Request revision",
	"Revision notes",
	"Instructions for the next implementation pass.",
);
/** @internal */
export const requestReviewChangesForm = notesForm(
	codingActionIds.requestReviewChanges,
	"Request review changes",
	"Review notes",
	"Instructions for the next review pass.",
);
/** @internal */
export const acceptReviewForm: FormDefinition = {
	id: codingActionIds.acceptReview,
	title: "Accept review",
	fields: [
		{
			id: "message",
			label: "Review adjustment",
			kind: "textarea",
			primaryPrompt: true,
			description:
				"Optional instructions to apply with the accepted review, such as dropping one finding.",
		},
	],
	submitLabel: "Accept review",
};
