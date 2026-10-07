import { expect, it } from "vitest";
import { markdownToJira } from "./markdown.js";
import {
	assertJiraTicketText,
	jiraTicketTextProblem,
	ticketDescriptionMarkdown,
} from "./ticket-text.js";

it.each([
	`Leitwerk split identity: leitwerk-split-${"a".repeat(64)}`,
	"Inspect repo_123 before implementing this change.",
	`Evidence (${"a".repeat(40)}): the setting is hardcoded.`,
	"Consult agt_mucnt4c2sxqcndbu for the assessment.",
	"The setting is hardcoded citeturn0file1.",
	"The setting is hardcoded 【1†source】.",
	"The setting is hardcoded 【turn2file1】.",
	"Use the evidence in turn3search2.",
	"Source issue solution wiki: https://leitwerk.test/wiki/legacy-topic",
])("rejects internal references in summaries and descriptions: %s", (text) => {
	expect(() => assertJiraTicketText("Update credentials", text)).toThrow("Revise the ticket");
	expect(() => assertJiraTicketText(text, "Update the configuration.")).toThrow(
		"Revise the ticket",
	);
});

it("preserves ordinary Jira task content, code, and readable references", () => {
	const description =
		"For APP-42, update team/service in config/database.yaml.\n\n## Acceptance criteria\n\n- Set `database.username` to `service_user`.\n- Run the integration tests.\n\n```sql\nALTER ROLE service_user LOGIN;\n```";
	expect(jiraTicketTextProblem("Use dedicated database credentials", description)).toBeNull();
	const markdown = ticketDescriptionMarkdown(description, {
		repositoryName: "team/service",
		repositoryUrl: "https://forge.test/team/service",
		sourceKey: "APP-42",
		sourceUrl: "https://jira.test/browse/APP-42",
	});
	expect(markdown).toBe(
		`${description}\n\nRepository: [team/service](https://forge.test/team/service)\n\nSource issue: [APP-42](https://jira.test/browse/APP-42)`,
	);
	const jira = markdownToJira(markdown);
	expect(jira).toContain("h2. Acceptance criteria");
	expect(jira).toContain("* Set {{database.username}} to {{service_user}}.");
	expect(jira).toContain("{code:sql}\nALTER ROLE service_user LOGIN;\n{code}");
	expect(jira).toContain("Repository: [team/service|https://forge.test/team/service]");
	expect(jira).toContain("Source issue: [APP-42|https://jira.test/browse/APP-42]");
});
