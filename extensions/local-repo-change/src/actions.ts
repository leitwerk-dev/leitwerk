import {
	acceptReviewForm,
	codingActionIds,
	createFinalizeChangeForm,
	requestReviewChangesForm,
	requestRevisionForm,
} from "@leitwerk-dev/coding";
export const localRepoChangeActionIds = codingActionIds;
export { acceptReviewForm, requestReviewChangesForm, requestRevisionForm };
export const finalizeChangeForm = createFinalizeChangeForm({ title: "Merge change" });
