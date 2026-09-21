import { LocalForgeStore, type LocalRepositorySeed } from "@leitwerk-dev/test-support/local-git";
import { actionableFeedback, authorizedTrigger } from "./authorization.js";
import type { GitHubClientLike } from "./capability.js";
import type {
	GitHubCheckSummary,
	GitHubFeedbackItem,
	GitHubIssue,
	GitHubLabelEvent,
	GitHubProfile,
	GitHubPullRequest,
	GitHubRelease,
} from "./client.js";
import { assertGitHubRepository } from "./client.js";

export interface LocalGitHubRepository {
	repository: ReturnType<LocalGitHubAdapter["newRepository"]>;
	issues: GitHubIssue[];
	pulls: GitHubPullRequest[];
	comments: Record<string, Array<ReturnType<LocalGitHubAdapter["newComment"]>>>;
	feedback: Record<string, GitHubFeedbackItem[]>;
	checks: Record<string, GitHubCheckSummary>;
	releases: GitHubRelease[];
	assets: Record<string, string>;
	labels: Array<{ id: number; name: string }>;
	labelEvents: Record<string, GitHubLabelEvent[]>;
	reactions: Record<string, Array<{ id: number; content: string; user: { login: string } }>>;
	feedbackEditors: Record<string, string | null>;
}
export interface LocalGitHubState {
	version: 1;
	sequence: number;
	repositories: LocalGitHubRepository[];
	failAfterPullRequestWrite: boolean;
	members: string[];
	failAfterWrite: string | null;
}
export interface LocalGitHubOptions {
	root: string;
	baseUrl: string;
	now?: () => number;
	nextId?: () => number;
	seeds?: LocalRepositorySeed[];
	allowedOrganization?: string;
}

