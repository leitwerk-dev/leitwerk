import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asUnknownRecord, type SettingsSource } from "@leitwerk-dev/domain";
import type { PublicationStore } from "@leitwerk-dev/external-writes";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	createGitLabRepositoryCatalog,
	GitLabError,
	type GitLabIntegration,
	type GitLabPublicationParams,
	type GitLabRepositoryCatalog,
	resolveGitLabLaunchProject,
} from "@leitwerk-dev/gitlab";
import {
	ensureIssueWiki,
	type JiraIntegration,
	type JiraIssue,
	JiraRequestError,
	type JiraWatcherEvent,
	jiraEligible,
	jiraIsEpic,
	jiraIssueExternalId,
	jiraSplitChildMatches,
	jiraSubjectIdentity,
	jiraToMarkdown,
	jiraTriggerLabel,
} from "@leitwerk-dev/jira";
import {
	type Codec,
	type LauncherContext,
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	RetryableWaitError,
	repositorySettingsIdentity,
	SafeLaunchPreparationError,
	type ScopedSettingsResolver,
	type SettingDefinition,
	type TurnWaitContext,
} from "@leitwerk-dev/process-sdk";
import type { TopicWikiStore } from "@leitwerk-dev/wiki";

import { selectJiraModel } from "./models.js";

class JiraSourceIneligibleError extends Error {
	constructor() {
		super("Jira source issue is no longer eligible");
	}
}

function eligibleSource(issue: JiraIssue, event: JiraWatcherEvent): boolean {
	return (
		issue.id === event.issue.id &&
		jiraEligible(issue, event.triggerLabel) &&
		event.projects.includes(issue.fields.project.id)
	);
}

/** @public */
export interface RepositoryMapping {
	/** @public */
	origin: string;

	/** @public */
	projectId: number;

	/** @public */
	gitlabProfile: string;

