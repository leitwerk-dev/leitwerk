import { fileURLToPath } from "node:url";
import { type SandboxCompositionFactory, withSandboxLaunchers } from "@leitwerk-dev/dev-sandbox";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { createForgejoRepoChange } from "@leitwerk-dev/forgejo-repo-change";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { setupGitHubIntegration } from "@leitwerk-dev/github";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { createPollingTestExtension } from "@leitwerk-dev/test-support";
import {
	type LocalRepositorySeed,
	readLocalJson,
	writeLocalJson,
} from "@leitwerk-dev/test-support/local-git";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import { setupWoodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";
import { createNotebookComposition } from "./composition.js";
import { forgejoScenarios, forgejoScripts, localGitSsh } from "./forgejo-workflows.js";
import { providerControls } from "./provider-controls.js";
import { notebookScriptResolver } from "./scenarios.js";

const defaultSeeds: LocalRepositorySeed[] = [
	{
		owner: "examples",
		name: "garden",
		files: {
			"README.md": "# Garden notebook\n",
			"notes.txt": "Record planting dates.\n",
			"check.txt": "fail\n",
			"check.mjs":
				"import { readFileSync } from 'node:fs';\nif (readFileSync(new URL('./check.txt', import.meta.url), 'utf8').trim() !== 'pass') throw new Error('check.txt must contain pass');\n",
		},
	},
];

/** Public-only composition for real local PR delivery, providers and tickets. */
export function createProviderComposition(seeds = defaultSeeds): SandboxCompositionFactory {
	if (!seeds.length) throw new Error("At least one workflow seed is required");
	return (input) => {
		const clock = readLocalJson(input.paths.directory, "providers-clock.json", {
			version: 1,
			now: Date.now(),
		});
		const pollingOptions = { now: () => clock.now };
		const options = { root: input.paths.directory, baseUrl: input.urls.backend, ...pollingOptions };
		const forgejo = new LocalForgejoAdapter(options);
		const github = new LocalGitHubAdapter(options);
		const woodpecker = new LocalWoodpeckerAdapter(options);
		const notebook = createNotebookComposition(
			undefined,
			(notebook, context) =>
				new StubPiTreeHandleFactory({
					recordSessionTrace: true,
					toolCallScriptResolver: forgejoScripts(
						forgejo,
						context,
						notebookScriptResolver(notebook, context),
					),
				}),
		)(input);
		const workflow = createForgejoRepoChange({ docker: false });
		const scenarios = forgejoScenarios(forgejo, `${seeds[0].owner}/${seeds[0].name}`);
		const productionLaunchers = workflow.process.launchers;
		const localLaunchers = withSandboxLaunchers(workflow.process, scenarios).launchers;
		workflow.process.launchers = (api) => {
			productionLaunchers?.(api);
			localLaunchers?.(api);
		};
		workflow.process.repositoryCredentials = () => [];
		const controls = providerControls(forgejo, woodpecker, poll);
		const client =
			<T>(value: T) =>
			(profile: string): T => {
				if (profile !== "local") throw new Error("Unknown local provider profile");
				return value;
			};
		const providers = [
			createPollingTestExtension({ id: "forgejo", version: "0.1.9" }, (api) =>
				setupForgejoIntegration(
					api,
					{ profiles: () => ["local"], client: client(forgejo.client()) },
					undefined,
					pollingOptions,
				),
			),
			createPollingTestExtension({ id: "github", version: "0.1.9" }, (api) =>
				setupGitHubIntegration(api, { client: client(github.client()) }, pollingOptions),
			),
			createPollingTestExtension({ id: "woodpecker", version: "0.1.9" }, (api) =>
				setupWoodpeckerIntegration(api, { client: client(woodpecker.client()) }, pollingOptions),
			),
		];
		async function poll() {
			clock.now = Math.max(clock.now, Date.now()) + 60_000;
			writeLocalJson(input.paths.directory, "providers-clock.json", clock);
			const results = [];
			for (const provider of providers) results.push(await provider.poll());
			return results;
		}
		const modules: LeitwerkExtensionModule[] = [
			{
				manifest: { id: "git-ssh", version: "0.1.9" },
				setupServer(api) {
					api.provide(gitSshIntegration, localGitSsh(forgejo));
				},
			},
			workflow.extension,
			...providers,
		];
		return {
			...notebook,
			scenarios: [...notebook.scenarios, ...scenarios],
			processConfigs: {
				...notebook.processConfigs,
				forgejo_repo_change_process: {
					default_model_profile: input.modelProfileId,
					turn_configs: {},
					watchers: {
						use_leitwerk: {
							enabled: true,
							profile: "local",
							poll_interval: "30s",
							repositories: { include: seeds.map((s) => `${s.owner}/${s.name}`) },
							labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
						},
					},
				},
			},
			development: {
				...notebook.development,
				extensions: [
					...notebook.development.extensions,
					...[
						"@leitwerk-dev/forgejo",
						"@leitwerk-dev/github",
						"@leitwerk-dev/woodpecker",
						"@leitwerk-dev/git-ssh",
						"@leitwerk-dev/forgejo-repo-change",
					].map((name) => fileURLToPath(new URL("../", import.meta.resolve(name)))),
				],
			},
			async initialize() {
				await notebook.initialize?.();
				for (const seed of seeds) {
					forgejo.seed({ ...seed, labels: ["use-leitwerk", "leitwerk-done"] });
					woodpecker.seed(`${seed.owner}/${seed.name}`);
				}
				github.seed({ owner: "examples", name: "workshop" });
				woodpecker.seed("examples/workshop");
			},
			async createCatalog() {
				const catalog = await notebook.createCatalog();
				return buildExtensionCatalogFromModules([
					...catalog.modules.map((m) => m.module),
					...modules,
				]);
			},
			controlState: () => ({
				...notebook.controlState?.(),
				providers: { forgejo: forgejo.state, github: github.state, woodpecker: woodpecker.state },
				providerTime: clock.now,
			}),
			poll,
			async registerControls(context) {
				await notebook.registerControls?.(context);
				controls.register(context);
				context.app.get<{ Params: { repository: string; number: string } }>(
					"/__local/receipts/:repository/:number",
					async (request, reply) => {
						const repo = forgejo.state.repositories.find(
							(r) => r.repository.id === Number(request.params.repository),
						);
						const issue = repo?.issues.find((i) => i.number === Number(request.params.number));
						return issue
							? reply.type("text/plain").send(`${issue.title}\n\n${issue.body}`)
							: reply.code(404).send();
					},
				);
			},
		};
	};
}
export default createProviderComposition();
