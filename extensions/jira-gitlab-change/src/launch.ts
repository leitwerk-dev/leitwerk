import { createHash } from "node:crypto";
import { asUnknownRecord, type SettingsSource } from "@leitwerk-dev/domain";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	type GitLabIntegration,
	type GitLabPublicationParams,
	resolveGitLabLaunchProject,
} from "@leitwerk-dev/gitlab";
import {
	ensureIssueWiki,
	type JiraIntegration,
	type JiraIssue,
	type JiraWatcherEvent,
	jiraEligible,
	jiraIsEpic,
	jiraIssueExternalId,
	jiraSplitChildMatches,
	jiraSubjectIdentity,
	jiraTriggerLabel,
} from "@leitwerk-dev/jira";
import {
	type Codec,
	type LauncherContext,
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	repositorySettingsIdentity,
	SafeLaunchPreparationError,
	type ScopedSettingsResolver,
	type SettingDefinition,
	type TopicWikiStore,
} from "@leitwerk-dev/process-sdk";

import { selectJiraModel } from "./models.js";

/** @public */
export interface RepositoryMapping {
	/** @internal */
	origin: string;

	/** @internal */
	projectId: number;

	/** @internal */
	gitlabProfile: string;

	/** @internal */
	sshProfile?: string;
}

/** @public */
export interface RepositoryBinding extends GitLabPublicationParams {
	/** @internal */
	key: string;

	/** @internal */
	origin: "jira";

	/** @internal */
	gitlabOrigin: string;

	/** @internal */
	sshProfile?: string;

	/** @internal */
	repoLocator: string;
}

/** @public */
export interface JiraGitLabParams extends GitLabPublicationParams {
	/** @internal */
	jiraTriggerLabel?: string;
	/** @internal */
	modelSelection?: {
		/** @internal */
		label: string;
		/** @internal */
		profileId: string;
	};
	/** @internal */
	wikiTopicId?: string;
	/** @internal */
	origin: "jira";

	/** @internal */
	jiraProfile: string;

	/** @internal */
	jiraBaseUrl: string;

	/** @internal */
	issueId: string;

	/** @internal */
	issueKey: string;

	/** @internal */
	issueUrl: string;

	/** @internal */
	prompt: string;

	/** @internal */
	issue: JiraIssue;

	/** @internal */
	repositories: RepositoryBinding[];

	/** @internal */
	mappings: {
		/** @internal */
		componentId: string;
		/** @internal */ values: string[];
		/** @internal */ sources: SettingsSource[];
	}[];
}
function parseMapping(value: unknown): RepositoryMapping {
	if (typeof value !== "string") throw new Error("Select a repository and its GitLab profile");
	let r: Record<string, unknown> | null;
	try {
		r = asUnknownRecord(JSON.parse(value));
	} catch {
		throw new Error("Invalid repository mapping; reselect it in Settings");
	}
	return validateMapping(r);
}

function validateMapping(r: Record<string, unknown> | null): RepositoryMapping {
	if (
		!r ||
		typeof r.origin !== "string" ||
		new URL(r.origin).origin !== r.origin ||
		typeof r.projectId !== "number" ||
		!Number.isSafeInteger(r.projectId) ||
		r.projectId <= 0 ||
		typeof r.gitlabProfile !== "string" ||
		!r.gitlabProfile ||
		(r.sshProfile !== undefined && (typeof r.sshProfile !== "string" || !r.sshProfile))
	)
		throw new Error("Invalid repository mapping; reselect it in Settings");
	return r as unknown as RepositoryMapping;
}

/** @public */
export const jiraGitLabParamsCodec: Codec<JiraGitLabParams> = {
	parse(value) {
		const r = asUnknownRecord(value);
		jiraTriggerLabel(r?.jiraTriggerLabel);
		if (
			r?.origin !== "jira" ||
			!Array.isArray(r.repositories) ||
			!r.repositories.length ||
			!Array.isArray(r.mappings) ||
			!asUnknownRecord(r.issue)
		)
			throw new Error("Invalid Jira GitLab launch snapshot");
		for (const key of ["jiraProfile", "jiraBaseUrl", "issueId", "issueKey", "issueUrl", "prompt"])
			if (typeof r[key] !== "string" || !r[key]) throw new Error(`Missing ${key}`);
		for (const item of r.repositories) {
			const repo = asUnknownRecord(item);
			if (!repo || typeof repo.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(repo.key))
				throw new Error("Invalid repository key");
			validateMapping({ ...repo, origin: repo.gitlabOrigin });
			for (const key of ["repoLocator", "owner", "repo", "baseBranch", "workBranch"])
				if (typeof repo[key] !== "string" || !repo[key])
					throw new Error(`Missing repository ${key}`);
		}
		if (new Set(r.repositories.map((repo) => repo.key)).size !== r.repositories.length)
			throw new Error("Duplicate repository key");
		return r as unknown as JiraGitLabParams;
	},
	serialize: (value) => value,
};

