import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import coding from "@leitwerk-dev/coding";
import {
	type SandboxCompositionFactory,
	scriptedSandboxModel,
	withSandboxLaunchers,
} from "@leitwerk-dev/dev-sandbox";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import models from "@leitwerk-dev/models";
import ticketCreation from "@leitwerk-dev/ticket-creation";
import { LocalTicketAdapter } from "@leitwerk-dev/ticket-creation/testing";
import { Notebook, type NotebookSeed } from "./notebook.js";
import {
	sandboxRepositoryChangeProcess,
	sandboxRepositoryChangeProcessId,
} from "./repository-change-process.js";
import { notebookScenarios, notebookScripts } from "./scenarios.js";

export function createNotebookComposition(
	seed?: NotebookSeed,
	scripts = notebookScripts,
): SandboxCompositionFactory {
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
				[sandboxRepositoryChangeProcessId, "ticket_creation_process"].map((id) => [
					id,
					{ default_model_profile: input.modelProfileId, turn_configs: {} },
				]),
			),
			development: {
				extensions: [
					"@leitwerk-dev/coding",
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
					input.mode === "real" ? models : scriptedSandboxModel,
					{
						manifest: { id: "sandbox-repository-change", version: "1.0.0" },
						setupCatalog(api) {
							api.registerProcess(
								withSandboxLaunchers(sandboxRepositoryChangeProcess, scenarios, {
									ownLaunchers: "replace",
								}),
							);
						},
					},
					ticketCreation,
					tickets.extension(),
				]),
			scriptedPi: (context) => scripts(notebook, context),
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
