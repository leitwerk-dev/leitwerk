import {
	coreHostCapabilities,
	type IntegrationToolExecutionContext,
	repositorySettingsIdentity,
	type ServerExtensionAPI,
	scopedSettingsCapability,
	type TicketCreationConfig,
} from "@leitwerk-dev/process-sdk";
import type { PollResult } from "@leitwerk-dev/watcher-utils";
import { type GitLabIntegration, gitlabIntegration } from "./capability.js";
import { registerGitLabDeliveryTools } from "./delivery-tools.js";
import { createGitLabProvider } from "./external.js";
import { createGitLabMaintenance } from "./maintenance.js";
import { createGitLabRepositoryCatalog } from "./repository-catalog.js";
import { registerGitLabTicketCreation } from "./ticket-creation.js";
import { registerGitLabTools } from "./tools.js";

/** Register shared tools and polling with an explicit integration. @public */
export function setupGitLabIntegration(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	options: {
		/** @public */
		now?: () => number;
		/** @internal */
		ticketCreation?: TicketCreationConfig;
	} = {},
):
	| {
			/** @public */
			poll(): Promise<PollResult>;
			/** @internal */
			maintenance: ReturnType<typeof createGitLabMaintenance>;
	  }
	| undefined {
	const catalog = integration.repositoryCatalog ?? createGitLabRepositoryCatalog(integration);
	api.provide(gitlabIntegration, {
		profiles: () => integration.profiles(),
		client: (profile) => integration.client(profile),
		repositoryCatalog: catalog,
	});
	const settings = api.get(scopedSettingsCapability);
	if (settings && !Array.isArray(settings))
		settings.registerDiscovery("repository", async () => {
			const subjects = [];
			for (const profile of integration.profiles()) {
				const client = integration.client(profile);
				for (const project of await catalog.refresh(profile))
					subjects.push({
						scopeType: "repository",
						identity: repositorySettingsIdentity(client.baseUrl, project.id),
						label: project.path_with_namespace,
						aliases: [
							project.http_url_to_repo,
							...(project.ssh_url_to_repo ? [project.ssh_url_to_repo] : []),
						],
					});
			}
			return subjects;
		});
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	const maintenance = createGitLabMaintenance(api, deps, integration, options.now);
	const assertOwnership = async (ctx: IntegrationToolExecutionContext) => {
		if (maintenance.ownsProcess(ctx.process.processId))
			await maintenance.assertOwnership(ctx.process.id, ctx.project?.key ?? "repo", ctx.signal);
	};
	const guardedWrites = new Set([
		"gitlab_ensure_merge_request",
		"gitlab_comment",
		"gitlab_reply",
		"gitlab_inline_comment",
		"gitlab_resolve_discussion",
		"gitlab_acknowledge_feedback",
	]);
	const guardedApi: ServerExtensionAPI = {
		...api,
		tool(definition) {
			api.tool({
				...definition,
				async execute(ctx, args) {
					const guarded =
						maintenance.ownsProcess(ctx.process.processId) && guardedWrites.has(definition.name);
					if (guarded || definition.name === "gitlab_update_comment") await assertOwnership(ctx);
					const result = await definition.execute(
						guarded
							? {
									...ctx,
									externalWrites: {
										...ctx.externalWrites,
										ensure: (identity, operation) =>
											ctx.externalWrites.ensure(identity, {
												...operation,
												execute: async () => {
													await assertOwnership(ctx);
													return operation.execute();
												},
											}),
									},
								}
							: ctx,
						args,
					);
					if (definition.name === "gitlab_ensure_merge_request") await assertOwnership(ctx);
					return result;
				},
			});
		},
	};
	registerGitLabTools(guardedApi, integration, assertOwnership);
	registerGitLabTicketCreation(
		api,
		integration,
		options.ticketCreation ?? { enabled: false, defaultLabels: [] },
	);
	registerGitLabDeliveryTools(guardedApi, integration, deps.projects);
	api.tool({
		name: "gitlab_assert_maintenance",
		description: "Recheck MR maintenance ownership before Git publication",
		parameters: {
			type: "object",
			properties: { projectKey: { type: "string" } },
			required: ["projectKey"],
		},
		async execute(ctx) {
			await assertOwnership(ctx);
			return { ok: true };
		},
	});
	return { ...createGitLabProvider(deps, integration, options), /** @internal */ maintenance };
}