/** @public */
export function createJiraGitLabLauncher() {
	/** @internal */
	let services: {
		/** @internal */
		jira: JiraIntegration;

		/** @internal */
		gitlab: GitLabIntegration;

		/** @internal */
		ssh?: GitSshIntegration;

		/** @internal */
		settings: ScopedSettingsResolver;
		/** @internal */
		wiki?: TopicWikiStore;
		/** @internal */
		modelLabels?: Readonly<Record<string, string>>;
	} | null = null;
	const requireServices = () => {
		if (!services) throw new Error("Jira GitLab integration is not configured");
		return services;
	};
	const mapping: SettingDefinition<string[]> = {
		key: "jira-gitlab-change.repositories",
		schemaVersion: 1,
		scopes: ["jira.component"],
		merge: "replace",
		defaultValue: [],
		form: {
			label: "GitLab repositories",
			group: "Repository mapping",
			control: "multiselect",
			description: "Use the GitLab profile's token over HTTPS, or select a configured SSH profile.",
		},
		schema: {
			parse(value) {
				if (!Array.isArray(value)) throw new Error("Choose repositories");
				for (const entry of value) parseMapping(entry);
				return [...new Set(value)] as string[];
			},
		},
		async choices() {
			const { gitlab, ssh } = requireServices();
			const choices = [];
			for (const gitlabProfile of gitlab.profiles()) {
				const client = gitlab.client(gitlabProfile);
				for (const repo of await client.listProjects()) {
					if (repo.archived || !repo.default_branch) continue;
					if (repo.http_url_to_repo)
						choices.push({
							value: JSON.stringify({ origin: client.baseUrl, projectId: repo.id, gitlabProfile }),
							label: `${repo.path_with_namespace} · ${gitlabProfile} / HTTPS`,
						});
					if (!repo.ssh_url_to_repo) continue;
					for (const sshProfile of ssh?.profiles() ?? [])
						choices.push({
							value: JSON.stringify({
								origin: client.baseUrl,
								projectId: repo.id,
								gitlabProfile,
								sshProfile,
							}),
							label: `${repo.path_with_namespace} · ${gitlabProfile} / ${sshProfile}`,
						});
				}
			}
			return choices;
		},
	};

	/** @internal */
	async function resolve(
		event: JiraWatcherEvent,
		ctx: LauncherContext = {},
	): Promise<ProcessLaunchConfig<JiraGitLabParams>> {
		const { jira, gitlab, ssh, settings, wiki } = requireServices();
		const client = jira.client(event.profile);
		const issue = await client.getIssue(event.issue.id);
		if (
			issue.id !== event.issue.id ||
			!jiraEligible(issue, event.triggerLabel) ||
			!event.projects.includes(issue.fields.project.id)
		)
			throw new Error("Jira source issue is no longer eligible");
		const triggerLabel = jiraTriggerLabel(event.triggerLabel);
		const modelSelection = selectJiraModel(
			issue.fields.labels,
			requireServices().modelLabels ?? {},
		);
		if (
			modelSelection &&
			ctx.modelProfiles &&
			!ctx.modelProfiles.some((p) => p.id === modelSelection.profileId)
		)
			throw new Error(
				`Jira model profile ${modelSelection.profileId} is unavailable for this process`,
			);
		const project = settings.discover({
			scopeType: "jira.project",
			identity: jiraSubjectIdentity(client.baseUrl, issue.fields.project.id),
			label: issue.fields.project.key,
		});
		const mappings: JiraGitLabParams["mappings"] = [];
		const selected = new Map<string, RepositoryMapping>();
		const publication = wiki?.publicationByExternalId(
			jiraIssueExternalId(client.baseUrl, issue.id),
		);
		for (const component of issue.fields.components) {
			const subject = settings.discover({
				scopeType: "jira.component",
				identity: jiraSubjectIdentity(client.baseUrl, component.id),
				label: `${issue.fields.project.key} / ${component.name}`,
				context: { "jira.project": project.id },
			});
			const resolved = settings.resolve(mapping, {
				"jira.project": project.id,
				"jira.component": subject.id,
			});
			mappings.push({
				componentId: component.id,
				values: resolved.value,
				sources: resolved.sources,
			});
			for (const value of resolved.value) {
				const entry = parseMapping(value);
				if (
					publication &&
					(entry.origin !== publication.binding.origin ||
						entry.projectId !== publication.binding.projectId)
				)
					continue;
				const key = repositorySettingsIdentity(entry.origin, entry.projectId);
				const prior = selected.get(key);
				if (
					prior &&
					(prior.gitlabProfile !== entry.gitlabProfile || prior.sshProfile !== entry.sshProfile)
				)
					throw new Error(
						`Conflicting profiles for project ${entry.projectId}; correct the component mappings in Settings`,
					);
				selected.set(key, entry);
			}
		}
		if (publication) {
			const binding = publication.binding;
			const exact = [...selected.entries()].find(
				([, entry]) =>
					entry.origin === binding.origin &&
					entry.projectId === binding.projectId &&
					entry.gitlabProfile === binding.gitlabProfile &&
					(binding.sshProfile === undefined || entry.sshProfile === binding.sshProfile),
			);
			if (!exact)
				throw new Error(
					"Generated ticket's repository binding no longer matches its component mappings",
				);
			selected.clear();
			selected.set(...exact);
		}
		if (!selected.size)
			throw new Error(
				`No repositories mapped for ${issue.key}. Map at least one component in Settings → Jira components.`,
			);
		const repositories: RepositoryBinding[] = [];
		const projects: import("@leitwerk-dev/process-sdk").ProcessLaunchProjectConfig[] = [];
		for (const entry of selected.values()) {
			const provider = gitlab.client(entry.gitlabProfile);
			if (
				provider.baseUrl !== entry.origin ||
				(entry.sshProfile !== undefined && !ssh?.profiles().includes(entry.sshProfile))
			)
				throw new Error(
					`Unavailable mapping for GitLab project ${entry.projectId}; update its profiles in Settings`,
				);
			const repo = await provider.getProject(entry.projectId);
			if (repo.id !== entry.projectId) throw new Error("GitLab repository identity changed");
			const repoLocator = entry.sshProfile ? repo.ssh_url_to_repo : repo.http_url_to_repo;
			if (repo.archived || !repo.default_branch || !repoLocator)
				throw new Error(
					`GitLab project ${entry.projectId} must be active and provide the selected clone URL`,
				);
			if (
				publication &&
				((publication.binding.repoLocator !== undefined &&
					repoLocator !== publication.binding.repoLocator) ||
					(publication.binding.repository !== undefined &&
						repo.path_with_namespace !== publication.binding.repository) ||
					repo.default_branch !== publication.binding.baseBranch)
			)
				throw new Error("Generated ticket's repository checkout binding changed");
			const key = `repo_${repositories.length + 1}`;
			const { params: binding, project } = await resolveGitLabLaunchProject(
				provider,
				entry.gitlabProfile,
				{ ...repo, id: entry.projectId },
				`leitwerk/jira-${createHash("sha256").update(client.baseUrl).digest("hex").slice(0, 10)}-${issue.id}`,
				key,
				entry.sshProfile ? "ssh" : "https",
			);
			if (
				publication?.binding.workBranch !== undefined &&
				publication.binding.workBranch !== binding.workBranch
			)
				throw new Error("Generated ticket's repository work branch binding changed");
			repositories.push({ ...binding, key, origin: "jira", sshProfile: entry.sshProfile });
			projects.push({
				...project,
				metadata: {
					...project.metadata,
					jira: {
						profile: event.profile,
						baseUrl: client.baseUrl,
						issueId: issue.id,
						triggerLabel,
					},
				},
			});
		}
		const first = repositories[0];
		let sourceIssue: JiraIssue | null = null;
		if (publication) {
			const sourceIssueId = publication.binding.sourceIssueId ?? publication.binding.epicId;
			const relationship = publication.binding.relationship ?? "epic";
			if (
				typeof sourceIssueId !== "string" ||
				(relationship !== "epic" && relationship !== "subtask") ||
				!(await jiraSplitChildMatches(client, issue, sourceIssueId, relationship))
			)
				throw new Error("Generated ticket's source issue binding changed");
			sourceIssue = await client.getIssue(sourceIssueId);
			if (
				sourceIssue.id !== sourceIssueId ||
				sourceIssue.fields.project.id !== issue.fields.project.id ||
				sourceIssue.fields.issuetype?.subtask === true ||
				jiraIsEpic(sourceIssue) !== (relationship === "epic")
			)
				throw new Error("Generated ticket's source issue binding changed");
		} else if (wiki && issue.fields.issuetype?.subtask === true) {
			if (!issue.fields.parent?.id) throw new Error("Jira subtask parent is unavailable");
			sourceIssue = await client.getIssue(issue.fields.parent.id);
		} else if (wiki && client.getEpic) {
			sourceIssue = await client.getEpic(issue);
		}
		const topic =
			wiki && sourceIssue ? ensureIssueWiki(wiki, client, sourceIssue, publication?.topicId) : null;
		if (publication && topic?.id !== publication.topicId)
			throw new Error("Generated ticket's source issue wiki binding changed");
		const params: JiraGitLabParams = {
			jiraTriggerLabel: triggerLabel,
			...(modelSelection ? { modelSelection } : {}),
			...(topic ? { wikiTopicId: topic.id } : {}),
			...first,
			origin: "jira",
			jiraProfile: event.profile,
			jiraBaseUrl: client.baseUrl,
			issueId: issue.id,
			issueKey: issue.key,
			issueUrl: `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
			prompt: `${issue.key}: ${issue.fields.summary}\n\n${issue.fields.description ?? ""}`,
			issue,
			mappings,
			repositories,
		};
		return {
			processId: "jira_gitlab_change_process",
			defaultModelProfileId: modelSelection?.profileId,
			...(topic && sourceIssue
				? {
						metadata: {
							wiki: {
								topicId: topic.id,
								profile: event.profile,
								baseUrl: client.baseUrl,
								issueId: sourceIssue.id,
							},
						},
					}
				: {}),
			title: `${issue.key}: ${issue.fields.summary}`,
			params,
			projects,
			startTurnId: "generate_plan",
			externalId: jiraIssueExternalId(client.baseUrl, issue.id),
			externalUrl: params.issueUrl,
			settingsContext: { "jira.project": project.id },
		};
	}
	const checks = (
		event: JiraWatcherEvent,
		launch: ProcessLaunchConfig<JiraGitLabParams>,
	): readonly LaunchPreparationCheck<JiraGitLabParams>[] => [
		...launch.params.repositories.map<LaunchPreparationCheck<JiraGitLabParams>>((repo) => ({
			id: `${repo.sshProfile ? "ssh" : "https"}_${repo.key}`,
			label: `Verify ${repo.owner}/${repo.repo} ${repo.sshProfile ? "SSH" : "HTTPS"} read/write access`,
			async run(ctx) {
				const { gitlab, ssh } = requireServices();
				const client = gitlab.client(repo.gitlabProfile);
				const fresh = await client.getProject(repo.projectId, ctx.signal);
				if (
					client.baseUrl !== repo.gitlabOrigin ||
					fresh.id !== repo.projectId ||
					fresh.archived ||
					(repo.sshProfile ? fresh.ssh_url_to_repo : fresh.http_url_to_repo) !== repo.repoLocator ||
					fresh.default_branch !== repo.baseBranch
				)
					throw new SafeLaunchPreparationError(
						"Repository changed",
						"Refresh the component mapping and retry launch.",
					);
				if (!repo.sshProfile) {
					await client.preflightRepository(
						repo.projectId,
						repo.baseBranch,
						repo.workBranch,
						ctx.signal,
					);
					return;
				}
				if (!ssh) throw new Error("Git SSH profile is unavailable");
				await createGitSshPreparationCheck(
					"write",
					{ ...repo, sshCredentialRef: repo.sshProfile },
					() => ssh,
				).run(ctx);
			},
		})),
		{
			id: "jira_eligibility",
			label: "Recheck Jira issue and component mappings",
			async run() {
				const fresh = await resolve(event);
				if (JSON.stringify(fresh.params) !== JSON.stringify(launch.params))
					throw new SafeLaunchPreparationError(
						"Jira issue or mappings changed before admission",
						"Retry launch to capture the latest issue and mappings.",
					);
			},
		},
	];
	return {
		/** @internal */
		mapping,

		/** @internal */
		resolve,

		/** @internal */
		checks,

		/** @internal */
		configure(value: typeof services) {
			services = value;
		},

		/** @internal */
		async readIssue(params: JiraGitLabParams) {
			const client = requireServices().jira.client(params.jiraProfile);
			if (client.baseUrl !== params.jiraBaseUrl) throw new Error("Jira installation changed");
			return client.getIssue(params.issueId);
		},
	};
}
