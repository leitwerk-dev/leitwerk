import {
	listTicketDestinations,
	markdownTicketCreationDefinition,
	numberArg,
	objectArg,
	parseTicketDestinationId,
	type ServerExtensionAPI,
	stringArg,
	type TicketCreationConfig,
	type TicketCreationDestinationProvider,
	type TicketCreationDestinationSnapshot,
	ticketDestinationId,
	ticketLabelNames,
} from "@leitwerk-dev/process-sdk";
import type { GitHubIntegration } from "./capability.js";
import { assertGitHubRepository, type GitHubRepository } from "./client.js";

function destinationData(snapshot: TicketCreationDestinationSnapshot) {
	const data = objectArg(snapshot.data);
	return {
		profile: stringArg(data, "profile"),
		baseUrl: stringArg(data, "baseUrl"),
		repositoryId: numberArg(data, "repositoryId"),
		owner: stringArg(data, "owner"),
		repo: stringArg(data, "repo"),
		defaultLabels: ticketLabelNames(data.defaultLabels),
	};
}

function available(repository: GitHubRepository): boolean {
	return !!repository.id && !repository.archived && repository.has_issues;
}

/** @internal */
export function registerGitHubTicketCreation(
	api: ServerExtensionAPI,
	integration: GitHubIntegration,
	config: TicketCreationConfig,
): void {
	if (!config.enabled) return;
	const summary = (profile: string, repository: GitHubRepository) => ({
		id: ticketDestinationId(profile, repository.id ?? 0),
		displayName: repository.full_name,
		group: `${profile} · ${new URL(integration.client(profile).profile.apiBaseUrl).hostname}`,
		description: config.defaultLabels.length
			? `Default labels: ${config.defaultLabels.join(", ")}`
			: "No default labels",
	});
	const validateDestination = async (
		snapshot: TicketCreationDestinationSnapshot,
		signal?: AbortSignal,
	) => {
		const data = destinationData(snapshot);
		const client = integration.client(data.profile);
		if (client.profile.apiBaseUrl !== data.baseUrl)
			throw new Error("GitHub profile installation changed");
		assertGitHubRepository(client.profile, data.owner, data.repo);
		const repository = await client.getRepositoryById(data.repositoryId, signal);
		if (
			!available(repository) ||
			repository.owner.login !== data.owner ||
			repository.name !== data.repo
		)
			throw new Error("The selected GitHub repository changed; choose the destination again");
	};
	const destinations: TicketCreationDestinationProvider = {
		list() {
			return listTicketDestinations("GitHub", integration.profiles?.() ?? [], async (profile) =>
				(await integration.client(profile).listRepositories())
					.filter(available)
					.map((repository) => summary(profile, repository)),
			);
		},
		async resolve({ destinationId }) {
			const { profile, resourceId } = parseTicketDestinationId(destinationId);
			const client = integration.client(profile);
			const repository = await client.getRepositoryById(Number(resourceId));
			if (!available(repository))
				throw new Error("The selected GitHub repository cannot accept issues");
			const labels = await client.listLabels(repository.owner.login, repository.name);
			return {
				summary: summary(profile, repository),
				data: {
					profile,
					baseUrl: client.profile.apiBaseUrl,
					repositoryId: repository.id,
					owner: repository.owner.login,
					repo: repository.name,
					defaultLabels: config.defaultLabels,
				},
				agentContext: `Create an issue in ${repository.full_name}. Existing optional labels: ${labels.map((label) => label.name).join(", ") || "none"}.`,
			};
		},
		validate: validateDestination,
	};
	api.tool<Record<string, unknown>>({
		name: "github_create_issue",
		description: "Create one issue in the selected GitHub repository",
		...markdownTicketCreationDefinition("GitHub", destinations),
		async execute(ctx, args) {
			if (!ctx.ticketDestination) throw new Error("A GitHub ticket destination is required");
			ctx.signal.throwIfAborted();
			await validateDestination(ctx.ticketDestination, ctx.signal);
			ctx.signal.throwIfAborted();
			const target = destinationData(ctx.ticketDestination);
			const client = integration.client(target.profile);
			const title = stringArg(args, "title");
			const body = stringArg(args, "body");
			const requestedLabels = ticketLabelNames(args.labels);
			const labels = await client.listLabels(target.owner, target.repo, ctx.signal);
			const unknown = requestedLabels.filter(
				(name) =>
					!target.defaultLabels.includes(name) && !labels.some((label) => label.name === name),
			);
			if (unknown.length) throw new Error(`Unknown GitHub labels: ${unknown.join(", ")}`);
			for (const name of target.defaultLabels) {
				ctx.signal.throwIfAborted();
				await ctx.externalWrites.ensure(
					{ writeType: "github.ensure_label", dedupKey: `${ctx.idempotencyKey}:label:${name}` },
					{
						reconcile: async () =>
							(await client.listLabels(target.owner, target.repo, ctx.signal)).find(
								(label) => label.name === name,
							) ?? null,
						execute: () => {
							ctx.signal.throwIfAborted();
							return client.createLabel(target.owner, target.repo, name, ctx.signal);
						},
						toMetadata: (label) => ({ id: label.id, name: label.name }),
					},
				);
			}
			const marker = `<!-- leitwerk-ticket-write:${ctx.idempotencyKey} -->`;
			const issue = await ctx.externalWrites.ensure(
				{ writeType: "github.create_issue", dedupKey: ctx.idempotencyKey },
				{
					reconcile: async () =>
						(await client.listIssues(target.owner, target.repo, ctx.signal)).find((issue) =>
							issue.body?.includes(marker),
						) ?? null,
					execute: () => {
						ctx.signal.throwIfAborted();
						return client.createIssue(
							target.owner,
							target.repo,
							{
								title,
								body: `${body}\n\n${marker}`,
								labels: [...new Set([...target.defaultLabels, ...requestedLabels])],
							},
							ctx.signal,
						);
					},
					toMetadata: (issue) => ({ number: issue.number, url: issue.html_url }),
				},
			);
			return {
				externalId: `${target.owner}/${target.repo}#${issue.number}`,
				url: issue.html_url,
				result: issue,
			};
		},
	});
}