	/** @public */
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
export interface JiraGitLabParams extends Partial<GitLabPublicationParams> {
	/** Present only until initial repository bindings are resolved. @internal */
	startup?: {
		/** Captured watcher scope; later watcher edits do not retarget this process. @internal */
		projectIds: string[];
	};
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

/** Builds Markdown from captured Jira evidence. @internal */
export function jiraChangePrompt(issue: JiraIssue): string {
	return `${issue.key}: ${issue.fields.summary}\n\n${jiraToMarkdown(issue.fields.description)}`;
}

function admissionParams(params: JiraGitLabParams) {
	const { id, key, fields } = params.issue;
	// Jira plugin fields can change on every read without an issue revision.
	// Keep the raw issue as evidence, but compare only the launch contract.
	return {
		...params,
		issue: {
			id,
			key,
			fields: {
				updated: fields.updated,
				summary: fields.summary,
				description: fields.description,
				labels: [...fields.labels].sort(),
				project: { id: fields.project.id, key: fields.project.key, name: fields.project.name },
				components: fields.components.map(({ id, name }) => ({ id, name })),
				statusCategory: fields.status.statusCategory.key,
				issuetype: fields.issuetype && {
					id: fields.issuetype.id,
					name: fields.issuetype.name,
					subtask: fields.issuetype.subtask,
				},
				parent: fields.parent && { id: fields.parent.id, key: fields.parent.key },
			},
		},
	};
}

/** Decode a retained repository selection without remote discovery. @public */
export function decodeJiraGitLabRepositoryMapping(value: unknown): RepositoryMapping {
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
			(!r.repositories.length && !asUnknownRecord(r.startup)) ||
			!Array.isArray(r.mappings) ||
			!asUnknownRecord(r.issue)
		)
			throw new Error("Invalid Jira GitLab launch snapshot");
		for (const key of ["jiraProfile", "jiraBaseUrl", "issueId", "issueKey", "issueUrl", "prompt"])
			if (typeof r[key] !== "string" || !r[key]) throw new Error(`Missing ${key}`);
		if (r.startup !== undefined) {
			const startup = asUnknownRecord(r.startup);
			if (
				r.repositories.length ||
				!Array.isArray(startup?.projectIds) ||
				!startup.projectIds.length ||
				startup.projectIds.some((id) => typeof id !== "string" || !id) ||
				[
					"owner",
					"repo",
					"gitlabProfile",
					"projectId",
					"repoLocator",
					"baseBranch",
					"workBranch",
				].some((key) => r[key] !== undefined)
			)
				throw new Error("Invalid pending Jira repository binding");
		}
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

/** Component-to-repository Settings contract. Register it only through this extension. @public */
export const jiraGitLabRepositories: SettingDefinition<string[]> = {
	key: "jira-gitlab-change.repositories",
	schemaVersion: 1,
	scopes: ["jira.component"],
	merge: "replace",
	defaultValue: [],
	form: {
		label: "GitLab repositories",
		group: "Repository mapping",
		control: "multiselect",
		overview: "repository-mapping",
		search: { minimumLength: 2, placeholder: "Search GitLab repositories" },
		description: "Use the GitLab profile's token over HTTPS, or select a configured SSH profile.",
	},
	schema: {
		parse(value) {
			if (!Array.isArray(value)) throw new Error("Choose repositories");
			for (const entry of value) decodeJiraGitLabRepositoryMapping(entry);
			return [...new Set(value)] as string[];
		},
	},
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
		publications?: PublicationStore;
		/** @internal */
		modelLabels?: Readonly<Record<string, string>>;
	} | null = null;
	let repositoryCatalog: GitLabRepositoryCatalog | null = null;
	const requireServices = () => {
		if (!services) throw new Error("Jira GitLab integration is not configured");
		return services;
	};
	const mapping: SettingDefinition<string[]> = {
		...jiraGitLabRepositories,
		choiceLabel(value) {
			const mapping = decodeJiraGitLabRepositoryMapping(value);
			const { gitlab, settings } = requireServices();
			const retained = settings.findSubject(
				"repository",
				repositorySettingsIdentity(mapping.origin, mapping.projectId),
			);
			let path = retained?.label;
			if (!path) {
				const known = gitlab.profiles().includes(mapping.gitlabProfile)
					? repositoryCatalog?.peek(mapping.gitlabProfile, mapping.projectId)
					: undefined;
				path =
					known && gitlab.client(mapping.gitlabProfile).baseUrl === mapping.origin
						? known.path_with_namespace
						: `Repository ${mapping.projectId}`;
			}
			return `${path} · ${mapping.gitlabProfile} / ${mapping.sshProfile ?? "HTTPS"}`;
		},
		async choices(_context, request = {}) {
			const { gitlab, ssh, settings } = requireServices();
			if (!repositoryCatalog) throw new Error("GitLab repository catalog is not configured");
			const query = (request.search ?? "").trim();
			if (query.length < 2) return [];
			const choices = [];
			for (const gitlabProfile of gitlab.profiles()) {
				const client = gitlab.client(gitlabProfile);
				const projects = [...(await repositoryCatalog.search(gitlabProfile, query))];
				for (const value of request.values ?? []) {
					const selected = decodeJiraGitLabRepositoryMapping(value);
					if (
						selected.gitlabProfile !== gitlabProfile ||
						selected.origin !== client.baseUrl ||
						projects.some((repo) => repo.id === selected.projectId)
					)
						continue;
					const project = repositoryCatalog.peek(gitlabProfile, selected.projectId);
					if (project) projects.push(project);
				}
				for (const repo of projects) {
					if (repo.archived || !repo.default_branch) continue;
					settings.discover({
						scopeType: "repository",
						identity: repositorySettingsIdentity(client.baseUrl, repo.id),
						label: repo.path_with_namespace,
					});
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
			for (const value of request.values ?? [])
				if (!choices.some((choice) => choice.value === value))
					choices.push({ value, label: mapping.choiceLabel?.(value) ?? value });
			return choices;
		},
	};

	/** @internal */
	async function resolve(
		event: JiraWatcherEvent,
		ctx: LauncherContext = {},
		retained?: JiraGitLabParams,
		signal?: AbortSignal,
	): Promise<ProcessLaunchConfig<JiraGitLabParams>> {
		const { jira, gitlab, ssh, settings, wiki, publications } = requireServices();
		const client = jira.client(event.profile);
		const issue = await client.getIssue(event.issue.id, signal);
		if (!eligibleSource(issue, event)) throw new JiraSourceIneligibleError();
		const triggerLabel = jiraTriggerLabel(event.triggerLabel);
		const modelSelection = retained
			? retained.modelSelection
			: selectJiraModel(issue.fields.labels, requireServices().modelLabels ?? {});
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
		const source = {
			origin: "jira" as const,
			jiraTriggerLabel: triggerLabel,
			...(modelSelection ? { modelSelection } : {}),
			jiraProfile: event.profile,
			jiraBaseUrl: client.baseUrl,
			issueId: issue.id,
			issueKey: issue.key,
			issueUrl: `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
			prompt: jiraChangePrompt(issue),
			issue,
		};
		const launch = {
			processId: "jira_gitlab_change_process",
			defaultModelProfileId: modelSelection?.profileId,
			title: `${issue.key}: ${issue.fields.summary}`,
			startTurnId: "generate_plan",
			externalId: jiraIssueExternalId(client.baseUrl, issue.id),
			externalUrl: source.issueUrl,
			settingsContext: { "jira.project": project.id },
		};
		const mappings: JiraGitLabParams["mappings"] = [];
		const selected = new Map<string, RepositoryMapping>();
		const publication = publications?.publicationByExternalId(
			jiraIssueExternalId(client.baseUrl, issue.id),
		);
		const componentPublication = publication && typeof publication.binding.componentId === "string";
		if (
			componentPublication &&
			(issue.fields.components.length !== 1 ||
				issue.fields.components[0].id !== publication.binding.componentId)
		)
			throw new Error("Generated ticket's component identity changed");
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
		}
		if (!mappings.length || mappings.some((mapping) => !mapping.values.length)) {
			return {
				...launch,
				projects: [],
				params: {
					...source,
					mappings,
					repositories: [],
					startup: { projectIds: [...event.projects] },
				},
			};
		}
		for (const mapping of mappings) {
			for (const value of mapping.values) {
				const entry = decodeJiraGitLabRepositoryMapping(value);
				if (
					publication &&
					!componentPublication &&
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
		if (publication && !componentPublication) {
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
			const repo = await provider.getProject(entry.projectId, signal);
			if (repo.id !== entry.projectId) throw new Error("GitLab repository identity changed");
			const repoLocator = entry.sshProfile ? repo.ssh_url_to_repo : repo.http_url_to_repo;
			if (repo.archived || !repo.default_branch || !repoLocator)
				throw new Error(
					`GitLab project ${entry.projectId} must be active and provide the selected clone URL`,
				);
			if (
				publication &&
				!componentPublication &&
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
			...(topic ? { wikiTopicId: topic.id } : {}),
			...first,
			...source,
			mappings,
			repositories,
		};
		return {
			...launch,
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
			params,
			projects,
		};
	}
	const checks = (
		event: JiraWatcherEvent,
		launch: ProcessLaunchConfig<JiraGitLabParams>,
		retained?: JiraGitLabParams,
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
			async run({ signal }) {
				if (launch.params.startup) {
					const issue = await requireServices()
						.jira.client(event.profile)
						.getIssue(event.issue.id, signal);
					if (!eligibleSource(issue, event))
						throw new SafeLaunchPreparationError(
							"Jira source issue is no longer eligible",
							"Restore the watcher label and project eligibility before launching.",
						);
					return;
				}
				const fresh = await resolve(event, {}, retained, signal);
				if (!isDeepStrictEqual(admissionParams(fresh.params), admissionParams(launch.params)))
					throw new SafeLaunchPreparationError(
						"Jira issue or mappings changed before admission",
						"Retry launch to capture the latest issue and mappings.",
					);
			},
		},
	];
	/** Check startup readiness against the current source and mappings. @internal */
	async function ready(
		context: Pick<
			TurnWaitContext<JiraGitLabParams>,
			"params" | "signal" | "waiting" | "abort" | "bindInitialProjects"
		>,
	) {
		const { params, signal } = context;
		if (!params.startup) return true;
		try {
			const client = requireServices().jira.client(params.jiraProfile);
			if (client.baseUrl !== params.jiraBaseUrl) throw new Error("Jira installation changed");
			const issue = await client.getIssue(params.issueId, signal);
			if (issue.id !== params.issueId) throw new Error("Jira issue identity changed");
			const event: JiraWatcherEvent = {
				profile: params.jiraProfile,
				triggerLabel: params.jiraTriggerLabel,
				projects: params.startup.projectIds,
				issue,
			};
			if (!eligibleSource(issue, event))
				return context.abort("Jira source is no longer eligible; startup cancelled");
			const launch = await resolve(event, {}, params, signal);
			if (launch.params.startup) {
				const missing = launch.params.issue.fields.components.filter(
					(component) =>
						!launch.params.mappings.find((mapping) => mapping.componentId === component.id)?.values
							.length,
				);
				const reason = missing.length
					? `no GitLab repository mapping for ${missing.map((component) => component.name).join(", ")}. Configure GitLab repositories in Settings → Jira components.`
					: "no Jira components. Assign at least one component to the issue and configure its GitLab repositories in Settings → Jira components.";
				return context.waiting(
					`Startup blocked: ${launch.params.issueKey} has ${reason} Startup will resume automatically.`,
				);
			}
			for (const check of checks(event, launch, params)) {
				signal.throwIfAborted();
				await check.run({ signal, launchConfig: launch, logger: { info() {}, warn() {} } });
			}
			return context.bindInitialProjects({
				params: launch.params,
				projects: launch.projects ?? [],
				metadata: launch.metadata,
				settingsContext: launch.settingsContext,
			});
		} catch (error) {
			if (error instanceof JiraSourceIneligibleError)
				return context.abort("Jira source is no longer eligible; startup cancelled");
			if (
				(error instanceof GitLabError && error.retryable) ||
				(error instanceof JiraRequestError &&
					(error.status === 408 || error.status === 429 || error.status >= 500)) ||
				(error instanceof TypeError && /fetch|network/i.test(error.message))
			)
				throw new RetryableWaitError(
					"Jira or GitLab is temporarily unavailable; startup will be checked again.",
				);
			if (
				error instanceof SafeLaunchPreparationError &&
				error.message.includes("changed before admission")
			)
				return context.waiting(
					"Jira issue or mappings changed during startup checks. Checking the latest configuration again.",
				);
			if (error instanceof SafeLaunchPreparationError)
				throw new Error(`${error.message}. ${error.safeSummary}`);
			throw error;
		}
	}
	return {
		/** @internal */
		ready,
		/** @internal */
		mapping,

		/** @internal */
		resolve,

		/** @internal */
		checks,

		/** @internal */
		configure(value: typeof services) {
			if (value?.gitlab !== services?.gitlab)
				repositoryCatalog = value
					? (value.gitlab.repositoryCatalog ?? createGitLabRepositoryCatalog(value.gitlab))
					: null;
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
