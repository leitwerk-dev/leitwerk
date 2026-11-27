import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import type { GitLabClientLike } from "./client.js";

const directory = ".gitlab/merge_request_templates";

/** @internal */
export async function mergeRequestBody(
	client: Pick<
		GitLabClientLike,
		"getProject" | "getBranch" | "listRepositoryTree" | "getRepositoryFile"
	>,
	projectId: number,
	body: string,
	ctx: Pick<IntegrationToolExecutionContext, "signal" | "reportProgress">,
): Promise<string> {
	const { listRepositoryTree, getRepositoryFile } = client;
	if (!listRepositoryTree || !getRepositoryFile)
		throw new Error("GitLab repository template lookup is unavailable");

	const { default_branch: branch } = await client.getProject(projectId, ctx.signal);
	if (!branch) throw new Error("GitLab repository has no default branch for template lookup");
	const { commit } = await client.getBranch(projectId, branch, ctx.signal);
	const list = (path: string) =>
		listRepositoryTree.call(client, projectId, commit.id, path, ctx.signal);
	// Check parent trees explicitly: a 404 alone also means an inaccessible ref or repository.
	const hasTree = (entries: Awaited<ReturnType<typeof list>>, path: string) =>
		entries.some((entry) => entry.type === "tree" && entry.path === path);
	if (!hasTree(await list(""), ".gitlab") || !hasTree(await list(".gitlab"), directory))
		return body;

	const candidates = (await list(directory)).filter(
		({ path, type, mode }) =>
			type === "blob" &&
			mode !== "120000" &&
			path.startsWith(`${directory}/`) &&
			/^[^/\r\n\0]+\.md$/i.test(path.slice(directory.length + 1)),
	);
	const template =
		candidates.find(({ path }) => path === `${directory}/Default.md`) ??
		(candidates.length === 1 ? candidates[0] : undefined);
	if (!template) {
		if (candidates.length > 1)
			ctx.reportProgress({
				title: "Creating GitLab merge request without a template",
				summary: "Multiple repository templates exist and none is Default.md.",
				steps: [],
			});
		return body;
	}
	const file = await getRepositoryFile.call(
		client,
		projectId,
		commit.id,
		template.path,
		ctx.signal,
	);
	if (file.file_path !== template.path || file.encoding !== "base64")
		throw new Error("Invalid GitLab merge request template response");
	const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.from(file.content, "base64"),
	);
	// Templates are Markdown, not authority to execute GitLab quick actions as the bot.
	const description = markdown.replace(/^(\s*)\/(?=[a-z])/gim, "$1\\/").trimEnd();
	return description ? `${description}\n\n${body}` : body;
}
