import { createHash } from "node:crypto";
import type { GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	type GitLabIntegration,
	parseGitLabSelection,
	selectGitLabProjects,
} from "@leitwerk-dev/gitlab";
import {
	ensureEpicWiki,
	type JiraIntegration,
	type JiraIssueReceipt,
	JiraRequestError,
	jiraEpicRevision,
	jiraIssueExternalId,
	jiraSubjectIdentity,
} from "@leitwerk-dev/jira";
import { createJiraGitLabLauncher, type RepositoryMapping } from "@leitwerk-dev/jira-gitlab-change";
import {
	type ProcessLaunchConfig,
	type ScopedSettingsResolver,
	type ServerExtensionAPI,
	stringArg,
	type TopicWikiStore,
} from "@leitwerk-dev/process-sdk";
import {
	type SplitDraft,
	type SplitParams,
	type SplitRepository,
	splitParamsCodec,
	splitStateCodec,
} from "./model.js";

/** @internal */
export interface SplitServices {
	/** @internal */ jira: JiraIntegration;
	/** @internal */ gitlab: GitLabIntegration;
	/** @internal */ ssh: GitSshIntegration;
	/** @internal */ settings: ScopedSettingsResolver;
	/** @internal */ wiki: TopicWikiStore;
	/** @internal */ serverBaseUrl: string;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** @internal */
export function splitPublicationKey(params: SplitParams, repository: SplitRepository): string {
	return digest([params.jiraBaseUrl, params.epic.id, repository.origin, repository.projectId]);
}

/** @internal */
export function parseLabels(value: unknown): string[] {
	if (value === undefined) return [];
	if (typeof value !== "string") throw new Error("Ticket labels must be comma-separated text");
	const labels = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
	if (
		labels.some(
			(label) =>
				label === "leitwerk-epic-split" ||
				label === "leitwerk-done" ||
				label.startsWith("leitwerk-split-"),
		)
	)
		throw new Error(
			"Epic-split, done, and reconciliation labels cannot be selected for child tickets",
		);
	return labels;
}

/** @internal */
export function parseSplitOptions(input: Record<string, unknown>) {
	const paths = (value: unknown) => {
		if (value === undefined) return [];
		if (typeof value !== "string")
			throw new Error("GitLab selectors must be comma- or whitespace-separated paths");
		return value.split(/[\s,]+/).filter(Boolean);
	};
	const issueType = input.issueType ?? "Story";
	if (issueType !== "Story" && issueType !== "Task")
		throw new Error("Select Story or Task for repository tickets");
	return {
		/** @internal */
		selection: parseGitLabSelection({
			projects: { include: paths(input.projects), exclude: paths(input.excludeProjects) },
			groups: { include: paths(input.groups), exclude: paths(input.excludeGroups) },
		}),
		/** @internal */
		issueType: issueType as SplitParams["issueType"],
		/** @internal */
		labels: parseLabels(input.labels),
	};
}

/** @internal */
export async function launchSplit(
	services: SplitServices,
	input: Record<string, unknown>,
): Promise<ProcessLaunchConfig<SplitParams>> {
	const jiraProfile = stringArg(input, "jiraProfile");
	const gitlabProfile = stringArg(input, "gitlabProfile");
	const sshProfile = stringArg(input, "sshProfile");
	const options = parseSplitOptions(input);
	if (!services.ssh.profiles().includes(sshProfile))
		throw new Error("Select an available Git SSH profile");
	const jira = services.jira.client(jiraProfile);
	const epic = await jira.getIssue(stringArg(input, "epic"));
	if (
		epic.fields.issuetype?.name.toLowerCase() !== "epic" ||
		epic.fields.status.statusCategory.key === "done"
	)
		throw new Error("Select an open Jira Epic");
	if (!jira.createMetadata) throw new Error("Jira ticket creation metadata unavailable");
	await jira.createMetadata(epic.fields.project.id);
	const gitlab = services.gitlab.client(gitlabProfile);
	const selected = await selectGitLabProjects(gitlab, options.selection);
	if (!selected.length) throw new Error("No active repositories match the selected scope");
	if (selected.length > 500)
		throw new Error(
			"This scope exceeds the mapped-turn limit of 500 repositories; narrow the selected groups/projects",
		);
	const repositories: SplitRepository[] = selected.map((repository) => ({
		key: `repo_${repository.id}`,
		name: repository.path_with_namespace,
		projectId: repository.id,
		origin: gitlab.baseUrl,
		repoLocator: repository.ssh_url_to_repo ?? "",
		baseBranch: repository.default_branch ?? "",
	}));
	const topic = ensureEpicWiki(services.wiki, jira, epic);
	const project = services.settings.discover({
		scopeType: "jira.project",
		identity: jiraSubjectIdentity(jira.baseUrl, epic.fields.project.id),
		label: epic.fields.project.key,
	});
	const params: SplitParams = {
		jiraProfile,
		jiraBaseUrl: jira.baseUrl,
		gitlabProfile,
		sshProfile,
		epic,
		topicId: topic.id,
		repositories,
		issueType: options.issueType,
		labels: options.labels,
	};
	return {
		processId: "jira_epic_split_process",
		startTurnId: "read_epic",
		params,
		title: `Split ${epic.key}: ${epic.fields.summary}`,
		externalUrl: topic.url,
		settingsContext: { "jira.project": project.id },
		metadata: {
			wiki: { topicId: topic.id, profile: jiraProfile, baseUrl: jira.baseUrl, epicId: epic.id },
		},
		projects: repositories
			.filter((repository) => repository.repoLocator && repository.baseBranch)
			.map((repository) => ({
				key: repository.key,
				repoLocator: repository.repoLocator,
				baseBranch: repository.baseBranch,
				workBranch: repository.baseBranch,
				settingsRepository: { origin: repository.origin, repositoryId: repository.projectId },
				metadata: {
					gitlab: {
						profile: gitlabProfile,
						projectId: repository.projectId,
						origin: repository.origin,
					},
					jira: { profile: jiraProfile, baseUrl: jira.baseUrl, issueId: epic.id },
				},
			})),
	};
}

/** @internal */
export async function componentMapping(
	services: SplitServices,
	params: SplitParams,
	repository: SplitRepository,
): Promise<{ componentIds: string[]; mappingRevision: string }> {
	const client = services.jira.client(params.jiraProfile);
	if (client.baseUrl !== params.jiraBaseUrl) throw new Error("Jira profile installation changed");
	const project = services.settings.discover({
		scopeType: "jira.project",
		identity: jiraSubjectIdentity(client.baseUrl, params.epic.fields.project.id),
		label: params.epic.fields.project.key,
	});
	const mapping = createJiraGitLabLauncher().mapping;
	const matches = [];
	for (const component of await client.listComponents(params.epic.fields.project.id)) {
		const subject = services.settings.discover({
			scopeType: "jira.component",
			identity: jiraSubjectIdentity(client.baseUrl, component.id),
			label: component.name,
			context: { "jira.project": project.id },
		});
		const resolved = services.settings.resolve(mapping, {
			"jira.project": project.id,
			"jira.component": subject.id,
		});
		const entries = resolved.value.map((value) => JSON.parse(value) as RepositoryMapping);
		if (
			entries.some(
				(entry) =>
					entry.origin === repository.origin &&
					entry.projectId === repository.projectId &&
					entry.gitlabProfile === params.gitlabProfile &&
					entry.sshProfile === params.sshProfile,
			)
		)
			matches.push({ id: component.id, values: resolved.value, sources: resolved.sources });
	}
	return {
		componentIds: matches.map((match) => match.id).sort(),
		mappingRevision: digest(matches),
	};
}

async function repositoryBlock(
	services: SplitServices,
	params: SplitParams,
	repository: SplitRepository,
	draft: SplitDraft,
): Promise<string | null> {
	const provider = services.gitlab.client(params.gitlabProfile);
	if (provider.baseUrl !== repository.origin)
		return "GitLab profile installation changed; launch a new split";
	try {
		const fresh = await provider.getProject(repository.projectId);
		if (fresh.archived || !fresh.default_branch || !fresh.ssh_url_to_repo)
			return "Repository is archived, empty, or lacks an SSH clone URL";
		if (
			fresh.ssh_url_to_repo !== repository.repoLocator ||
			fresh.default_branch !== repository.baseBranch
		)
			return "Repository checkout binding changed; launch a new split";
		if (
			draft.verdict === "applicable" &&
			(await provider.getBranch(repository.projectId, repository.baseBranch)).commit.id !==
				draft.revision
		)
			return "Repository changed since assessment; request revision before approval";
		return null;
	} catch {
		return "Repository cannot be inspected; restore access and refresh the batch";
	}
}

/** @internal */
export function registerSplitTools(api: ServerExtensionAPI, services: SplitServices): void {
	for (const name of ["jira_split_prepare", "jira_split_publish"] as const)
		api.tool<Record<string, unknown>>({
			name,
			description: "Prepare the review batch or publish one operator-approved repository ticket",
			parameters: {
				type: "object",
				properties: { repositoryKey: { type: "string" } },
				additionalProperties: false,
			},
			async execute(ctx, args) {
				if (ctx.process.processId !== "jira_epic_split_process")
					throw new Error("Epic split process required");
				const params = splitParamsCodec.parse(JSON.parse(ctx.process.paramsJson ?? "null"));
				const state = splitStateCodec.parse(JSON.parse(ctx.process.stateJson ?? "null"));
				const client = services.jira.client(params.jiraProfile);
				if (client.baseUrl !== params.jiraBaseUrl)
					throw new Error("Jira profile installation changed");
				const epic = await client.getIssue(params.epic.id);
				const revision = jiraEpicRevision(epic);
				const projectChanged = epic.fields.project.id !== params.epic.fields.project.id;
				ensureEpicWiki(services.wiki, client, epic);
				if (name === "jira_split_prepare") {
					const drafts: SplitDraft[] = [];
					for (const draft of state.drafts) {
						if (draft.receipt) {
							drafts.push(draft);
							continue;
						}
						const repository = params.repositories.find(
							(candidate) => candidate.key === draft.repositoryKey,
						);
						if (!repository) throw new Error("Draft refers to an unauthorized repository");
						const mapping = await componentMapping(services, params, repository);
						const blocked = projectChanged
							? "Epic moved to a different Jira project; launch a new split"
							: epic.fields.status.statusCategory.key === "done"
								? "Epic is closed"
								: state.epicRevision && revision !== state.epicRevision
									? "Epic changed: request revision before approval"
									: draft.verdict === "applicable" && !mapping.componentIds.length
										? "Map this repository in Settings → Jira components, then refresh mappings"
										: draft.verdict === "unresolved"
											? "Assessment unresolved: revise or explicitly exclude"
											: draft.verdict === "applicable"
												? await repositoryBlock(services, params, repository, draft)
												: null;
						drafts.push({ ...draft, ...mapping, blocked });
					}
					return {
						drafts,
						epic,
						epicRevision: revision,
						changed: Boolean(state.epicRevision && revision !== state.epicRevision),
					};
				}
				const repositoryKey = stringArg(args, "repositoryKey");
				if (ctx.turn.turnId !== "publish_tickets" || !state.approved.includes(repositoryKey))
					throw new Error("Ticket has no current operator approval");
				const draft = state.drafts.find((candidate) => candidate.repositoryKey === repositoryKey);
				const repository = params.repositories.find((candidate) => candidate.key === repositoryKey);
				if (
					!draft ||
					!repository ||
					draft.excluded ||
					draft.blocked ||
					draft.verdict !== "applicable"
				)
					throw new Error("Ticket is not publishable");
				if (!client.findSplitIssue) throw new Error("Jira issue reconciliation unavailable");
				const findSplitIssue = client.findSplitIssue.bind(client);
				const key = splitPublicationKey(params, repository);
				const marker = `leitwerk-split-${key}`;
				const binding = {
					...repository,
					gitlabProfile: params.gitlabProfile,
					sshProfile: params.sshProfile,
					epicId: epic.id,
				};
				const existing = services.wiki.publication(key);
				if (
					existing &&
					(existing.topicId !== params.topicId ||
						["origin", "projectId", "gitlabProfile", "sshProfile", "repoLocator", "epicId"].some(
							(field) => existing.binding[field] !== (binding as Record<string, unknown>)[field],
						))
				)
					throw new Error(
						"Existing ticket publication has a different repository binding; reconcile before continuing",
					);
				const readRemote = async () => {
					const recorded = services.wiki.publication(key);
					const issue = recorded?.externalId
						? await client.getIssue(
								String((JSON.parse(recorded.externalId.slice(5)) as string[])[1]),
							)
						: await findSplitIssue(epic.fields.project.id, marker);
					if (!issue) return null;
					if (
						issue.fields.project.id !== epic.fields.project.id ||
						!issue.fields.labels.includes(marker)
					)
						throw new Error("Uncorrelated Jira split receipt");
					if (client.getEpic && (await client.getEpic(issue))?.id !== epic.id)
						throw new Error("Created issue no longer belongs to this epic");
					const url = `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`;
					if (!recorded)
						services.wiki.reservePublication({
							key,
							topicId: params.topicId,
							binding,
							externalId: null,
							url: null,
						});
					services.wiki.finishPublication(key, jiraIssueExternalId(client.baseUrl, issue.id), url);
					return { id: issue.id, key: issue.key, url };
				};
				const uncertainPublication = (): never => {
					throw new Error(
						`Jira creation outcome is uncertain. Find the ticket with label ${marker} and retry after it is searchable; another POST is blocked`,
					);
				};
				let receipt: NonNullable<SplitDraft["receipt"]> | null = null;
				if (existing) {
					receipt = await ctx.externalWrites.ensure(
						{ writeType: "jira.create_issue", dedupKey: `jira-split:${key}` },
						{
							reconcile: readRemote,
							execute: async () => uncertainPublication(),
							toMetadata: (value) => value,
						},
					);
					if (state.labels.includes("use-leitwerk") && !services.wiki.publication(key)?.triggered) {
						const issue = await client.getIssue(receipt.id);
						if (
							issue.fields.labels.some(
								(label) => label === "use-leitwerk" || label === "leitwerk-done",
							)
						)
							services.wiki.markPublicationTriggered(key);
					}
				}
				if (
					!receipt ||
					(state.labels.includes("use-leitwerk") && !services.wiki.publication(key)?.triggered)
				) {
					if (projectChanged)
						return { reviewRequired: "Epic moved to a different Jira project; launch a new split" };
					const mapping = await componentMapping(services, params, repository);
					if (
						revision !== state.epicRevision ||
						mapping.mappingRevision !== draft.mappingRevision ||
						epic.fields.status.statusCategory.key === "done"
					)
						return { reviewRequired: "Epic or component mapping changed; review the batch again" };
					const blocked = await repositoryBlock(services, params, repository, draft);
					if (blocked) return { reviewRequired: blocked };
				}
				if (!receipt) {
					if (!client.createIssue || !client.createMetadata)
						throw new Error("Jira issue creation unavailable");
					const createIssue = client.createIssue.bind(client);
					const metadata = await client.createMetadata(epic.fields.project.id);
					const type = metadata.issueTypes.find(
						(candidate) => candidate.name.toLowerCase() === draft.issueType.toLowerCase(),
					);
					if (!type) throw new Error(`Jira does not offer ${draft.issueType} in this project`);
					const wikiUrl = `${services.serverBaseUrl.replace(/\/$/, "")}/wiki/${params.topicId}`;
					const fields: Record<string, unknown> = {
						project: { id: epic.fields.project.id },
						issuetype: { id: type.id },
						summary: draft.summary,
						description: `${draft.description}\n\nRepository: ${repository.name}\nEvidence (${draft.revision}): ${draft.evidence}\nEpic solution wiki: ${wikiUrl}\nLeitwerk split identity: ${marker}`,
						components: draft.componentIds.map((id) => ({ id })),
						labels: [...state.labels.filter((label) => label !== "use-leitwerk"), marker],
						[metadata.epicLinkField]: epic.key,
					};
					for (const [field, spec] of Object.entries(type.fields))
						if (spec.required && !spec.hasDefaultValue && !(field in fields))
							throw new Error(
								`Jira requires field ${field}; configure its default before publishing`,
							);
					receipt = await ctx.externalWrites.ensure(
						{ writeType: "jira.create_issue", dedupKey: `jira-split:${key}` },
						{
							reconcile: readRemote,
							execute: async () => {
								if (
									!services.wiki.reservePublication({
										key,
										topicId: params.topicId,
										binding,
										externalId: null,
										url: null,
									})
								)
									uncertainPublication();
								let created: JiraIssueReceipt;
								try {
									created = await createIssue(fields);
								} catch (error) {
									if (
										error instanceof JiraRequestError &&
										[400, 401, 403, 404, 422].includes(error.status)
									)
										services.wiki.releaseRejectedPublication(key);
									throw error;
								}
								const url = `${client.baseUrl}/browse/${encodeURIComponent(created.key)}`;
								services.wiki.finishPublication(
									key,
									jiraIssueExternalId(client.baseUrl, created.id),
									url,
								);
								return { ...created, url };
							},
							toMetadata: (receipt) => receipt,
						},
					);
				}
				if (state.labels.includes("use-leitwerk"))
					await ctx.externalWrites.ensure(
						{ writeType: "jira.split_trigger", dedupKey: `jira-split-trigger:${key}` },
						{
							reconcile: async (phase) => {
								const issue = await client.getIssue(receipt.id);
								if (
									services.wiki.publication(key)?.triggered ||
									phase === "already_recorded" ||
									issue.fields.labels.includes("use-leitwerk") ||
									issue.fields.labels.includes("leitwerk-done")
								) {
									services.wiki.markPublicationTriggered(key);
									return receipt;
								}
								return null;
							},
							execute: async () => {
								await client.updateLabels(receipt.id, [], ["use-leitwerk"]);
								services.wiki.markPublicationTriggered(key);
								return receipt;
							},
							toMetadata: (receipt) => receipt,
						},
					);
				return { receipt };
			},
		});
}
