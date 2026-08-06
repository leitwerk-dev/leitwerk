import type { FormDefinition } from "@leitwerk-dev/process-sdk";

export const codingActionIds = {
	approvePlan: "approve_plan",
	requestRevision: "request_revision",
	runReview: "run_review",
	simplify: "simplify",
	acceptReview: "accept_review",
	requestReviewChanges: "request_review_changes",
	dismissReview: "dismiss_review",
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

export const requestRevisionForm = notesForm(
	codingActionIds.requestRevision,
	"Request revision",
	"Revision notes",
	"Instructions for the next implementation pass.",
);
export const requestReviewChangesForm = notesForm(
	codingActionIds.requestReviewChanges,
	"Request review changes",
	"Review notes",
	"Instructions for the next review pass.",
);
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

export function createFinalizeChangeForm(copy: { title: string }): FormDefinition {
	return {
		id: codingActionIds.finalizeChange,
		title: copy.title,
		fields: [],
		submitLabel: copy.title,
	};
}
