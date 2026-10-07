/** @internal */
export const processAnalysisActionIds = {
	/** @internal */
	completeAnalysis: "complete_analysis",
	/** @internal */
	askFollowup: "ask_followup",
	/** @internal */
	refineAnalysis: "refine_analysis",
	/** @internal */
	refreshSnapshot: "refresh_snapshot",
} as const;

/** @internal */
export const followupForm = {
	/** @internal */
	id: "process_analysis_followup",
	/** @internal */
	title: "Follow up",
	/** @internal */
	fields: [
		{
			/** @internal */
			id: "message",
			/** @internal */
			label: "Question or refinement",
			/** @internal */
			kind: "textarea" as const,
			/** @internal */
			primaryPrompt: true as const,
			/** @internal */
			required: true,
		},
	],
	/** @internal */
	submitLabel: "Send",
};
