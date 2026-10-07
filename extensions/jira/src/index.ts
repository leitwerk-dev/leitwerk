import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	coreHostCapabilities,
	createCapabilityToken,
	createExternalSourcePollReporter,
	defineProcessWatcherSource,
	type ExternalActionSource,
	type LeitwerkExtensionModule,
	parseProcessWatcherLaunchModelConfig,
	parseTicketCreationConfig,
	type ServerExtensionAPI,
	scopedSettingsCapability,
	type TicketCreationConfig,
} from "@leitwerk-dev/process-sdk";
import { createPollSchedule, emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import {
	JiraClient,
	type JiraClientLike,
	type JiraIssue,
	jiraEligible,
	jiraIssueExternalId,
	jiraTriggerLabel,
	parseJiraProfiles,
} from "./client.js";
import { registerJiraTicketCreation } from "./ticket-creation.js";
import { registerJiraTools } from "./tools.js";

export * from "./client.js";
export { markdownToJira } from "./markdown.js";
export {
	assertJiraTicketText,
	jiraTicketTextProblem,
	jiraTicketWritingInstructions,
	ticketDescriptionMarkdown,
} from "./ticket-text.js";
export { ensureIssueWiki, jiraEpicRevision, jiraWikiSource } from "./wiki.js";

/** @public */
export interface JiraIntegration {
	/** @internal */
	profiles(): readonly string[];

	/** @internal */
	client(profile: string): JiraClientLike;
}

/** @public */
export const jiraIntegration = createCapabilityToken<JiraIntegration>(
	"@leitwerk-dev/jira.integration",
);

/** @public */
export const jiraSubjectIdentity = (baseUrl: string, id: string) => JSON.stringify([baseUrl, id]);

/** @public */
export interface JiraWatcherConfig {
	/** @internal */
	label?: string;
	/** @internal */
	profile: string;

	/** @internal */
	projects: string[];

	/** @internal */
	pollInterval: string;
}

/** @public */
export interface JiraWatcherEvent {
	/** @internal */
	triggerLabel?: string;
	/** @internal */
	profile: string;

	/** @internal */
	issue: JiraIssue;

	/** @internal */
	projects: string[];
}

/** @public */
export const jiraIssueWatcherSource = defineProcessWatcherSource<
	JiraWatcherConfig,
	JiraWatcherEvent
>({
	id: "@leitwerk-dev/jira.issue",
	label: "Jira issue",
	parseConfig(raw) {
		const c = asUnknownRecord(raw);
		if (
			typeof c?.enabled !== "boolean" ||
			typeof c.profile !== "string" ||
			!c.profile.trim() ||
			!Array.isArray(c.projects) ||
			!c.projects.length ||
			c.projects.some((id) => typeof id !== "string" || !/^\d+$/.test(id))
		)
			throw new Error("Jira watcher requires enabled, profile, and explicit project IDs");
		const pollInterval = c.poll_interval ?? "30s";
		if (typeof pollInterval !== "string" || parseDurationMs(pollInterval, -1) <= 0)
			throw new Error("Invalid Jira poll_interval");
		return {
			enabled: c.enabled,
			config: {
				profile: c.profile,
				projects: c.projects as string[],
				pollInterval,
				label: jiraTriggerLabel(c.label),
			},
			launchModelConfig: parseProcessWatcherLaunchModelConfig(c.launch),
		};
	},
	presentConfig: (c) => ({
		targetSummary: `Jira ${c.profile} · ${c.projects.join(", ")}`,
		details: [{ label: "Trigger", value: jiraTriggerLabel(c.label) }],
	}),
});

/** @public */
export interface JiraSourceConfig {
	/** @internal */
	triggerLabel?: string;
	/** @internal */
	profile: string;
	/** @internal */
	baseUrl: string;

	/** @internal */
	issueId: string;

	/** @internal */
	planRevision?: number;

	/** @internal */
	mode: "plan_bypass" | "cancelled";
}
const ISSUE_POLICY = "@leitwerk-dev/jira.issue-policy";

/** @public */
export function jiraIssuePolicy<P, S>(
	resolve: (ctx: {
		/** @internal */
		params: P;
		/** @internal */
		state: S;
	}) => JiraSourceConfig,
): ExternalActionSource<P, S, unknown> {
	return {
		kind: ISSUE_POLICY,
		label: "Jira source policy",
		config: {},
		inputMode: "none",
		resolve,
	};
}

/** @public */
export function setupJiraIntegration(
	api: ServerExtensionAPI,
	integration: JiraIntegration,
	options: {
		/** @public */
		now?: () => number;
		/** @internal */
		ticketCreation?: TicketCreationConfig;
		/** Project IDs or keys explicitly selected by integration profiles. @internal */
		projects?: ReadonlyMap<string, readonly string[]>;
	} = {},
) {
	const now = options.now ?? Date.now;
	api.provide(jiraIntegration, integration);
	registerJiraTools(api, integration);
	registerJiraTicketCreation(
		api,
		integration,
		options.ticketCreation ?? { enabled: false, defaultLabels: [] },
	);
	const settings = api.get(scopedSettingsCapability);
	const deps = api.get(coreHostCapabilities.serverSetup);
	const configuredProjects = (profile: string) =>
		new Set([
			...(options.projects?.get(profile) ?? []),
			...(!deps || Array.isArray(deps)
				? []
				: (deps.processWatchers?.listBySource(jiraIssueWatcherSource) ?? [])
						.filter((watcher) => watcher.config.profile === profile)
						.flatMap((watcher) => watcher.config.projects)),
		]);
	const projectsFor = async (profile: string) => {
		const selected = configuredProjects(profile);
		if (!selected.size) return [];
		const client = integration.client(profile);
		const projects = (await client.listProjects()).filter(
			(project) => selected.has(project.id) || selected.has(project.key),
		);
		return projects;
	};
	const includesProject = (subject: import("@leitwerk-dev/domain").SettingsSubject | undefined) => {
		if (!subject) return false;
		let identity: unknown;
		try {
			identity = JSON.parse(subject.identity);
		} catch {
			return false;
		}
		if (!Array.isArray(identity) || identity.length !== 2) return false;
		const [origin, id] = identity;
		return integration.profiles().some((profile) => {
			if (integration.client(profile).baseUrl !== origin) return false;
			const configured = configuredProjects(profile);
			return configured.has(id) || configured.has(subject.label.split(" · ")[0]);
		});
	};
	if (settings && !Array.isArray(settings)) {
		settings.registerDiscovery(
			"jira.project",
			async () => {
				const subjects = [];
				for (const profile of integration.profiles()) {
					const client = integration.client(profile);
					for (const project of await projectsFor(profile))
						subjects.push({
							scopeType: "jira.project",
							identity: jiraSubjectIdentity(client.baseUrl, project.id),
							label: `${project.key} · ${project.name}`,
						});
				}
				return subjects;
			},
			{ includesSubject: (subject) => includesProject(subject) },
		);
		settings.registerDiscovery(
			"jira.component",
			async () => {
				const subjects = [];
				for (const profile of integration.profiles()) {
					const client = integration.client(profile);
					for (const project of await projectsFor(profile)) {
						const parent = settings.discover({
							scopeType: "jira.project",
							identity: jiraSubjectIdentity(client.baseUrl, project.id),
							label: `${project.key} · ${project.name}`,
						});
						for (const component of await client.listComponents(project.id))
							subjects.push({
								scopeType: "jira.component",
								identity: jiraSubjectIdentity(client.baseUrl, component.id),
								label: `${project.key} / ${component.name}`,
								context: { "jira.project": parent.id },
							});
					}
				}
				return subjects;
			},
			{ includesSubject: (_subject, context) => includesProject(context["jira.project"]) },
		);
	}
	if (!deps || Array.isArray(deps)) return;
	const shouldPoll = createPollSchedule(now);
	return deps.polling.create({
		id: "jira",
		pollInterval: () => "5s",
		defaultIntervalMs: 5000,
		isEnabled: () => true,
		async pollOnce() {
			const result = emptyPollResult();
			for (const watcher of deps.processWatchers?.listBySource(jiraIssueWatcherSource) ?? []) {
				const key = `${watcher.processId}:${watcher.watcherId}`;
				if (!watcher.enabled || !shouldPoll(key, watcher.config.pollInterval)) continue;
				try {
					const client = integration.client(watcher.config.profile);
					for (const issue of await client.searchIssues(
						watcher.config.projects,
						watcher.config.label,
					)) {
						if (
							!jiraEligible(issue, watcher.config.label) ||
							!watcher.config.projects.includes(issue.fields.project.id)
						)
							continue;
						const id = jiraIssueExternalId(client.baseUrl, issue.id);
						const launch = await deps.launchRuns.startWatcher(
							watcher,
							{
								profile: watcher.config.profile,
								issue,
								projects: watcher.config.projects,
								triggerLabel: jiraTriggerLabel(watcher.config.label),
							},
							{ idempotencyKey: id },
						);
						if (launch.error)
							result.errors.push(
								`${issue.key}: admission failed; inspect launch diagnostics and component mappings`,
							);
						else if (launch.process) result.created.push(id);
						else result.skipped.push(id);
					}
				} catch (error) {
					result.errors.push(error instanceof Error ? error.message : "Jira discovery unavailable");
				}
			}
			const report = createExternalSourcePollReporter(deps.externalSources, result, {
				forwardGeneration: true,
				currentKinds: [ISSUE_POLICY],
			});
			await report.poll(ISSUE_POLICY, async (armed) => {
				const key = `${armed.instanceId}:${armed.id}:${armed.generation}`;
				if (!shouldPoll(key)) return;
				const c = armed.resolved as unknown as JiraSourceConfig;
				try {
					const client = integration.client(c.profile);
					if (client.baseUrl !== c.baseUrl) throw new Error("Jira profile installation changed");
					const issue = await client.getIssue(c.issueId);
					if (issue.id !== c.issueId) throw new Error("Uncorrelated Jira issue evidence");
					const fire =
						c.mode === "plan_bypass"
							? jiraEligible(issue, c.triggerLabel) &&
								issue.fields.labels.includes("leitwerk-skip-plan-decision")
							: !jiraEligible(issue, c.triggerLabel);
					if (fire)
						await report.fire(
							armed,
							{ issueId: issue.id, planRevision: c.planRevision },
							`${issue.id}:${c.mode}:${c.planRevision ?? ""}`,
						);
				} catch (error) {
					await report.observe(armed, { refreshError: "Jira issue unavailable; policy unchanged" });
					throw error;
				}
			});
			return result;
		},
	});
}

/** @public */
const extension: LeitwerkExtensionModule = {
	manifest: { id: "jira", version: "0.3.0" },
	scopedSettings: {
		scopes: [
			{ id: "jira.project", label: "Jira projects" },
			{ id: "jira.component", label: "Jira components" },
		],
		settings: [],
	},
	setupServer(api, config) {
		const profiles = parseJiraProfiles(config);
		const clients = new Map([...profiles].map(([id, profile]) => [id, new JiraClient(profile)]));
		setupJiraIntegration(
			api,
			{
				profiles: () => [...clients.keys()],
				client: (profile) => {
					const client = clients.get(profile);
					if (!client) throw new Error(`Jira profile '${profile}' is unavailable`);
					return client;
				},
			},
			{
				ticketCreation: parseTicketCreationConfig(config, "Jira"),
				projects: new Map(
					[...profiles].map(([id, profile]) => [id, profile.project ? [profile.project] : []]),
				),
			},
		);
	},
};
export default extension;
