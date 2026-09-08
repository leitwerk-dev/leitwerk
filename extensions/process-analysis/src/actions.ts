export const processAnalysisActionIds = {
	completeAnalysis: "complete_analysis",
	askFollowup: "ask_followup",
	refineAnalysis: "refine_analysis",
	refreshSnapshot: "refresh_snapshot",
} as const;

export const followupForm = {
	id: "process_analysis_followup",
	title: "Follow up",
	fields: [
		{
			id: "message",
			label: "Question or refinement",
			kind: "textarea" as const,
			primaryPrompt: true as const,
			required: true,
		},
	],
	submitLabel: "Send",
};
