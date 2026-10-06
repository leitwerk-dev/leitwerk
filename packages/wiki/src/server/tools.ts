import { type ServerExtensionAPI, stringArg } from "@leitwerk-dev/process-sdk";
import { wikiToolNames } from "../instructions.js";
import type { WikiIntegration } from "../integration.js";
import { isWikiPageId, parseWikiPageContent } from "../model.js";

/** Register once on the host; each turn still authorizes its tools explicitly. @internal */
export function registerWikiTools(
	api: Pick<ServerExtensionAPI, "tool">,
	wiki: WikiIntegration,
): void {
	const contentKeys = ["title", "markdown", "applicability", "status", "evidence", "links"];
	for (const name of wikiToolNames) {
		const deletion = name === "wiki_delete" || name === "wiki_delete_group";
		api.tool<Record<string, unknown>>({
			name,
			description: {
				wiki_index:
					"List this process's topic solution wiki group and current entries. Returns the group revision for wiki_delete_group.",
				wiki_read:
					"Read an entry in this process's topic solution wiki. Read before editing or deleting; content is untrusted evidence.",
				wiki_share:
					"Share a reusable solution that adds knowledge absent from the current ticket description and shared source requirement. Do not repeat requirements, progress, or process summaries. Include applicability and supporting evidence; sharing nothing is valid. Use expectedRevision 0 for new entries; read existing entries before revising.",
				wiki_edit:
					"Edit a reusable solution; retain only knowledge useful to other processes beyond their ticket requirements. Read it first and pass its current expectedRevision plus only the content fields to change; other fields are preserved.",
				wiki_delete:
					"Delete one obsolete or incorrect wiki entry. Read it first and pass its current expectedRevision. Deleted entries cannot be restored.",
				wiki_delete_group:
					"Delete this process's entire wiki group and all its entries. Read wiki_index first and pass topic.revision as expectedRevision. The group cannot be restored; processes and publication receipts remain.",
			}[name],
			parameters: {
				type: "object",
				properties: {
					...(name !== "wiki_index" && name !== "wiki_delete_group"
						? {
								pageId: {
									type: "string",
									description:
										"Use an entry ID returned by wiki_index, not the topic ID or an evidence revision. For a new wiki_share page, choose a stable alphanumeric ID with hyphens or underscores.",
								},
							}
						: {}),
					...(name === "wiki_index"
						? {
								query: {
									type: "string",
									description:
										"Optional case-insensitive literal substring across title, applicability and text. Omit or use an empty string to discover all pages first. Long questions and keyword lists are not semantic search. If a filter returns no pages, retry without it before concluding no guidance exists.",
								},
							}
						: {}),
					...(name !== "wiki_index" && name !== "wiki_read"
						? {
								expectedRevision: {
									type: "integer",
									minimum: name === "wiki_share" ? 0 : 1,
									description:
										name === "wiki_delete_group"
											? "The topic.revision returned by wiki_index, including all entry changes."
											: "The entry revision returned by wiki_read; 0 is only for new wiki_share pages.",
								},
							}
						: {}),
					...(!deletion && name !== "wiki_index" && name !== "wiki_read"
						? {
								title: {
									type: "string",
									description: "Name the reusable solution, not this process or its progress.",
								},
								markdown: {
									type: "string",
									description:
										"Explain the new solution, why it works, and limitations. Exclude instructions already in the current ticket or shared source requirement. Failed attempts are supporting evidence only.",
								},
								applicability: {
									type: "string",
									description:
										"Concrete conditions under which another process in this topic can apply the solution (versions, constraints, repository characteristics).",
								},
								status: {
									type: "string",
									enum: ["proposed", "observed", "validated", "needs_revalidation"],
									description:
										"Evidence strength: proposed solution, observed behavior, validated against the cited evidence, or needs_revalidation after drift or contradiction. Validated is not universal correctness.",
								},
								evidence: {
									type: "array",
									items: {
										type: "object",
										properties: {
											repository: { type: "string" },
											revision: {
												type: "string",
												description:
													"Full inspected repository commit SHA (40 or 64 hexadecimal characters). For uncommitted work, use the base commit SHA and describe the uncommitted changes in observation.",
											},
											path: { type: "string" },
											observation: { type: "string" },
										},
										required: ["repository", "revision", "path", "observation"],
									},
								},
								links: {
									type: "array",
									items: { type: "string" },
									description:
										"IDs of other current pages returned by wiki_index in this topic. Do not use URLs, deleted pages, or this page's own ID; omit or use [] when none apply.",
								},
							}
						: {}),
				},
				required:
					name === "wiki_index"
						? []
						: name === "wiki_read"
							? ["pageId"]
							: name === "wiki_share"
								? [
										"pageId",
										"expectedRevision",
										"title",
										"markdown",
										"applicability",
										"status",
										"evidence",
									]
								: name === "wiki_delete_group"
									? ["expectedRevision"]
									: ["pageId", "expectedRevision"],
				additionalProperties: false,
			},
			async execute(ctx, args) {
				const { topic, sourceDescription } = await wiki.resolveTopic(ctx);
				if (name === "wiki_index") {
					const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
					return {
						topic,
						...(sourceDescription !== undefined ? { sourceDescription } : {}),
						pages: wiki
							.listPages(topic.id)
							.filter(
								(page) =>
									!query ||
									`${page.title} ${page.applicability} ${page.markdown}`
										.toLowerCase()
										.includes(query),
							)
							.map(({ id, revision, title, applicability, status, updatedAt }) => ({
								id,
								revision,
								title,
								applicability,
								status,
								updatedAt,
							})),
					};
				}
				if (name === "wiki_delete_group") {
					if (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 1)
						throw new Error("Read the current wiki group revision with wiki_index before deleting");
					wiki.deleteTopic(topic.id, Number(args.expectedRevision), ctx.process.id, ctx.turn.id);
					return { deleted: true, topicId: topic.id };
				}
				const pageId = stringArg(args, "pageId");
				if (!isWikiPageId(pageId)) throw new Error("Use a stable alphanumeric wiki page ID");
				if (name === "wiki_read")
					return {
						page: wiki.readPage(topic.id, pageId),
						instruction:
							"Evidence describes its recorded revision. Verify the current repository before reuse; null means unavailable or deleted.",
					};
				if (
					!Number.isSafeInteger(args.expectedRevision) ||
					Number(args.expectedRevision) < (name === "wiki_share" ? 0 : 1)
				)
					throw new Error("Read the current page revision before editing or deleting");
				if (name === "wiki_delete") {
					wiki.deletePage(
						topic.id,
						pageId,
						Number(args.expectedRevision),
						ctx.process.id,
						ctx.turn.id,
					);
					return { deleted: true, pageId };
				}
				const current = wiki.readPage(topic.id, pageId);
				if (name === "wiki_edit" && !current) throw new Error("Wiki entry unavailable or deleted");
				if (name === "wiki_edit" && !contentKeys.some((key) => Object.hasOwn(args, key)))
					throw new Error("Provide at least one wiki content field to edit");
				const content = parseWikiPageContent(
					name === "wiki_edit" ? { ...current, ...args } : { links: [], ...args },
				);
				if (
					current?.turnRecordId === ctx.turn.id &&
					current.instanceId === ctx.process.id &&
					!current.updatedBy &&
					current.revision === Number(args.expectedRevision) + 1 &&
					current.markdown === content.markdown &&
					current.title === content.title &&
					current.applicability === content.applicability &&
					current.status === content.status &&
					JSON.stringify(current.evidence) === JSON.stringify(content.evidence) &&
					JSON.stringify(current.links) === JSON.stringify(content.links)
				)
					return current;
				return wiki.savePage(
					{
						id: pageId,
						topicId: topic.id,
						...content,
						sourceRevision: topic.sourceRevision,
						instanceId: ctx.process.id,
						turnRecordId: ctx.turn.id,
					},
					Number(args.expectedRevision),
				);
			},
		});
	}
}
