import { createHash } from "node:crypto";
import { asUnknownRecord } from "@leitwerk-dev/domain";
import { projectParameters, type ServerExtensionAPI, stringArg } from "@leitwerk-dev/process-sdk";
import { jiraTriggerLabel } from "./client.js";
import type { JiraIntegration } from "./index.js";

/** @internal */
export function registerJiraTools(api: ServerExtensionAPI, integration: JiraIntegration) {
	for (const name of [
		"jira_get_source_issue",
		"jira_comment",
		"jira_finalize_source_issue",
	] as const)
		api.tool<Record<string, unknown>>({
			name,
			description: "Read or reconcile the launch-pinned Jira source issue",
			parameters: projectParameters({
				body: { type: "string" },
				writeKey: { type: "string" },
				done: { type: "boolean" },
			}),
			async execute(ctx, args) {
				const binding = asUnknownRecord(ctx.project?.metadata?.jira);
				if (
					typeof binding?.profile !== "string" ||
					typeof binding.issueId !== "string" ||
					typeof binding.baseUrl !== "string"
				)
					throw new Error("Missing Jira source binding");
				const client = integration.client(binding.profile);
				if (client.baseUrl !== binding.baseUrl)
					throw new Error("Jira profile installation changed");
				const id = binding.issueId;
				if (name === "jira_get_source_issue") return client.getIssue(id);
				const digest = createHash("sha256")
					.update(JSON.stringify([client.baseUrl, id, ctx.process.id, stringArg(args, "writeKey")]))
					.digest("hex");
				if (name === "jira_comment") {
					const marker = `{noformat}leitwerk:${digest}{noformat}`;
					return ctx.externalWrites.ensure(
						{ writeType: name, dedupKey: digest },
						{
							reconcile: async () =>
								(await client.listComments(id)).find((comment) => comment.body.includes(marker)) ??
								null,
							execute: () => client.addComment(id, `${stringArg(args, "body")}\n\n${marker}`),
							toMetadata: (comment) => ({ commentId: comment.id }),
						},
					);
				}
				const done = args.done === true;
				const triggerLabel = jiraTriggerLabel(binding.triggerLabel);
				return ctx.externalWrites.ensure(
					{ writeType: name, dedupKey: digest },
					{
						reconcile: async () => {
							const issue = await client.getIssue(id);
							return !issue.fields.labels.includes(triggerLabel) &&
								(!done || issue.fields.labels.includes("leitwerk-done"))
								? { issueId: id, done }
								: null;
						},
						execute: async () => {
							await client.updateLabels(id, [triggerLabel], done ? ["leitwerk-done"] : []);
							return { issueId: id, done };
						},
						toMetadata: (result) => result,
					},
				);
			},
		});
}
