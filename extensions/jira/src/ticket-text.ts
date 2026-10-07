import { SafeOutcomePlanningError } from "@leitwerk-dev/process-sdk";

/** @internal */
export const jiraTicketWritingInstructions =
	"Write summary and description as a normal standalone Jira task for its assignee, using Markdown for the description. Explain the work and acceptance criteria in plain language; retain concrete file paths, prerequisites, and validation steps when needed. Keep evidence, inspected revisions, repository keys, and other tracking data in the separate evidence fields. Do not put raw commit hashes, internal IDs, split identities, solution-wiki references, or model citation tokens in the summary or description. Refer to repositories by their readable names and Jira issues by their issue keys. The publisher adds repository and source-issue links. When revising an existing ticket, preserve useful task details and human notes, and omit any previous generated tracking footer.";

// These are references produced by the tools and publisher, not task requirements.
const internalReference =
	/\bleitwerk-split-[\w-]+\b|\brepo_\d+\b|\bagt_[a-z0-9]+\b|\b[a-f0-9]{40,64}\b|\bturn\d+(?:file|search|view|fetch)\d+\b|[\uE200-\uE202]|【[^】]*(?:†|turn\d+|repo_\d+)[^】]*】|Leitwerk split identity\s*:|(?:Source issue )?solution wiki\s*:/i;

/** @internal */
export function jiraTicketTextProblem(summary: string, description: string): string | null {
	return internalReference.test(`${summary}\n${description}`)
		? "Revise the ticket summary and description to remove internal references; keep evidence and tracking IDs in the separate evidence fields, then review the revised ticket."
		: null;
}

/** @internal */
export function assertJiraTicketText(summary: string, description: string): void {
	const problem = jiraTicketTextProblem(summary, description);
	if (problem) throw new SafeOutcomePlanningError("jira_ticket_internal_reference", problem);
}

/** @internal */
export function ticketDescriptionMarkdown(
	description: string,
	links: {
		/** @internal */
		repositoryName: string;
		/** @internal */
		repositoryUrl: string;
		/** @internal */
		sourceKey: string;
		/** @internal */
		sourceUrl: string;
	},
): string {
	const label = (value: string) => value.replace(/[\\[\]]/g, "\\$&");
	return `${description.trim()}\n\nRepository: [${label(links.repositoryName)}](${links.repositoryUrl})\n\nSource issue: [${label(links.sourceKey)}](${links.sourceUrl})`;
}
