import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxCompositionFactory } from "@leitwerk-dev/dev-sandbox";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { setupGitHubIntegration } from "@leitwerk-dev/github";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import jiraExtension, { setupJiraIntegration } from "@leitwerk-dev/jira";
import { LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { createNotebookComposition } from "./composition.js";

const composition: SandboxCompositionFactory = (input) => {
	const notebook = createNotebookComposition()(input);
	const options = { root: input.paths.directory, baseUrl: input.urls.backend };
	const forgejo = new LocalForgejoAdapter(options);
	const github = new LocalGitHubAdapter(options);
	const gitlab = new LocalGitLabAdapter(input.paths.directory, input.urls.backend);
	const jira = new LocalJiraAdapter(input.paths.directory, input.urls.backend);
	const ticketCreation = { enabled: true, defaultLabels: ["created-by-leitwerk"] };
	return {
		...notebook,
		development: {
			...notebook.development,
			extensions: [
				...notebook.development.extensions,
				...["forgejo", "github", "gitlab", "jira"].map((name) =>
					fileURLToPath(new URL("../", import.meta.resolve(`@leitwerk-dev/${name}`))),
				),
			],
		},
		async initialize() {
			await notebook.initialize?.();
			forgejo.seed({ owner: "examples", name: "garden" });
			github.seed({ owner: "examples", name: "garden" });
			if (!gitlab.state.projects.length)
				gitlab.addProject(
					"examples/garden",
					path.join(input.paths.directory, "repositories/notebook.git"),
				);
			jira.seed({
				id: "100",
				key: "GARDEN",
				name: "Garden notebook",
				issuetypes: [
					{
						id: "10",
						name: "Task",
						subtask: false,
						fields: {
							summary: { name: "Summary", required: true },
							description: { name: "Description", required: false },
							labels: { name: "Labels", required: false },
						},
					},
				],
			});
		},
		async createCatalog() {
			const catalog = await notebook.createCatalog();
			return buildExtensionCatalogFromModules([
				...catalog.modules
					.filter((entry) => entry.module.manifest.id !== "local-tickets")
					.map((entry) => entry.module),
				{
					manifest: { id: "forgejo", version: "1" },
					setupServer: (api) => {
						setupForgejoIntegration(
							api,
							{ profiles: () => ["local"], client: () => forgejo.client() },
							ticketCreation,
						);
					},
				},
				{
					manifest: { id: "github", version: "1" },
					setupServer: (api) => {
						setupGitHubIntegration(
							api,
							{ profiles: () => ["local"], client: () => github.client() },
							{ ticketCreation },
						);
					},
				},
				{
					manifest: { id: "gitlab", version: "1" },
					setupServer: (api) => {
						setupGitLabIntegration(
							api,
							{ profiles: () => ["local"], client: () => gitlab.client() },
							{ ticketCreation },
						);
					},
				},
				{
					...jiraExtension,
					setupServer: (api) => {
						setupJiraIntegration(
							api,
							{ profiles: () => ["local"], client: () => jira.client() },
							{ ticketCreation },
						);
					},
				},
			]);
		},
		controlState: () => ({
			...notebook.controlState?.(),
			providers: {
				forgejo: forgejo.state,
				github: github.state,
				gitlab: gitlab.state,
				jira: jira.state,
			},
		}),
		async registerControls(context) {
			await notebook.registerControls?.(context);
			for (const [route, adapter] of [
				["/__local/receipts/:repository/:number", forgejo],
				["/__local/github/receipts/:repository/:number", github],
			] as const) {
				context.app.get<{ Params: { repository: string; number: string } }>(
					route,
					async (request, reply) => {
						const repository = adapter.state.repositories.find(
							(candidate) => candidate.repository.id === Number(request.params.repository),
						);
						const issue = repository?.issues.find(
							(candidate) => candidate.number === Number(request.params.number),
						);
						return issue
							? reply.type("text/plain").send(`${issue.title}\n\n${issue.body}`)
							: reply.code(404).send();
					},
				);
			}
			context.app.get<{ Params: { key: string } }>("/browse/:key", async (request, reply) => {
				const issue = jira.state.issues.find((issue) => issue.key === request.params.key);
				return issue
					? reply
							.type("text/plain")
							.send(`${issue.key}: ${issue.fields.summary}\n\n${issue.fields.description}`)
					: reply.code(404).send();
			});
			context.app.get<{ Params: { iid: string } }>(
				"/examples/garden/-/issues/:iid",
				async (request, reply) => {
					const issue = gitlab.state.issues?.find(
						(issue) => issue.iid === Number(request.params.iid),
					);
					return issue
						? reply.type("text/plain").send(`${issue.title}\n\n${issue.description}`)
						: reply.code(404).send();
				},
			);
		},
	};
};

export default composition;
