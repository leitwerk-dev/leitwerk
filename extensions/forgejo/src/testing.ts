import { LocalForgeStore, type LocalRepositorySeed } from "@leitwerk-dev/test-support/local-git";
import type { ForgejoClientLike } from "./capability.js";
import type {
	ForgejoFeedbackItem,
	ForgejoIssue,
	ForgejoLabel,
	ForgejoPullRequest,
	ForgejoRepository,
} from "./client.js";

/** @public */
export interface LocalForgejoRepository {
	/** @public */
	repository: ForgejoRepository;
	/** @public */
	issues: ForgejoIssue[];
	/** @public */
	pulls: ForgejoPullRequest[];
	/** @public */
	comments: Record<string, Array<ReturnType<LocalForgejoAdapter["newComment"]>>>;
	/** @public */
	feedback: Record<string, ForgejoFeedbackItem[]>;
	/** @public */
	labels: ForgejoLabel[];
	/** @internal */
	reactions?: Array<{
		/** @internal */
		id: number;
		/** @internal */
		feedbackId: number;
		/** @internal */
		kind: string;
		/** @internal */
		content: string;
	}>;
	/** @internal */
	replies?: Array<{
		/** @internal */
		id: number;
		/** @internal */
		prNumber: number;
		/** @internal */
		feedbackId: number;
		/** @internal */
		kind: string;
	}>;
}
/** @public */
export interface LocalForgejoState {
	/** @public */
	version: 1;
	/** @public */
	sequence: number;
	/** @public */
	repositories: LocalForgejoRepository[];
	/** @public */
	failAfterIssueWrite: boolean;
	/** @internal */
	failAfterPullWrite?: boolean;
}
/** @public */
export interface LocalForgejoOptions {
	/** @public */
	root: string;
	/** @public */
	baseUrl: string;
	/** @public */
	now?: () => number;
	/** @public */
	nextId?: () => number;
	/** @internal */
	seeds?: Array<
		LocalRepositorySeed & {
			/** @internal */
			labels?: string[];
		}
	>;
}
/** Persistent local Forgejo. Register its client through setupForgejoIntegration. @public */
export class LocalForgejoAdapter extends LocalForgeStore<LocalForgejoState, LocalForgejoOptions> {
	/** @internal */
	readonly baseUrl: string;
	/** @public */
	constructor(options: LocalForgejoOptions) {
		super(options, "forgejo.json", {
			version: 1,
			sequence: 0,
			repositories: [],
			failAfterIssueWrite: false,
		});
		this.baseUrl = options.baseUrl;
		for (const repo of this.state.repositories) {
			repo.reactions ??= [];
			repo.replies ??= [];
		}
		this.state.failAfterPullWrite ??= false;
		for (const seed of options.seeds ?? []) this.seed(seed);
	}
	/** @internal */
	repo(owner: string, name: string) {
		const repo = this.state.repositories.find((r) => r.repository.full_name === `${owner}/${name}`);
		if (!repo) throw new Error("Unknown local Forgejo repository");
		return repo;
	}
	/** @public */
	seed(
		seed: LocalRepositorySeed & {
			/** @public */
			labels?: string[];
		},
	) {
		const existing = this.state.repositories.find(
			(r) => r.repository.full_name === `${seed.owner}/${seed.name}`,
		);
		if (existing) return existing;
		const repo: LocalForgejoRepository = {
			repository: { ...this.newRepository(seed), has_issues: true },
			issues: [],
			pulls: [],
			comments: {},
			feedback: {},
			reactions: [],
			replies: [],
			labels: (seed.labels ?? []).map((name) => ({ id: this.id(), name })),
		};
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	/** @internal */
	head(repo: LocalForgejoRepository, ref: string) {
		return this.git.head(repo.repository.ssh_url, ref);
	}
	/** @public */
	client(): ForgejoClientLike {
		return forgejoClient(this);
	}
}
function forgejoClient(store: LocalForgejoAdapter): ForgejoClientLike {
	const repo = (owner: string, name: string) => store.repo(owner, name);
	const issue = (owner: string, name: string, number: number) => {
		const value = repo(owner, name).issues.find((i) => i.number === number);
		if (!value) throw new Error("Unknown local issue");
		return value;
	};
	const comment = async (owner: string, name: string, number: number, body: string) => {
		const value = store.newComment(body);
		repo(owner, name).comments[number] ??= [];
		repo(owner, name).comments[number].push(value);
		store.save();
		return value;
	};
	return {
		profile: { baseUrl: store.baseUrl, token: "", botLogin: "leitwerk-bot" },
		async getAuthenticatedUser() {
			return { login: "leitwerk-bot", full_name: "Sandbox Developer" };
		},
		async resolveGitIdentity(profile) {
			return {
				name: "Sandbox Developer",
				email: "developer@sandbox.invalid",
				provider: "forgejo",
				profile,
				login: "leitwerk-bot",
			};
		},
		async listRepositories() {
			return structuredClone(store.state.repositories.map((r) => r.repository));
		},
		async getRepositoryById(id) {
			const value = store.state.repositories.find((r) => r.repository.id === id);
			if (!value) throw new Error("Unknown local repository");
			return structuredClone(value.repository);
		},
		async listIssues(owner, name, state = "all") {
			return structuredClone(
				repo(owner, name).issues.filter((i) => state === "all" || i.state === state),
			);
		},
		async listOpenIssues(owner, name) {
			return structuredClone(repo(owner, name).issues.filter((i) => i.state === "open"));
		},
		async getIssue(owner, name, number) {
			return structuredClone(issue(owner, name, number));
		},
		async listIssueComments(owner, name, number) {
			return structuredClone(repo(owner, name).comments[number] ?? []);
		},
		async updateIssue(owner, name, number, patch) {
			const value = issue(owner, name, number);
			for (const key of ["title", "body", "state"] as const)
				if (typeof patch[key] === "string") value[key] = patch[key];
			if (Array.isArray(patch.labels))
				value.labels = repo(owner, name).labels.filter(
					(l) =>
						(patch.labels as unknown[]).includes(l.id) ||
						(patch.labels as unknown[]).includes(l.name),
				);
			value.updated_at = store.timestamp();
			store.save();
			return structuredClone(value);
		},
		async listLabels(owner, name) {
			return structuredClone(repo(owner, name).labels);
		},
		async createLabel(owner, name, label, color) {
			const labels = repo(owner, name).labels;
			const value = labels.find((l) => l.name === label) ?? { id: store.id(), name: label, color };
			if (!labels.includes(value)) labels.push(value);
			store.save();
			return structuredClone(value);
		},
		async createIssue(owner, name, input) {
			const r = repo(owner, name);
			const number = store.id();
			const value = {
				number,
				title: input.title,
				body: input.body,
				state: "open",
				html_url: `${store.baseUrl}/__local/receipts/${r.repository.id}/${number}`,
				updated_at: store.timestamp(),
				user: { login: "leitwerk-bot" },
				labels: r.labels.filter((l) => input.labels?.includes(l.id)),
			};
			r.issues.push(value);
			const fail = store.state.failAfterIssueWrite;
			store.state.failAfterIssueWrite = false;
			store.save();
			if (fail) throw new Error("Sandbox: response lost after issue creation");
			return structuredClone(value);
		},
		addIssueComment: comment,
		async createPullRequest(owner, name, input) {
			const r = repo(owner, name);
			const value = store.newPullRequest(r, input);
			r.pulls.push(value);
			const fail = store.state.failAfterPullWrite;
			store.state.failAfterPullWrite = false;
			store.save();
			if (fail) throw new Error("Sandbox: response lost after pull request creation");
			return structuredClone(value);
		},
		...store.pullRequestClient(repo),
		addPullRequestComment: comment,
		async addPullRequestFeedbackReaction(owner, name, feedback, content) {
			const r = repo(owner, name);
			if (
				!Object.values(r.feedback)
					.flat()
					.some((f) => f.id === feedback.id && f.kind === feedback.kind)
			)
				throw new Error("Unknown feedback");
			r.reactions ??= [];
			const existing = r.reactions.find(
				(r) => r.feedbackId === feedback.id && r.kind === feedback.kind && r.content === content,
			);
			if (existing) return structuredClone(existing);
			const reaction = { id: store.id(), feedbackId: feedback.id, kind: feedback.kind, content };
			r.reactions.push(reaction);
			store.save();
			return structuredClone(reaction);
		},
		async replyToPullRequestFeedback(owner, name, number, feedback, body) {
			const r = repo(owner, name);
			const result = await comment(owner, name, number, body);
			r.replies ??= [];
			r.replies.push({
				id: result.id,
				prNumber: number,
				feedbackId: feedback.id,
				kind: feedback.kind,
			});
			store.save();
			return result;
		},
		async listPullRequestFeedback(owner, name, number) {
			return structuredClone(repo(owner, name).feedback[number] ?? []);
		},
	};
}
