import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
} from "@leitwerk-dev/external-writes";
import {
	numberArg,
	type ProcessProjectRepoLike,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
	type TicketCreationDestinationProvider,
	type TicketCreationDestinationSnapshot,
} from "@leitwerk-dev/process-sdk";
import { resolveForgejoProjectBinding } from "./binding.js";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoRepository, ForgejoTicketCreationConfig } from "./client.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Tool arguments must be an object");
	return value as Record<string, unknown>;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
	const value = args[name];
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string" || entry.trim() === "")
	) {
		throw new Error(`'${name}' must be an array of non-empty strings`);
	}
	return [...new Set(value.map((entry) => entry.trim()))];
}

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
		defaultLabels: stringArrayArg(data, "defaultLabels"),
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
	externalWrites: ExternalWriteLogRepoLike,
	ticketCreation: ForgejoTicketCreationConfig = { defaultLabels: ["created-by-leitwerk"] },
	projects?: ProcessProjectRepoLike,
): void {
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
				const requestedLabels = stringArrayArg(args, "labels");
				let labels = await client.listLabels(target.owner, target.repo, ctx.signal);
				for (const name of target.defaultLabels) {
					if (labels.some((label) => label.name === name)) continue;
					try {
						await ensureWrite(
							externalWrites,
							ctx.process.id,
							createWriteIdentity(
								"forgejo.ensure_label",
								`${ctx.idempotencyKey}:default-label:${name}`,
							),
							async () => {
								const created = await client.createLabel(
									target.owner,
									target.repo,
									name,
									"2da44e",
									ctx.signal,
								);
								return { id: created.id, name: created.name };
							},
						);
					} catch (error) {
						labels = await client.listLabels(target.owner, target.repo, ctx.signal);
						if (!labels.some((label) => label.name === name)) throw error;
					}
					labels = await client.listLabels(target.owner, target.repo, ctx.signal);
					if (!labels.some((label) => label.name === name)) {
						throw new Error(`Forgejo default label '${name}' could not be reconciled`);
					}
				}
				const unknown = requestedLabels.filter(
					(name) => !labels.some((label) => label.name === name),
				);
				if (unknown.length) {
					throw new Error(
						`Unknown Forgejo label${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
					);
				}
				const labelNames = [...new Set([...target.defaultLabels, ...requestedLabels])];
				const labelIds = labelNames.map((name) => {
					const label = labels.find((candidate) => candidate.name === name);
					if (!label) throw new Error(`Forgejo label '${name}' is unavailable`);
					return label.id;
				});
				const identity = createWriteIdentity("forgejo.create_issue", ctx.idempotencyKey);
				const marker = `<!-- leitwerk-ticket-write:${ctx.idempotencyKey} -->`;
				const markedBody = `${body}\n\n${marker}`;
				const find = async () =>
					(await client.listIssues(target.owner, target.repo, "all", ctx.signal)).find((issue) =>
						issue.body?.includes(marker),
					) ?? null;
				let issue = await find();
				if (!issue) {
					try {
						await ensureWrite(externalWrites, ctx.process.id, identity, async () => {
							issue = await client.createIssue(
								target.owner,
								target.repo,
								{ title, body: markedBody, labels: labelIds },
								ctx.signal,
							);
							return { number: issue.number, url: issue.html_url };
						});
					} catch (error) {
						issue = await find();
						if (!issue) throw error;
					}
					issue ??= await find();
				}
				if (!issue) throw new Error("Forgejo issue creation could not be reconciled");
				// A lost response can be reconciled by the provider marker before a write
				// record exists. Record the confirmed receipt without issuing another POST.
				recordWriteIfMissing(externalWrites, ctx.process.id, identity, {
					number: issue.number,
					url: issue.html_url,
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
			const existing = await find();
			if (existing) return existing;
			let created = null;
			await ensureWrite(
				externalWrites,
				ctx.process.id,
				createWriteIdentity("forgejo.ensure_pr", ctx.idempotencyKey),
				async () => {
					created = await client.createPullRequest(t.owner, t.repo, {
						title: stringArg(args, "title"),
						body: stringArg(args, "body"),
						head,
						base,
					});
					return { number: created.number, url: created.html_url };
				},
			);
			return created ?? (await find());
		},
	});
	api.tool<Record<string, unknown>>({
		name: "forgejo_ensure_label",
		description: "Create a Forgejo repository label unless it already exists",
		parameters: projectParameters({ name: { type: "string" } }),
		async execute(ctx, args) {
			const t = target(ctx);
			const client = integration.client(t.profile);
			const name = stringArg(args, "name");
			const existing = (await client.listLabels(t.owner, t.repo)).find(
				(label) => label.name === name,
			);
			if (existing) return existing;
			let created = null;
			await ensureWrite(
				externalWrites,
				ctx.process.id,
				createWriteIdentity("forgejo.ensure_label", ctx.idempotencyKey),
				async () => {
					created = await client.createLabel(t.owner, t.repo, name);
					return { id: created.id, name: created.name };
				},
			);
			return (
				created ?? (await client.listLabels(t.owner, t.repo)).find((label) => label.name === name)
			);
		},
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
			await ensureWrite(
				externalWrites,
				ctx.process.id,
				createWriteIdentity("forgejo.feedback_reaction", stringArg(args, "writeKey")),
				async () => {
					await integration
						.client(t.profile)
						.addPullRequestFeedbackReaction(
							t.owner,
							t.repo,
							{ kind, id: feedbackId },
							"eyes",
							ctx.signal,
						);
					return {
						pullRequestNumber: numberArg(args, "pullRequestNumber"),
						kind,
						feedbackId,
					};
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
			await ensureWrite(
				externalWrites,
				ctx.process.id,
				createWriteIdentity("forgejo.feedback_reply", stringArg(args, "writeKey")),
				async () => {
					await client.replyToPullRequestFeedback(
						t.owner,
						t.repo,
						pullRequestNumber,
						feedback,
						stringArg(args, "body"),
						ctx.signal,
					);
					return { pullRequestNumber, feedbackKind, feedbackId };
				},
			);
			return { ok: true };
		},
	});

	for (const definition of [
		{ name: "forgejo_add_issue_comment", numberName: "issueNumber", method: "addIssueComment" },
		{
			name: "forgejo_add_pull_request_comment",
			numberName: "pullRequestNumber",
			method: "addPullRequestComment",
		},
	] as const) {
		api.tool<Record<string, unknown>>({
			name: definition.name,
			description: `Add a comment to a Forgejo ${definition.numberName === "pullRequestNumber" ? "pull request" : "issue"}`,
			parameters: projectParameters(
				{
					[definition.numberName]: { type: "integer" },
					body: { type: "string" },
					writeKey: { type: "string" },
				},
				[definition.numberName, "body"],
			),
			async execute(ctx, args) {
				const t = target(ctx);
				const number = numberArg(args, definition.numberName);
				const body = stringArg(args, "body");
				return ensureWrite(
					externalWrites,
					ctx.process.id,
					createWriteIdentity(
						"forgejo.comment",
						typeof args.writeKey === "string" ? stringArg(args, "writeKey") : ctx.idempotencyKey,
					),
					async () => {
						await integration
							.client(t.profile)
							[definition.method](t.owner, t.repo, number, body, ctx.signal);
						return { owner: t.owner, repo: t.repo, number };
					},
				);
			},
		});
	}

	for (const definition of [
		{ name: "forgejo_update_issue", numberName: "issueNumber", method: "updateIssue" },
		{
			name: "forgejo_update_pull_request",
			numberName: "pullRequestNumber",
			method: "updatePullRequest",
		},
	] as const) {
		api.tool<Record<string, unknown>>({
			name: definition.name,
			description: `Update a Forgejo ${definition.numberName === "pullRequestNumber" ? "pull request" : "issue"}`,
			parameters: projectParameters(
				{
					[definition.numberName]: { type: "integer" },
					patch: { type: "object" },
					writeKey: { type: "string" },
				},
				[definition.numberName, "patch"],
			),
			async execute(ctx, args) {
				const t = target(ctx);
				const number = numberArg(args, definition.numberName);
				const patch = object(args.patch);
				await ensureWrite(
					externalWrites,
					ctx.process.id,
					createWriteIdentity(
						"forgejo.update",
						typeof args.writeKey === "string" ? stringArg(args, "writeKey") : ctx.idempotencyKey,
					),
					async () => {
						await integration
							.client(t.profile)
							[definition.method](t.owner, t.repo, number, patch, ctx.signal);
						return { owner: t.owner, repo: t.repo, number };
					},
				);
				return { ok: true };
			},
		});
	}
}
