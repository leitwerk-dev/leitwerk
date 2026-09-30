import { asUnknownRecord } from "@leitwerk-dev/domain";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { gitlabIntegration } from "@leitwerk-dev/gitlab";
import { type JiraIssue, jiraIntegration, jiraIssueExternalId } from "@leitwerk-dev/jira";
import {
	coreHostCapabilities,
	defineProcessWatcherSource,
	type LeitwerkExtensionModule,
	type ProcessLauncherDefinition,
	scopedSettingsCapability,
	stringArg,
	topicWikiCapability,
} from "@leitwerk-dev/process-sdk";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { SplitParams } from "./model.js";
import { createSplitProcess } from "./process.js";
import {
	launchSplit,
	parseSplitOptions,
	registerSplitTools,
	type SplitServices,
} from "./services.js";

let services: SplitServices | null = null;
function configured(): SplitServices {
	if (!services) throw new Error("Jira epic splitting is not configured");
	return services;
}

/** @internal */
export const epicSplitSource = defineProcessWatcherSource<
	Record<string, unknown>,
	Record<string, unknown>
>({
	id: "@leitwerk-dev/jira-epic-split.epic",
	label: "Jira epic split label",
	parseConfig(raw) {
		const config = asUnknownRecord(raw);
		if (
			!config ||
			typeof config.enabled !== "boolean" ||
			!Array.isArray(config.jiraProjects) ||
			!config.jiraProjects.length ||
			config.jiraProjects.some((project) => typeof project !== "string" || !/^\d+$/.test(project))
		)
			throw new Error("Epic watcher requires enabled and explicit jiraProjects IDs");
		for (const key of ["jiraProfile", "gitlabProfile", "sshProfile"]) stringArg(config, key);
		const pollInterval = config.pollInterval ?? "30s";
		if (typeof pollInterval !== "string" || parseDurationMs(pollInterval, -1) <= 0)
			throw new Error("Invalid epic pollInterval");
		parseSplitOptions(config);
		return { enabled: config.enabled, config: { ...config, pollInterval } };
	},
	presentConfig: (config) => ({
		targetSummary: `Jira ${config.jiraProfile} · ${(config.jiraProjects as string[]).join(", ")}`,
		details: [{ label: "Trigger", value: "leitwerk-epic-split" }],
	}),
});

const launcher: ProcessLauncherDefinition<SplitParams> = {
	id: "jira_epic_split_process.ui_launcher",
	label: "Jira Epic Split",
	description: "Prepare one repository ticket for each applicable GitLab repository",
	visibility: "ui",
	ui: {
		card: {
			title: "Jira Epic Split",
			description:
				"Standardize changes across repositories with reviewed Jira tickets and a shared solution wiki.",
		},
		launchConfigSchema: {
			id: "jira_epic_split",
			title: "Split a Jira epic",
			submitLabel: "Analyze epic",
			fields: [
				{ id: "jiraProfile", label: "Jira profile", kind: "select", required: true },
				{ id: "epic", label: "Epic key", kind: "text", required: true },
				{ id: "gitlabProfile", label: "GitLab profile", kind: "select", required: true },
				{ id: "sshProfile", label: "Git SSH profile", kind: "select", required: true },
				{
					id: "groups",
					label: "GitLab groups",
					kind: "textarea",
					description: "Exact group paths, one per line; includes subgroups.",
				},
				{
					id: "projects",
					label: "Additional GitLab projects",
					kind: "textarea",
					description: "Exact project paths, one per line.",
				},
				{ id: "excludeGroups", label: "Excluded groups", kind: "textarea" },
				{ id: "excludeProjects", label: "Excluded projects", kind: "textarea" },
				{
					id: "issueType",
					label: "Default ticket type",
					kind: "select",
					options: [
						{ value: "Story", label: "Story" },
						{ value: "Task", label: "Task" },
					],
				},
				{
					id: "labels",
					label: "Labels for created tickets",
					kind: "text",
					description:
						"Optional comma-separated labels. Add use-leitwerk explicitly to make tickets eligible for code changes after review.",
				},
			],
		},
		resolveDefaults: () => ({
			issueType: "Story",
			labels: "",
			jiraProfile: configured().jira.profiles()[0] ?? "",
			gitlabProfile: configured().gitlab.profiles()[0] ?? "",
			sshProfile: configured().ssh.profiles()[0] ?? "",
		}),
		resolveOptions: () => ({
			jiraProfile: configured()
				.jira.profiles()
				.map((value) => ({ value, label: value })),
			gitlabProfile: configured()
				.gitlab.profiles()
				.map((value) => ({ value, label: value })),
			sshProfile: configured()
				.ssh.profiles()
				.map((value) => ({ value, label: value })),
		}),
		async resolveLaunchConfig(input) {
			try {
				return { ok: true, launchConfig: await launchSplit(configured(), input) };
			} catch (error) {
				return {
					ok: false,
					errors: [
						{
							field: "epic",
							code: "epic_split_invalid",
							message: error instanceof Error ? error.message : "Epic launch unavailable",
						},
					],
				};
			}
		},
	},
};