/** Persistent local GitHub with actual commit ancestry and configurable release assets. */
export class LocalGitHubAdapter extends LocalForgeStore<LocalGitHubState, LocalGitHubOptions> {
	constructor(options: LocalGitHubOptions) {
		super(options, "github.json", {
			version: 1,
			sequence: 0,
			repositories: [],
			failAfterPullRequestWrite: false,
			members: [],
			failAfterWrite: null,
		});
		this.state.members ??= [];
		this.state.failAfterWrite ??= null;
		for (const r of this.state.repositories) {
			r.labels ??= [];
			r.labelEvents ??= {};
			r.reactions ??= {};
			r.feedbackEditors ??= {};
		}
		for (const seed of options.seeds ?? []) this.seed(seed);
	}
	repo(owner: string, name: string) {
		const repo = this.state.repositories.find((r) => r.repository.full_name === `${owner}/${name}`);
		if (!repo) throw new Error("Unknown local GitHub repository");
		return repo;
	}
	seed(seed: LocalRepositorySeed) {
		const existing = this.state.repositories.find(
			(r) => r.repository.full_name === `${seed.owner}/${seed.name}`,
		);
		if (existing) return existing;
		const repo: LocalGitHubRepository = {
			repository: this.newRepository(seed),
			issues: [],
			pulls: [],
			comments: {},
			feedback: {},
			checks: {},
			releases: [],
			assets: {},
			labels: [],
			labelEvents: {},
			reactions: {},
			feedbackEditors: {},
		};
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	setChecks(repo: LocalGitHubRepository, summary: GitHubCheckSummary) {
		this.git.head(repo.repository.ssh_url, summary.headSha);
		repo.checks[summary.headSha] = structuredClone(summary);
		this.save();
	}
	publishRelease(
		repo: LocalGitHubRepository,
		input: {
			tag: string;
			ref: string;
			assets: Record<string, string>;
			draft?: boolean;
			prerelease?: boolean;
		},
	) {
		const commit = this.git.head(repo.repository.ssh_url, input.ref);
		this.git.run(repo.repository.ssh_url, ["check-ref-format", `refs/tags/${input.tag}`]);
		this.git.run(repo.repository.ssh_url, ["tag", "--", input.tag, commit]);
		const id = this.id();
		const release: GitHubRelease = {
			id,
			tag_name: input.tag,
			target_commitish: commit,
			draft: input.draft ?? false,
			prerelease: input.prerelease ?? false,
			html_url: `${this.options.baseUrl}/__local`,
			assets: Object.entries(input.assets).map(([name, contents]) => {
				const url = `${this.options.baseUrl}/__local/assets/${this.id()}`;
				repo.assets[url] = contents;
				return { name, url, browser_download_url: url };
			}),
		};
		repo.releases.unshift(release);
		this.save();
		return release;
	}
	override newRepository(seed: LocalRepositorySeed) {
		return { ...super.newRepository(seed), archived: false, has_issues: true };
	}
	setMembership(login: string, member: boolean) {
		this.state.members = this.state.members.filter(
			(value) => value.toLowerCase() !== login.toLowerCase(),
		);
		if (member) this.state.members.push(login);
		this.save();
	}
	failNextResponse(operation: "comment" | "reply" | "reaction" | "issue" | "label") {
		this.state.failAfterWrite = operation;
		this.save();
	}
	private lostResponse(operation: string) {
		if (this.state.failAfterWrite !== operation) return;
		this.state.failAfterWrite = null;
		this.save();
		throw new Error(`Local GitHub: response lost after ${operation} write`);
	}
	createIssue(
		repo: LocalGitHubRepository,
		input: { title: string; body?: string; author?: string },
	) {
		const number = this.id();
		const issue: GitHubIssue = {
			number,
			title: input.title,
			body: input.body ?? "",
			state: "open",
			html_url: `${this.options.baseUrl}/__local#issue-${number}`,
			updated_at: this.timestamp(),
			user: { login: input.author ?? "developer" },
			labels: [],
		};
		repo.issues.push(issue);
		this.save();
		return issue;
	}
	setIssueLabel(
		repo: LocalGitHubRepository,
		number: number,
		name: string,
		actor: string,
		present = true,
	) {
		const issue = repo.issues.find((value) => value.number === number);
		if (!issue) throw new Error("Unknown local GitHub issue");
		issue.labels = issue.labels.filter((label) => label.name !== name);
		if (present) issue.labels.push({ id: this.id(), name });
		const event: GitHubLabelEvent = {
			id: this.id(),
			event: present ? "labeled" : "unlabeled",
			label: { name },
			actor: { login: actor },
		};
		repo.labelEvents[number] ??= [];
		repo.labelEvents[number].push(event);
		issue.updated_at = this.timestamp();
		this.save();
		return event;
	}
	editFeedback(
		repo: LocalGitHubRepository,
		number: number,
		kind: GitHubFeedbackItem["kind"],
		id: number,
		body: string,
		editor: string | null,
	) {
		const item = repo.feedback[number]?.find((value) => value.kind === kind && value.id === id);
		if (!item) throw new Error("Unknown local GitHub feedback");
		item.body = body;
		item.createdAt = this.timestamp();
		repo.feedbackEditors[`${kind}:${id}`] = editor;
		this.save();
	}

	client(): GitHubClientLike {
		const profile: GitHubProfile = {
			apiBaseUrl: this.options.baseUrl,
			token: "",
			botLogin: "leitwerk-bot",
			...(this.options.allowedOrganization
				? { allowedOrganization: this.options.allowedOrganization }
				: {}),
		};
		const repo = (owner: string, name: string) => {
			assertGitHubRepository(profile, owner, name);
			return this.repo(owner, name);
		};
		const client: GitHubClientLike = {
			profile,
			listRepositories: async () =>
				this.state.repositories
					.map((r) => ({ ...r.repository, archived: false, has_issues: true }))
					.filter(
						(r) =>
							!profile.allowedOrganization ||
							r.owner.login.toLowerCase() === profile.allowedOrganization.toLowerCase(),
					),
			listOpenIssues: async (owner, name) =>
				structuredClone(repo(owner, name).issues.filter((i) => i.state === "open")),
			listIssueEvents: async (owner, name, number) =>
				structuredClone(repo(owner, name).labelEvents[number] ?? []),
			isOrganizationMember: async (login) =>
				!profile.allowedOrganization ||
				this.state.members.some((member) => member.toLowerCase() === login.toLowerCase()),
			authorizedTrigger: async (owner, name, number, trigger, done) =>
				authorizedTrigger(client, owner, name, number, trigger, done),
			resolveGitIdentity: async (name) => ({
				provider: "github",
				profile: name,
				login: profile.botLogin,
				name: "Sandbox Developer",
				email: "developer@sandbox.invalid",
			}),
			ensureLabel: async (owner, name, labelName) => {
				const r = repo(owner, name);
				let label = r.labels.find((value) => value.name === labelName);
				if (!label) {
					label = { id: this.id(), name: labelName };
					r.labels.push(label);
					this.save();
					this.lostResponse("label");
				}
				return structuredClone(label);
			},
			updateIssue: async (owner, name, number, patch) => {
				const issue = repo(owner, name).issues.find((i) => i.number === number);
				if (!issue) throw new Error("Unknown local GitHub issue");
				for (const key of ["title", "body", "state"] as const)
					if (typeof patch[key] === "string") issue[key] = patch[key];
				if (Array.isArray(patch.labels))
					issue.labels = patch.labels.map((value) => ({ id: this.id(), name: String(value) }));
				issue.updated_at = this.timestamp();
				this.save();
				this.lostResponse("issue");
				return structuredClone(issue);
			},
			listFeedbackReactions: async (owner, name, kind, id) =>
				structuredClone(repo(owner, name).reactions[`${kind}:${id}`] ?? []),
			addFeedbackReaction: async (owner, name, kind, id) => {
				if (!["conversation", "inline"].includes(kind))
					throw new Error("Reviews do not support reactions");
				const r = repo(owner, name);
				r.reactions[`${kind}:${id}`] ??= [];
				const reactions = r.reactions[`${kind}:${id}`];
				let reaction = reactions.find(
					(r) => r.content === "eyes" && r.user.login === profile.botLogin,
				);
				if (!reaction) {
					reaction = { id: this.id(), content: "eyes", user: { login: profile.botLogin } };
					reactions.push(reaction);
					this.save();
					this.lostResponse("reaction");
				}
				return structuredClone(reaction);
			},
			listFeedbackReplies: async (owner, name, number, kind) =>
				kind === "inline"
					? structuredClone(
							(repo(owner, name).feedback[number] ?? [])
								.filter((f) => f.kind === "inline")
								.map((f) => ({ ...f })),
						)
					: client.listIssueComments(owner, name, number),
			replyFeedback: async (owner, name, number, kind, _id, body) => {
				if (kind !== "inline") return client.addIssueComment(owner, name, number, body);
				const value = this.addFeedback(repo(owner, name), number, {
					kind: "inline",
					body,
					author: profile.botLogin,
				});
				this.lostResponse("reply");
				return structuredClone(value);
			},
			listActionablePullRequestFeedback: async (owner, name, number, signal) =>
				actionableFeedback(
					client,
					await client.listPullRequestFeedback(owner, name, number, signal),
				),
			getIssue: async (owner, name, number) => {
				const issue = repo(owner, name).issues.find((i) => i.number === number);
				if (!issue) throw new Error("Unknown local GitHub issue");
				return structuredClone(issue);
			},
			getCommit: async (owner, name, ref) => ({
				sha: this.git.head(repo(owner, name).repository.ssh_url, ref),
			}),
			isAncestor: async (owner, name, ancestor, descendant) =>
				this.git.isAncestor(repo(owner, name).repository.ssh_url, ancestor, descendant),
			listIssueComments: async (owner, name, number) =>
				structuredClone(repo(owner, name).comments[number] ?? []),
			addIssueComment: async (owner, name, number, body) => {
				const r = repo(owner, name);
				if (!r.pulls.some((p) => p.number === number) && !r.issues.some((i) => i.number === number))
					throw new Error("Unknown local GitHub issue or PR");
				const value = this.newComment(body);
				r.comments[number] ??= [];
				r.comments[number].push(value);
				this.save();
				this.lostResponse("comment");
				return structuredClone(value);
			},
			createPullRequest: async (owner, name, input) => {
				const r = repo(owner, name);
				const pr = this.newPullRequest(r, input);
				r.pulls.push(pr);
				const fail = this.state.failAfterPullRequestWrite;
				this.state.failAfterPullRequestWrite = false;
				this.save();
				if (fail) throw new Error("Local GitHub: response lost after PR creation");
				return this.refresh(r, pr);
			},
			...this.pullRequestClient(repo, "Unknown local GitHub pull request"),
			listPullRequestFeedback: async (owner, name, number) =>
				structuredClone([
					...(repo(owner, name).feedback[number] ?? []).filter((item) => {
						if (!profile.allowedOrganization) return true;
						const editor = repo(owner, name).feedbackEditors[`${item.kind}:${item.id}`];
						return (
							editor === undefined ||
							(editor !== null &&
								this.state.members.some((m) => m.toLowerCase() === editor.toLowerCase()))
						);
					}),
					...(repo(owner, name).comments[number] ?? []).map((c) => ({
						kind: "conversation" as const,
						id: c.id,
						body: c.body,
						author: c.user.login,
						createdAt: c.created_at,
					})),
				]),
			getCiDiagnostics: async (owner, name, number, headSha) => {
				const r = this.repo(owner, name);
				const pr = r.pulls.find((p) => p.number === number);
				if (!pr || this.git.head(r.repository.ssh_url, pr.head.ref) !== headSha)
					throw new Error("Stale CI diagnostics");
				return {
					headSha,
					checks: (r.checks[headSha]?.failed ?? []).map((check, i) => ({
						id: i + 1,
						name: check.name,
						output: { summary: check.name },
						annotations: [],
					})),
					jobs: [],
					truncated: false,
				};
			},
			getCheckSummary: async (owner, name, sha) =>
				structuredClone(
					repo(owner, name).checks[sha] ?? {
						headSha: sha,
						status: "pending",
						total: 0,
						failed: [],
					},
				),
			listReleases: async (owner, name) => structuredClone(repo(owner, name).releases),
			downloadReleaseAsset: async (asset) => {
				for (const r of this.state.repositories)
					if (r.assets[asset.url] !== undefined) return r.assets[asset.url];
				throw new Error("Unknown local GitHub release asset");
			},
		};
		return client;
	}
}
