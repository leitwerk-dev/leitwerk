import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import coding from "@leitwerk-dev/coding";
import type { SandboxCompositionFactory } from "@leitwerk-dev/dev-sandbox";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import { createGitLabRepoChange } from "@leitwerk-dev/gitlab-repo-change";
import jira, { jiraSubjectIdentity, setupJiraIntegration } from "@leitwerk-dev/jira";
import { createJiraGitLabChange } from "@leitwerk-dev/jira-gitlab-change";
import { createPollingTestExtension, fixtureModelProviders } from "@leitwerk-dev/test-support";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { jiraGitLabScripts } from "./jira-gitlab-scripts.js";
import { type JiraScene, JiraSceneStore, jiraComponents } from "./jira-gitlab-store.js";

const composition: SandboxCompositionFactory = (input) => {
	if (input.mode !== "scripted") throw new Error("Jira/GitLab review scenes require scripted mode");
	const git = new LocalGit(input.paths.directory);
	const gitlab = new LocalGitLabAdapter(input.paths.directory, input.urls.backend);
	const store = new JiraSceneStore(input.paths.directory, "https://jira.sandbox.test/context");
	const now = () => store.state.now;
	const direct = createGitLabRepoChange({ docker: false });
	const coordinated = createJiraGitLabChange({ docker: false });
	// Local file transport is confined to these seeds; no SSH material enters workers.
	direct.process.repositoryCredentials = () => [];
	coordinated.process.repositoryCredentials = () => [];
	const client =
		<T>(value: T) =>
		(profile: string): T => {
			if (profile !== "sandbox") throw new Error("Unknown local provider profile");
			return value;
		};
	const providers = [
		{
			...createPollingTestExtension(jira.manifest, (api) =>
				setupJiraIntegration(
					api,
					{ profiles: () => ["sandbox"], client: client(store.client()) },
					{ now },
				),
			),
			scopedSettings: jira.scopedSettings,
		},
		createPollingTestExtension({ id: "gitlab", version: "0.3.0" }, (api) => {
			return setupGitLabIntegration(
				api,
				{ profiles: () => ["sandbox"], client: client(gitlab.client()) },
				{ now },
			);
		}),
	];
	async function poll() {
		store.state.now = Math.max(store.state.now, Date.now()) + 60_000;
		store.save();
		const results = [];
		for (const provider of providers) results.push(await provider.poll());
		return results;
	}
	return {
		processConfigs: {
			gitlab_repo_change_process: { default_model_profile: input.modelProfileId, turn_configs: {} },
			jira_gitlab_change_process: {
				default_model_profile: input.modelProfileId,
				turn_configs: {},
				watchers: { use_leitwerk: { enabled: true, profile: "sandbox", projects: ["100"] } },
			},
		},
		development: {
			extensions: [
				"coding",
				"gitlab",
				"gitlab-repo-change",
				"jira",
				"jira-gitlab-change",
				"git-ssh",
			].map((name) => fileURLToPath(new URL("../", import.meta.resolve(`@leitwerk-dev/${name}`)))),
			watchPaths: [fileURLToPath(new URL(".", import.meta.url))],
		},
		scenarios: [],
		initialize() {
			for (const name of ["delivery-api", "checkout-web", "design-system"]) {
				if (
					gitlab.state.projects.some((project) => project.path_with_namespace === `atlas/${name}`)
				)
					continue;
				const repo = git.seed({
					owner: "atlas",
					name,
					files: {
						"README.md": `# Atlas ${name}\n\nDelivery experience for Atlas customers.\n`,
						"delivery-notes.md": "# Delivery contract\n\nDocument the delivery window.\n",
					},
				});
				gitlab.addProject(`atlas/${name}`, repo.bare);
			}
		},
		createCatalog: () =>
			buildExtensionCatalogFromModules([
				coding,
				{
					manifest: { id: "sandbox-model", version: "1.0.0" },
					modelProviders: fixtureModelProviders({
						id: "sandbox-model",
						modelId: "scripted",
						server: true,
					}),
				},
				{
					manifest: { id: "git-ssh", version: "0.3.0" },
					setupServer(api) {
						api.provide(gitSshIntegration, {
							profiles: () => ["sandbox"],
							async preflight(request) {
								const project = gitlab.state.projects.find(
									(project) => project.ssh_url_to_repo === request.repoLocator,
								);
								if (!project || request.credentialRef !== "sandbox")
									return {
										ok: false,
										access: "read",
										detail: "Repository is outside this sandbox",
									};
								git.head(request.repoLocator, request.baseBranch);
								if (request.requireWrite)
									git.run(request.repoLocator, [
										"push",
										"--dry-run",
										request.repoLocator,
										`${request.baseBranch}:refs/heads/sandbox-preflight`,
									]);
								return { ok: true };
							},
						});
					},
				},
				...providers,
				direct.extension,
				coordinated.extension,
			]),
		scriptedPi: (context) => jiraGitLabScripts(git, context, gitlab.state.projects),
		controlState: () => ({ jira: store.state, gitlab: gitlab.state }),
		poll,
		async registerControls(context) {
			const settings = context.deps.scopedSettingsService;
			if (!settings) throw new Error("Scoped settings are required");
			await settings.refresh();
			if (!store.state.mappingsSeeded) {
				for (const [index, component] of jiraComponents.entries()) {
					const subject = settings
						.listScopes()
						.subjects.find(
							(subject) =>
								subject.scopeType === "jira.component" &&
								subject.identity === jiraSubjectIdentity(store.baseUrl, component.id),
						);
					if (!subject) throw new Error("Missing Jira component scope");
					const field = (await settings.preview(subject.id)).fields.find(
						(field) => field.key === coordinated.launcher.mapping.key,
					);
					if (field?.override) continue;
					settings.write({
						subjectId: subject.id,
						key: coordinated.launcher.mapping.key,
						value: (index === 2 ? [1, 2] : [index + 1]).map((projectId) =>
							JSON.stringify({
								origin: gitlab.baseUrl,
								projectId,
								gitlabProfile: "sandbox",
								sshProfile: "sandbox",
							}),
						),
						mode: "replace",
						reset: false,
						expectedRevision: 0,
						actor: SYSTEM_ACTOR,
					});
				}
				store.state.mappingsSeeded = true;
				store.save();
			}
			context.app.get("/__local", async (_request, reply) =>
				reply
					.type("text/html")
					.send(readFileSync(new URL("./jira-gitlab-control.html", import.meta.url), "utf8")),
			);
			context.app.post<{ Body: { scene: JiraScene; requestId: string } }>(
				"/__local/jira/issues",
				async (request, reply) => {
					const { scene, requestId } = request.body ?? {};
					if (
						!["plan", "delivery", "bypasses"].includes(scene) ||
						typeof requestId !== "string" ||
						!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)
					)
						return reply.code(400).send({ error: "Choose a scene and supply a request ID" });
					const issue = store.create(scene, requestId);
					return { issue, polling: await poll() };
				},
			);
			context.app.get<{ Params: { key: string } }>("/jira/browse/:key", async (request, reply) => {
				const issue = store.issue(request.params.key);
				return reply
					.type("text/plain")
					.send(
						`${issue.key}: ${issue.fields.summary}\n\n${issue.fields.description}\n\nStatus: ${issue.fields.status.name ?? issue.fields.status.statusCategory.key}\nLabels: ${issue.fields.labels.join(", ")}\n\nLinks:\n${(store.state.remoteLinks[issue.id] ?? []).map((link) => `${link.object.title}: ${link.object.url}`).join("\n")}\n\n${(store.state.comments[issue.id] ?? []).map((comment) => comment.body).join("\n\n")}`,
					);
			});
			context.app.get<{ Params: { repo: string; iid: string } }>(
				"/atlas/:repo/-/merge_requests/:iid",
				async (request, reply) => {
					const project = gitlab.state.projects.find(
						(project) => project.path_with_namespace === `atlas/${request.params.repo}`,
					);
					const mr = gitlab.state.mrs.find(
						(mr) => mr.project_id === project?.id && mr.iid === Number(request.params.iid),
					);
					if (!project || !mr)
						return reply.code(404).send({ error: "Unknown local merge request" });
					const diff = git.run(project.http_url_to_repo, [
						"diff",
						`${mr.target_branch}...${mr.source_branch}`,
					]);
					return reply
						.type("text/plain")
						.send(
							`${project.path_with_namespace} !${mr.iid}: ${mr.title}\n${mr.state}\n\n${mr.description}\n\n${diff}`,
						);
				},
			);
		},
	};
};
export default composition;
