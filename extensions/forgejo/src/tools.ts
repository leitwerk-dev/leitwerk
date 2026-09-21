import {
	existingObject,
	type IntegrationToolExecutionContext,
	matchesPatch,
	numberArg,
	objectArg as object,
	type ProcessProjectRepoLike,
	projectParameters,
	type RepositoryProjectBinding,
	type ServerExtensionAPI,
	stringArg,
	type TicketCreationDestinationProvider,
	type TicketCreationDestinationSnapshot,
} from "@leitwerk-dev/process-sdk";
import { resolveForgejoProjectBinding } from "./binding.js";
import type { ForgejoIntegration } from "./capability.js";
import {
	type ForgejoRepository,
	type ForgejoTicketCreationConfig,
	parseLabelNames,
} from "./client.js";

interface ForgejoTicketDestinationData {
	profile: string;
	repositoryId: number;
	owner: string;
	repo: string;
	defaultLabels: string[];
}

function availableRepository(repository: ForgejoRepository): boolean {
	return repository.archived !== true && repository.has_issues !== false;
}

function destinationId(
	data: Pick<ForgejoTicketDestinationData, "profile" | "repositoryId">,
): string {
	return `${encodeURIComponent(data.profile)}.${data.repositoryId}`;
}

function destinationData(
	snapshot: TicketCreationDestinationSnapshot,
): ForgejoTicketDestinationData {
	const data = object(snapshot.data);
	return {
		profile: stringArg(data, "profile"),
		repositoryId: numberArg(data, "repositoryId"),
		owner: stringArg(data, "owner"),
		repo: stringArg(data, "repo"),
		defaultLabels: parseLabelNames(data.defaultLabels, "'defaultLabels'"),
	};
}

function decodeDestinationId(
	value: string,
): Pick<ForgejoTicketDestinationData, "profile" | "repositoryId"> {
	const separator = value.lastIndexOf(".");
	if (separator <= 0) throw new Error("Unknown Forgejo ticket destination");
	try {
		const profile = decodeURIComponent(value.slice(0, separator));
		const repositoryId = Number(value.slice(separator + 1));
		if (!profile || !Number.isInteger(repositoryId) || repositoryId <= 0) {
			throw new Error("invalid");
		}
		return { profile, repositoryId };
	} catch {
		throw new Error("Unknown Forgejo ticket destination");
	}
}

function destinationGroup(profile: string, baseUrl: string): string {
	return `${profile} · ${new URL(baseUrl).hostname}`;
}

function createDestinationProvider(
	integration: ForgejoIntegration,
	ticketCreation: ForgejoTicketCreationConfig,
): TicketCreationDestinationProvider {
	const summary = (profile: string, repository: ForgejoRepository, baseUrl: string) => ({
		id: destinationId({ profile, repositoryId: repository.id }),
		displayName: repository.full_name,
		group: destinationGroup(profile, baseUrl),
		description: ticketCreation.defaultLabels.length
			? `Default labels: ${ticketCreation.defaultLabels.join(", ")}`
			: "No default labels",
	});
	return {
		async list() {
			const results = await Promise.all(
				integration.profiles().map(async (profile) => {
					try {
						const client = integration.client(profile);
						const repositories = (await client.listRepositories()).filter(availableRepository);
						return {
							destinations: repositories.map((repository) =>
								summary(profile, repository, client.profile.baseUrl),
							),
							warnings: [] as string[],
						};
					} catch {
						return {
							destinations: [],
							warnings: [`Forgejo profile '${profile}' is currently unavailable.`],
						};
					}
				}),
			);
			return {
				destinations: results.flatMap((result) => result.destinations),
				warnings: results.flatMap((result) => result.warnings),
			};
		},
		async resolve({ destinationId: encoded }) {
			const decoded = decodeDestinationId(encoded);
			const client = integration.client(decoded.profile);
			const repository = await client.getRepositoryById(decoded.repositoryId);
			if (!availableRepository(repository)) {
				throw new Error("The selected Forgejo repository cannot accept issues");
			}
			const labels = await client.listLabels(repository.owner.login, repository.name);
			const data: ForgejoTicketDestinationData = {
				profile: decoded.profile,
				repositoryId: repository.id,
				owner: repository.owner.login,
				repo: repository.name,
				defaultLabels: [...ticketCreation.defaultLabels],
			};
			return {
				summary: summary(decoded.profile, repository, client.profile.baseUrl),
				data,
				agentContext: `Create the ticket in ${repository.full_name} on ${new URL(client.profile.baseUrl).hostname}. Configured default labels: ${ticketCreation.defaultLabels.join(", ") || "none"}. Existing optional labels: ${
					labels
						.map((label) => label.name)
						.sort()
						.join(", ") || "none"
				}.`,
			};
		},
		async validate(snapshot) {
			const data = destinationData(snapshot);
			const repository = await integration
				.client(data.profile)
				.getRepositoryById(data.repositoryId);
			if (
				!availableRepository(repository) ||
				repository.owner.login !== data.owner ||
				repository.name !== data.repo ||
				repository.full_name !== snapshot.summary.displayName
			) {
				throw new Error("The selected Forgejo repository changed; choose the destination again");
			}
		},
	};
}

