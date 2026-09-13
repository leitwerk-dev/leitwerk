import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import coding from "@leitwerk-dev/coding";
import { type SandboxCompositionFactory, withSandboxLaunchers } from "@leitwerk-dev/dev-sandbox";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import localRepoChange, { localRepoChangeProcess } from "@leitwerk-dev/local-repo-change";
import models from "@leitwerk-dev/models";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import ticketCreation from "@leitwerk-dev/ticket-creation";
import { LocalTicketAdapter } from "@leitwerk-dev/ticket-creation/testing";
import { Notebook, type NotebookSeed } from "./notebook.js";
import { notebookScenarios, notebookScripts } from "./scenarios.js";

const scriptedModel: LeitwerkExtensionModule = {
	manifest: { id: "sandbox-model", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "sandbox-model",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("sandbox-model"),
				server: builtinPiProvider("sandbox-model"),
				models: () => [{ modelId: "scripted", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};
export function createNotebookComposition(seed?: NotebookSeed): SandboxCompositionFactory {
	return (input) => {
		const notebook = new Notebook(input.paths.directory, seed);
		const tickets = new LocalTicketAdapter({
			file: path.join(input.paths.directory, "tickets.json"),
			baseUrl: input.urls.backend,
			destinations: [
				{ id: "garden", displayName: "Garden notebook" },
				{ id: "workshop", displayName: "Workshop notebook" },
			],
		});
		const scenarios = notebookScenarios(notebook);
		return {
			processConfigs: Object.fromEntries(
				["local_repo_change_process", "ticket_creation_process"].map((id) => [
					id,
					{ default_model_profile: input.modelProfileId, turn_configs: {} },
				]),
			),
			development: {
				extensions: [
					"@leitwerk-dev/coding",
					"@leitwerk-dev/local-repo-change",
					"@leitwerk-dev/ticket-creation",
					"@leitwerk-dev/models",
				].map((name) => fileURLToPath(new URL("../", import.meta.resolve(name)))),
				watchPaths: [fileURLToPath(new URL(".", import.meta.url))],
			},
			scenarios,
			initialize: () => notebook.initialize(),
			createCatalog: () =>
				buildExtensionCatalogFromModules([
					coding,
					input.mode === "real" ? models : scriptedModel,
					{
						...localRepoChange,
						setupCatalog(api) {
							api.registerProcess(withSandboxLaunchers(localRepoChangeProcess, scenarios));
						},
					},
					ticketCreation,
					tickets.extension(),
				]),
			scriptedPi: (context) => notebookScripts(notebook, context),
			controlState: () => ({
				tickets: tickets.state.tickets,
				lostResponseEnabled: tickets.state.failAfterPersistence,
				progress: notebook.state.scenarios,
			}),
			registerControls({ app }) {
				app.get("/__local", async (_request, reply) =>
					reply
						.type("text/html")
						.send(readFileSync(new URL("./control.html", import.meta.url), "utf8")),
				);
				app.get<{ Params: { id: string } }>("/__local/tickets/:id", async (request, reply) => {
					const ticket = tickets.state.tickets.find((t) => t.id === request.params.id);
					return ticket
						? reply.type("text/plain").send(`${ticket.title}\n\n${ticket.body}`)
						: reply.code(404).send({ error: "Unknown local ticket" });
				});
				app.post<{ Body: { enabled?: boolean } }>(
					"/__local/lost-response",
					async (request, reply) => {
						if (typeof request.body?.enabled !== "boolean")
							return reply.code(400).send({ error: "enabled must be a boolean" });
						tickets.injectLostResponse(request.body.enabled);
						return { enabled: tickets.state.failAfterPersistence };
					},
				);
			},
		};
	};
}
export default createNotebookComposition();