/** @internal */
export const jiraEpicSplitProcess = createSplitProcess(launcher, {
	source: epicSplitSource,
	async resolve(event) {
		const issue = event.issue as JiraIssue;
		const launch = await launchSplit(configured(), { ...event, epic: issue.id });
		if (
			!launch.params.epic.fields.labels.includes("leitwerk-epic-split") ||
			!(event.jiraProjects as string[]).includes(launch.params.epic.fields.project.id)
		)
			throw new Error("Epic is no longer eligible for splitting");
		return {
			...launch,
			externalId: `epic-split:${jiraIssueExternalId(launch.params.jiraBaseUrl, issue.id)}`,
		};
	},
});

/** @internal */
const extension: LeitwerkExtensionModule = {
	manifest: {
		id: "jira-epic-split",
		version: "0.3.1",
		requires: ["jira", "gitlab", "git-ssh", "jira-gitlab-change"],
	},
	setupCatalog(api) {
		api.registerProcess(jiraEpicSplitProcess);
	},
	setupServer(api) {
		const jira = api.require(jiraIntegration),
			gitlab = api.require(gitlabIntegration),
			ssh = api.require(gitSshIntegration),
			settings = api.require(scopedSettingsCapability),
			wiki = api.require(topicWikiCapability),
			host = api.require(coreHostCapabilities.serverSetup);
		if (
			Array.isArray(jira) ||
			Array.isArray(gitlab) ||
			Array.isArray(ssh) ||
			Array.isArray(settings) ||
			Array.isArray(wiki) ||
			Array.isArray(host)
		)
			throw new Error("Epic integration capabilities must be singular");
		services = { jira, gitlab, ssh, settings, wiki, serverBaseUrl: host.serverBaseUrl };
		registerSplitTools(api, services);
		const due = new Map<string, number>();
		host.polling.create({
			id: "jira-epic-split",
			pollInterval: () => "5s",
			defaultIntervalMs: 5000,
			isEnabled: () => true,
			async pollOnce() {
				const result = emptyPollResult();
				for (const watcher of host.processWatchers?.listBySource(epicSplitSource) ?? []) {
					const key = `${watcher.processId}:${watcher.watcherId}`;
					if (!watcher.enabled || (due.get(key) ?? 0) > Date.now()) continue;
					due.set(key, Date.now() + parseDurationMs(String(watcher.config.pollInterval), 30000));
					try {
						const client = jira.client(String(watcher.config.jiraProfile));
						if (!client.searchEpics) throw new Error("Jira epic discovery unavailable");
						for (const issue of await client.searchEpics(watcher.config.jiraProjects as string[])) {
							const id = `epic-split:${jiraIssueExternalId(client.baseUrl, issue.id)}`;
							const launched = await host.launchRuns.startWatcher(
								watcher,
								{ ...watcher.config, issue },
								{ idempotencyKey: id },
							);
							if (launched.error) result.errors.push(`${issue.key}: epic split admission failed`);
							else if (launched.process) result.created.push(id);
							else result.skipped.push(id);
						}
					} catch (error) {
						result.errors.push(
							error instanceof Error ? error.message : "Epic discovery unavailable",
						);
					}
				}
				return result;
			},
		});
		api.onStop(() => {
			services = null;
		});
	},
};
export default extension;
