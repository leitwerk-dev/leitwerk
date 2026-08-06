export const processAnalysisActionIds = {
	completeAnalysis: "complete_analysis",
	askFollowup: "ask_followup",
	refineAnalysis: "refine_analysis",
	refreshSnapshot: "refresh_snapshot",
	startLocalRepoChange: "start_local_repo_change",
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

export const handoffForm = {
	id: "process_analysis_handoff",
	title: "Start Local Repo Change",
	fields: [
		{
			id: "note",
			label: "Handoff note",
			kind: "textarea" as const,
			primaryPrompt: true as const,
			description: "Optional implementation direction to prepend to the analysis.",
		},
	],
	submitLabel: "Start change",
};
