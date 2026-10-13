import { shortestSuccessfulPath } from "@leitwerk-dev/workflow-graph";

const step = (turnId, description, kind, summary, tools = []) => ({
	turnId,
	description,
	turnType: kind === "map" ? "llm" : kind,
	role: "branch",
	spineIndex: null,
	anchorTurnId: null,
	isEntry: false,
	...(kind === "map" ? { repetition: "sequential" } : {}),
	...(["llm", "map"].includes(kind) ? { tools } : {}),
	summary,
});
const tool = (name, category, description) => ({ name, category, description });

const route = (from, to, label, description, { branchLabel = label, kind = "branch" } = {}) => {
	const lifecycleStatus = { complete: "completed", abort: "aborted" }[to] ?? null;
	return {
		from,
		to: lifecycleStatus ? null : to,
		lifecycleStatus,
		kind: lifecycleStatus ? "terminal" : kind,
		label,
		condition: { label: branchLabel, description },
	};
};

export const flows = [
	{
		id: "release",
		entry: "gather",
		name: "Release readiness",
		description: "Assess every component, collect the findings, and choose how to proceed.",

		startLabel: "Release name",
		startValue: "October product release",
		startBrief:
			"Review the release for customer impact, operational readiness, and anything that needs a second look.",
		nodes: [
			step(
				"gather",
				"Gather release context",
				"automatic",
				"Validate the release brief and assemble the shared release context. The component list is frozen on entering assessment.",
			),
			step(
				"map",
				"Assess component",
				"map",
				"Runs once for each component, one at a time. Continues after all results are collected.",
				[
					tool("read", "workspace", "Read workspace files relevant to the active component."),
					tool(
						"read_component_status",
						"integration",
						"Read the current readiness status of the active component.",
					),
					tool(
						"submit_finding",
						"outcome",
						"Yield one finding for this component. Collection chooses the route after all items.",
					),
				],
			),
			step(
				"review",
				"Review the recommendation",
				"human",
				"An operator reviews the findings. Approval proceeds to publication; requested changes start a fresh assessment run.",
			),
			step(
				"publish",
				"Publish release notes",
				"automatic",
				"Format the approved recommendation into release notes using a fixed template, then finish the process.",
			),
		],
		edges: [
			route("gather", "map", "Context ready", "The release context has been prepared."),
			route(
				"map",
				"review",
				"Review needed",
				"At least one collected finding requires operator review.",
			),
			route(
				"map",
				"publish",
				"All clear",
				"All collected findings are clear. For this synthetic flow, zero findings also satisfies this condition.",
			),
			route("review", "publish", "Approved", "The operator approves the recommendation."),
			route(
				"review",
				"map",
				"Request changes",
				"The operator requests a new assessment using the revised context.",
				{ kind: "loopback" },
			),
			route("review", "abort", "Cancel", "The operator cancels the release."),
			route("publish", "complete", "Notes ready", "The release notes have been produced."),
		],
	},
	{
		id: "editorial",
		entry: "draft",
		name: "Editorial review",
		description: "Draft a story, review it together, and revise until it is ready to publish.",

		startLabel: "Story title",
		startValue: "A quieter way to ship software",
		startBrief:
			"Write a practical story about a team improving its release process. Keep the audience in mind and make the advice concrete.",
		nodes: [
			step(
				"draft",
				"Draft the story",
				"llm",
				"Write a complete first draft from the brief. Re-entering this turn creates a revision using the operator feedback.",
				[
					tool("read", "workspace", "Read the editorial brief and reference files."),
					tool("write", "workspace", "Write the story draft to the workspace."),
					tool("ask_questions", "question", "Ask the operator to clarify the brief."),
					tool(
						"submit_draft",
						"outcome",
						"Finish the draft turn and send the story to operator review.",
					),
				],
			),
			step(
				"review",
				"Review the draft",
				"human",
				"Read the draft and choose approval, revision, or cancellation.",
			),
			step(
				"publish",
				"Publish the story",
				"automatic",
				"Apply the publication template to the approved draft and produce the published story.",
			),
		],
		edges: [
			route("draft", "review", "Draft ready", "A complete story draft is available."),
			route("review", "publish", "Approved", "The operator approves the draft."),
			route(
				"review",
				"draft",
				"Needs revisions",
				"The operator requests revisions and supplies feedback.",
				{ kind: "loopback" },
			),
			route("review", "abort", "Cancel", "The operator cancels publication."),
			route("publish", "complete", "Story published", "The approved story has been published."),
		],
	},
	{
		id: "intake",
		entry: "assess",
		name: "Intake routing",
		description:
			"Take the quick route for simple requests, or research each topic before responding.",

		startLabel: "Request subject",
		startValue: "Help us choose an integration approach",
		startBrief:
			"We need to connect our customer portal to an existing service. Assess the options, technical constraints, and next steps.",
		nodes: [
			step(
				"assess",
				"Assess the incoming request and decide how much research it needs",
				"llm",
				"Classify the request as simple or research needed. Research topics are frozen in their declared order on entering the mapped turn.",
				[
					tool(
						"answer_directly",
						"outcome",
						"Choose the quick-response route for a simple request.",
					),
					tool(
						"research_required",
						"outcome",
						"Choose topic research and supply the ordered topic list.",
					),
				],
			),
			step(
				"quick",
				"Prepare a quick response",
				"llm",
				"Answer a simple request using the available context.",
				[
					tool(
						"submit_response",
						"outcome",
						"Finish the quick-response turn and complete the process.",
					),
				],
			),
			step(
				"map",
				"Research topic",
				"map",
				"Runs once for each topic, one at a time. Continues after all results are collected.",
				[
					tool(
						"search_knowledge",
						"integration",
						"Search connected knowledge sources for the active topic.",
					),
					tool("read_reference", "integration", "Read a reference relevant to the active topic."),
					tool(
						"submit_finding",
						"outcome",
						"Yield one finding for this topic. Collection chooses the route after all items.",
					),
				],
			),
			step(
				"respond",
				"Respond with a considered recommendation and clear next steps",
				"llm",
				"Write a response from the collected research, with actionable next steps.",
				[
					tool(
						"ask_questions",
						"question",
						"Ask the operator to clarify the response requirements.",
					),
					tool(
						"submit_response",
						"outcome",
						"Finish the considered response and complete the process.",
					),
				],
			),
		],
		edges: [
			route(
				"assess",
				"quick",
				"Simple request",
				"The request can be answered from the existing context.",
			),
			route("assess", "map", "Research needed", "The request requires topic-by-topic research."),
			route(
				"map",
				"respond",
				"Summary ready",
				"The ordered research findings have been collected.",
			),
			route("respond", "complete", "Response ready", "The considered response has been prepared."),
			route("quick", "complete", "Response ready", "The quick response has been prepared."),
		],
	},
	{
		id: "repository",
		entry: "plan",
		name: "Repository change",
		description: "Review or bypass plan approval, optionally simplify, then rejoin publication.",
		startLabel: "Change title",
		startValue: "Improve the garden notebook",
		startBrief: "Document a weekly garden review with a short checklist and clear next steps.",
		nodes: [
			step("plan", "Plan", "llm", "Prepare a plan before implementation.", [
				tool("read", "workspace", "Read the notebook and its instructions."),
				tool(
					"plan_saved",
					"outcome",
					"Save the plan. Process policy decides whether approval is required.",
				),
			]),
			step("review", "Review Plan", "human", "Approve the plan or request a revision."),
			step("implement", "Implement", "llm", "Implement the accepted plan and run checks.", [
				tool("read", "workspace", "Read notebook files."),
				tool("edit", "workspace", "Apply the planned changes."),
				tool(
					"implementation_ready",
					"outcome",
					"Finish implementation. Process policy decides whether to simplify.",
				),
			]),
			step("simplify", "Simplify", "llm", "Identify simpler ways to express the implementation.", [
				tool("read", "workspace", "Inspect the implementation without editing it."),
			]),
			step(
				"apply",
				"Apply simplification",
				"llm",
				"Apply the simplification plan before publication.",
				[
					tool("read", "workspace", "Read the implementation and simplification plan."),
					tool("edit", "workspace", "Apply the suggested simplifications."),
				],
			),
			step(
				"commit",
				"Write Commit Message",
				"llm",
				"Write a concise commit message for the finished change.",
			),
			step("publish", "Publish feature branch", "automatic", "Publish the prepared change."),
		],
		edges: [
			route("plan", "review", "Plan Saved", "When an operator must approve the saved plan.", {
				branchLabel: "Approval required",
			}),
			route(
				"plan",
				"implement",
				"Plan Saved",
				"When the Skip plan approval launcher option bypasses the approval step.",
				{ branchLabel: "Skip plan approval" },
			),
			route("review", "implement", "Approve Plan", "The operator approves the plan."),
			route("review", "plan", "Request Revision", "The operator requests a revised plan.", {
				kind: "loopback",
			}),
			route(
				"implement",
				"simplify",
				"Implementation Ready",
				"When simplification is enabled by the process policy.",
				{ branchLabel: "Simplification enabled" },
			),
			route(
				"implement",
				"commit",
				"Implementation Ready",
				"When the Skip simplification launcher option or the leitwerk-skip-simplification source label skips the simplification pass.",
				{ branchLabel: "Skip simplification" },
			),
			route(
				"simplify",
				"apply",
				"Simplification Plan",
				"The simplification plan is ready to apply.",
			),
			route(
				"apply",
				"commit",
				"Implementation Summary",
				"The simplified implementation is ready for its commit message.",
			),
			route("commit", "publish", "Commit Message", "The commit message is ready."),
			route("publish", "complete", "Published", "The feature branch has been published."),
		],
	},
];

/** Synthetic fixtures use the same serialized definition contract as the application. */
export function flowView(sample) {
	const nodes = sample.nodes.map(({ summary: _summary, ...node }) => ({
		...node,
		isEntry: node.turnId === sample.entry,
	}));
	const edges = sample.edges;
	const view = {
		processId: sample.id,
		entryTurnIds: [sample.entry],
		spine: [],
		nodes,
		edges,
		endStates: ["completed", "aborted"]
			.filter((status) => edges.some((edge) => edge.lifecycleStatus === status))
			.map((lifecycleStatus) => ({ lifecycleStatus, synthetic: false })),
	};
	view.spine = shortestSuccessfulPath(view);
	for (const node of nodes) {
		const index = view.spine.indexOf(node.turnId);
		node.role = index < 0 ? "branch" : "spine";
		node.spineIndex = index < 0 ? null : index;
	}
	return view;
}