const target = resolveForgejoProjectBinding;

export function registerForgejoTools(
	api: ServerExtensionAPI,
	integration: ForgejoIntegration,
	ticketCreation: ForgejoTicketCreationConfig = { defaultLabels: ["created-by-leitwerk"] },
	projects?: ProcessProjectRepoLike,
): void {
	async function ensureLabel(
		ctx: IntegrationToolExecutionContext,
		target: RepositoryProjectBinding,
		name: string,
		writeKey = ctx.idempotencyKey,
	) {
		const client = integration.client(target.profile);
		const find = async () =>
			(await client.listLabels(target.owner, target.repo, ctx.signal)).find(
				(label) => label.name === name,
			) ?? null;
		return await ctx.externalWrites.ensure(
			{ writeType: "forgejo.ensure_label", dedupKey: writeKey },
			{
				reconcile: () => existingObject(find),
				execute: () => client.createLabel(target.owner, target.repo, name, "2da44e", ctx.signal),
				toMetadata: (label) => ({ id: label.id, name: label.name }),
			},
		);
	}

	api.tool<Record<string, unknown>>({
		name: "forgejo_resolve_git_identity",
		description: "Resolve and durably pin the authenticated Forgejo Git identity",
		parameters: projectParameters(),
		async execute(ctx) {
			if (!projects) throw new Error("Process project persistence is unavailable");
			const { profile } = target(ctx);
			const identity = await integration.client(profile).resolveGitIdentity(profile, ctx.signal);
			if (!ctx.project) throw new Error("A process project is required");
			const metadata = object(ctx.project.metadata ?? {});
			const updated = projects.update(ctx.project.id, {
				metadata: { ...metadata, "leitwerk.gitIdentity": identity },
			});
			if (!updated) throw new Error("Process project disappeared while pinning Git identity");
			return identity;
		},
	});
	if (ticketCreation.enabled !== false)
		api.tool<Record<string, unknown>>({
			name: "forgejo_create_issue",
			description: "Create one issue in the operator-selected Forgejo repository",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "Concise issue title" },
					body: { type: "string", description: "Complete Markdown issue description" },
					labels: {
						type: "array",
						items: { type: "string" },
						description: "Optional existing label names from the destination context",
					},
				},
				required: ["title", "body"],
			},
			capability: {
				kind: "ticket_creation",
				processId: "ticket_creation_process",
				startTurnId: "create_ticket",
				displayName: "Forgejo",
				titlePath: "/title",
				descriptionPath: "/body",
				destinations: createDestinationProvider(integration, ticketCreation),
			},
			async execute(ctx, args) {
				if (!ctx.ticketDestination) throw new Error("A Forgejo ticket destination is required");
				const target = destinationData(ctx.ticketDestination);
				const client = integration.client(target.profile);
				const title = stringArg(args, "title");
				const body = stringArg(args, "body");
				const requestedLabels = parseLabelNames(args.labels, "'labels'");
				let labels = await client.listLabels(target.owner, target.repo, ctx.signal);
				for (const name of target.defaultLabels) {
					if (labels.some((label) => label.name === name)) continue;
					await ensureLabel(ctx, target, name, `${ctx.idempotencyKey}:default-label:${name}`);
					labels = await client.listLabels(target.owner, target.repo, ctx.signal);
				}
				const labelsByName = new Map(labels.map((label) => [label.name, label]));
				const unknown = requestedLabels.filter((name) => !labelsByName.has(name));
				if (unknown.length) {
					throw new Error(
						`Unknown Forgejo label${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
					);
				}
				const labelNames = [...new Set([...target.defaultLabels, ...requestedLabels])];
				const labelIds = labelNames.map((name) => {
					const label = labelsByName.get(name);
					if (!label) throw new Error(`Forgejo label '${name}' is unavailable`);
					return label.id;
				});
				const identity = { writeType: "forgejo.create_issue", dedupKey: ctx.idempotencyKey };
				const marker = `<!-- leitwerk-ticket-write:${ctx.idempotencyKey} -->`;
				const markedBody = `${body}\n\n${marker}`;
				const find = async () =>
					(await client.listIssues(target.owner, target.repo, "all", ctx.signal)).find((issue) =>
						issue.body?.includes(marker),
					) ?? null;
				const issue = await ctx.externalWrites.ensure(identity, {
					reconcile: () => existingObject(find),
					execute: () =>
						client.createIssue(
							target.owner,
							target.repo,
							{ title, body: markedBody, labels: labelIds },
							ctx.signal,
						),
					toMetadata: (issue) => ({ number: issue.number, url: issue.html_url }),
				});
				return {
					externalId: `${target.owner}/${target.repo}#${issue.number}`,
					url: issue.html_url,
					result: issue,
				};
			},
		});
	api.tool<Record<string, unknown>>({
		name: "forgejo_ensure_pull_request",
		description: "Create a Forgejo pull request unless the branch pair already has one",
		parameters: projectParameters({
			title: { type: "string" },
			body: { type: "string" },
			head: { type: "string" },
			base: { type: "string" },
		}),
		async execute(ctx, args) {
			const t = target(ctx);
			const client = integration.client(t.profile);
			const head = stringArg(args, "head");
			const base = stringArg(args, "base");
			const find = async () =>
				(await client.listPullRequests(t.owner, t.repo, "all")).find(
					(candidate) => candidate.head.ref === head && candidate.base.ref === base,
				) ?? null;
			return await ctx.externalWrites.ensure(
				{ writeType: "forgejo.ensure_pr", dedupKey: ctx.idempotencyKey },
				{
					reconcile: () => existingObject(find),
					execute: () =>
						client.createPullRequest(t.owner, t.repo, {
							title: stringArg(args, "title"),
							body: stringArg(args, "body"),
							head,
							base,
						}),
					toMetadata: (pr) => ({ number: pr.number, url: pr.html_url }),
				},
			);
		},
	});
	api.tool<Record<string, unknown>>({
		name: "forgejo_ensure_label",
		description: "Create a Forgejo repository label unless it already exists",
		parameters: projectParameters({ name: { type: "string" } }),
		execute: (ctx, args) => ensureLabel(ctx, target(ctx), stringArg(args, "name")),
	});

	for (const [name, description, numberName, method] of [
		[
			"forgejo_get_issue",
			"Read a Forgejo issue in the current process repository",
			"issueNumber",
			"getIssue",
		],
		[
			"forgejo_list_issue_comments",
			"List comments on a Forgejo issue in the current process repository",
			"issueNumber",
			"listIssueComments",
		],
		[
			"forgejo_get_pull_request",
			"Read a Forgejo pull request in the current process repository",
			"pullRequestNumber",
			"getPullRequest",
		],
		[
			"forgejo_list_pull_request_feedback",
			"List conversation, submitted review, and inline feedback on a Forgejo pull request",
			"pullRequestNumber",
			"listPullRequestFeedback",
		],
	] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description,
			parameters: projectParameters({ [numberName]: { type: "integer" } }),
			async execute(ctx, args) {
				const t = target(ctx);
				return integration
					.client(t.profile)
					[method](t.owner, t.repo, numberArg(args, numberName), ctx.signal);
			},
		});
	}
	api.tool<Record<string, unknown>>({
		name: "forgejo_add_pull_request_feedback_reaction",
		description: "Mark a Forgejo pull request conversation or inline comment with eyes",
		parameters: projectParameters({
			pullRequestNumber: { type: "integer" },
			feedbackKind: { type: "string", enum: ["conversation", "inline"] },
			feedbackId: { type: "integer" },
			writeKey: { type: "string" },
		}),
		async execute(ctx, args) {
			const t = target(ctx);
			const kind = stringArg(args, "feedbackKind");
			if (kind !== "conversation" && kind !== "inline") {
				throw new Error("'feedbackKind' must be 'conversation' or 'inline'");
			}
			const feedbackId = numberArg(args, "feedbackId");
			const client = integration.client(t.profile);
			await ctx.externalWrites.ensure(
				{ writeType: "forgejo.feedback_reaction", dedupKey: stringArg(args, "writeKey") },
				{
					reconcile: async () =>
						existingObject(
							async () =>
								(
									await client.listPullRequestFeedbackReactions(
										t.owner,
										t.repo,
										{ kind, id: feedbackId },
										ctx.signal,
									)
								).find(
									(reaction) =>
										reaction.content === "eyes" &&
										reaction.user.login.toLowerCase() === client.profile.botLogin.toLowerCase(),
								) ?? null,
						),
					execute: async () =>
						object(
							await client.addPullRequestFeedbackReaction(
								t.owner,
								t.repo,
								{ kind, id: feedbackId },
								"eyes",
								ctx.signal,
							),
						),
					toMetadata: () => ({
						pullRequestNumber: numberArg(args, "pullRequestNumber"),
						kind,
						feedbackId,
					}),
				},
			);
			return { ok: true };
		},
	});
	api.tool<Record<string, unknown>>({
		name: "forgejo_reply_to_pull_request_feedback",
		description: "Resolve Forgejo pull request feedback and post a threaded reply",
		parameters: projectParameters({
			pullRequestNumber: { type: "integer" },
			feedbackKind: {
				type: "string",
				enum: ["conversation", "review", "inline"],
			},
			feedbackId: { type: "integer" },
			body: { type: "string" },
			writeKey: { type: "string" },
		}),
		async execute(ctx, args) {
			const t = target(ctx);
			const pullRequestNumber = numberArg(args, "pullRequestNumber");
			const feedbackKind = stringArg(args, "feedbackKind");
			const feedbackId = numberArg(args, "feedbackId");
			const client = integration.client(t.profile);
			const feedback = (
				await client.listPullRequestFeedback(t.owner, t.repo, pullRequestNumber, ctx.signal)
			).find((item) => item.kind === feedbackKind && item.id === feedbackId);
			if (!feedback) {
				throw new Error(
					`Forgejo ${feedbackKind} feedback ${feedbackId} is unavailable on pull request #${pullRequestNumber}`,
				);
			}
			const marker = `<!-- leitwerk-write:${ctx.process.id}:${stringArg(args, "writeKey")} -->`;
			await ctx.externalWrites.ensure(
				{ writeType: "forgejo.feedback_reply", dedupKey: stringArg(args, "writeKey") },
				{
					reconcile: async (): Promise<object | null> =>
						existingObject(async () => {
							if (feedback.kind !== "inline" || !feedback.reviewId || !feedback.path)
								return (
									(
										await client.listIssueComments(t.owner, t.repo, pullRequestNumber, ctx.signal)
									).find((comment) => String(comment.body).includes(marker)) ?? null
								);
							return (
								(
									await client.listPullRequestFeedback(
										t.owner,
										t.repo,
										pullRequestNumber,
										ctx.signal,
									)
								).find(
									(item) =>
										item.kind === "inline" &&
										item.reviewId === feedback.reviewId &&
										item.path === feedback.path &&
										(item.position ?? item.line ?? 0) ===
											(feedback.position ?? feedback.line ?? 0) &&
										(item.originalPosition ?? 0) === (feedback.originalPosition ?? 0) &&
										item.body.includes(marker),
								) ?? null
							);
						}),
					execute: async () =>
						object(
							await client.replyToPullRequestFeedback(
								t.owner,
								t.repo,
								pullRequestNumber,
								feedback,
								`${stringArg(args, "body")}\n\n${marker}`,
								ctx.signal,
							),
						),
					toMetadata: () => ({ pullRequestNumber, feedbackKind, feedbackId }),
				},
			);
			return { ok: true };
		},
	});

	for (const [resource, numberName, comment, update] of [
		["issue", "issueNumber", "addIssueComment", "updateIssue"],
		["pull_request", "pullRequestNumber", "addIssueComment", "updatePullRequest"],
	] as const) {
		for (const updating of [false, true]) {
			const payloadName = updating ? "patch" : "body";
			api.tool<Record<string, unknown>>({
				name: `forgejo_${updating ? `update_${resource}` : `add_${resource}_comment`}`,
				description: `${updating ? "Update a" : "Add a comment to a"} Forgejo ${resource.replaceAll("_", " ")}`,
				parameters: projectParameters(
					{
						[numberName]: { type: "integer" },
						[payloadName]: { type: updating ? "object" : "string" },
						writeKey: { type: "string" },
					},
					[numberName, payloadName],
				),
				async execute(ctx, args) {
					const t = target(ctx);
					const number = numberArg(args, numberName);
					const payload = updating ? object(args.patch) : stringArg(args, "body");
					const key =
						typeof args.writeKey === "string" ? stringArg(args, "writeKey") : ctx.idempotencyKey;
					const marker = `<!-- leitwerk-write:${ctx.process.id}:${key} -->`;
					const client = integration.client(t.profile);
					const result = await ctx.externalWrites.ensure(
						{ writeType: updating ? "forgejo.update" : "forgejo.comment", dedupKey: key },
						{
							reconcile: async (phase): Promise<object | null> =>
								existingObject(async () => {
									if (typeof payload === "string")
										return (
											(await client.listIssueComments(t.owner, t.repo, number, ctx.signal)).find(
												(comment) => String(comment.body).includes(marker),
											) ?? null
										);
									const current = await client[
										resource === "issue" ? "getIssue" : "getPullRequest"
									](t.owner, t.repo, number, ctx.signal);
									return current && (phase === "already_recorded" || matchesPatch(current, payload))
										? current
										: null;
								}),
							execute: async () =>
								object(
									await (typeof payload === "string"
										? client[comment](
												t.owner,
												t.repo,
												number,
												`${payload}\n\n${marker}`,
												ctx.signal,
											)
										: client[update](t.owner, t.repo, number, payload, ctx.signal)),
								),
							toMetadata: () => ({ owner: t.owner, repo: t.repo, number }),
						},
					);
					return updating ? { ok: true } : result;
				},
			});
		}
	}
}
