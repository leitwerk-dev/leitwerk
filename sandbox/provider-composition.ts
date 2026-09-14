import { fileURLToPath } from "node:url";
import type { SandboxCompositionFactory } from "@leitwerk-dev/dev-sandbox";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { setupGitHubIntegration } from "@leitwerk-dev/github";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";
import { setupWoodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";
import notebookComposition from "./composition.js";

/** Public-only integration composition; PR delivery processes are supplied separately. */
const composition: SandboxCompositionFactory = (input) => {
	const notebook = notebookComposition(input);
	const options = { root: input.paths.directory, baseUrl: input.urls.backend };
	const forgejo = new LocalForgejoAdapter(options);
	const github = new LocalGitHubAdapter(options);
	const woodpecker = new LocalWoodpeckerAdapter(options);
	const clock = readLocalJson(input.paths.directory, "providers-clock.json", {
		version: 1,
		now: Date.now(),
	});
	const pollingOptions = { now: () => clock.now };
	const polls: Array<() => Promise<unknown>> = [];
	const remember = (provider: { poll(): Promise<unknown> } | undefined) => {
		if (!provider) throw new Error("Local providers require server setup");
		polls.push(() => provider.poll());
	};
	const client =
		<T>(value: T) =>
		(profile: string): T => {
			if (profile !== "local") throw new Error("Unknown local provider profile");
			return value;
		};
	const modules: LeitwerkExtensionModule[] = [
		{
			manifest: { id: "forgejo", version: "0.1.9" },
			setupServer: (api) => {
				remember(
					setupForgejoIntegration(
						api,
						{
							profiles: () => ["local"],
							client: client(forgejo.client()),
						},
						undefined,
						pollingOptions,
					),
				);
			},
		},
		{
			manifest: { id: "github", version: "0.1.9" },
			setupServer: (api) => {
				remember(setupGitHubIntegration(api, { client: client(github.client()) }, pollingOptions));
			},
		},
		{
			manifest: { id: "woodpecker", version: "0.1.9" },
			setupServer: (api) => {
				remember(
					setupWoodpeckerIntegration(api, { client: client(woodpecker.client()) }, pollingOptions),
				);
			},
		},
	];
	return {
		...notebook,
		development: {
			...notebook.development,
			extensions: [
				...notebook.development.extensions,
				...["@leitwerk-dev/forgejo", "@leitwerk-dev/github", "@leitwerk-dev/woodpecker"].map(
					(name) => fileURLToPath(new URL("../", import.meta.resolve(name))),
				),
			],
		},
		async initialize() {
			await notebook.initialize?.();
			forgejo.seed({ owner: "examples", name: "garden" });
			github.seed({ owner: "examples", name: "workshop" });
			woodpecker.seed("examples/garden");
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
		}),
		async poll() {
			clock.now = Math.max(clock.now, Date.now()) + 60_000;
			writeLocalJson(input.paths.directory, "providers-clock.json", clock);
			const results = [];
			for (const poll of polls) results.push(await poll());
			return results;
		},
		async registerControls(context) {
			await notebook.registerControls?.(context);
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
			context.app.post<{ Body: { enabled: boolean } }>(
				"/__local/providers/lost-ticket-response",
				async (request, reply) => {
					if (typeof request.body?.enabled !== "boolean") return reply.code(400).send();
					forgejo.state.failAfterIssueWrite = request.body.enabled;
					forgejo.save();
					return { enabled: forgejo.state.failAfterIssueWrite };
				},
			);
		},
	};
};
export default composition;
