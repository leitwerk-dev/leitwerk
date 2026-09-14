import {
	LocalGit,
	type LocalRepositorySeed,
	readLocalJson,
	writeLocalJson,
} from "@leitwerk-dev/test-support/local-git";
import type { ForgejoClientLike } from "./capability.js";
import type {
	ForgejoFeedbackItem,
	ForgejoIssue,
	ForgejoLabel,
	ForgejoPullRequest,
	ForgejoRepository,
} from "./client.js";

export interface LocalForgejoRepository {
	repository: ForgejoRepository;
	issues: ForgejoIssue[];
	pulls: ForgejoPullRequest[];
	comments: Record<
		string,
		Array<{ id: number; body: string; user: { login: string }; created_at: string }>
	>;
	feedback: Record<string, ForgejoFeedbackItem[]>;
	labels: ForgejoLabel[];
}
export interface LocalForgejoState {
	version: 1;
	sequence: number;
	repositories: LocalForgejoRepository[];
	failAfterIssueWrite: boolean;
}
export interface LocalForgejoOptions {
	root: string;
	baseUrl: string;
	now?: () => number;
	nextId?: () => number;
	seeds?: Array<LocalRepositorySeed & { labels?: string[] }>;
}
/** Persistent local Forgejo. Register its client through setupForgejoIntegration. */
export class LocalForgejoAdapter {
	readonly git: LocalGit;
	readonly baseUrl: string;
	state: LocalForgejoState;
	constructor(readonly options: LocalForgejoOptions) {
		this.git = new LocalGit(options.root);
		this.baseUrl = options.baseUrl;
		this.state = readLocalJson(options.root, "forgejo.json", {
			version: 1,
			sequence: 0,
			repositories: [],
			failAfterIssueWrite: false,
		});
		for (const seed of options.seeds ?? []) this.seed(seed);
	}
	save() {
		writeLocalJson(this.options.root, "forgejo.json", this.state);
	}
	id() {
		this.state.sequence = Math.max(this.state.sequence + 1, this.options.nextId?.() ?? 0);
		return this.state.sequence;
	}
	timestamp() {
		return new Date(this.options.now?.() ?? Date.now()).toISOString();
	}
	repo(owner: string, name: string) {
		const repo = this.state.repositories.find((r) => r.repository.full_name === `${owner}/${name}`);
		if (!repo) throw new Error("Unknown local Forgejo repository");
		return repo;
	}
	seed(seed: LocalRepositorySeed & { labels?: string[] }) {
		const existing = this.state.repositories.find(
			(r) => r.repository.full_name === `${seed.owner}/${seed.name}`,
		);
		if (existing) return existing;
		const { bare, branch } = this.git.seed(seed);
		const repo: LocalForgejoRepository = {
			repository: {
				id: this.id(),
				owner: { login: seed.owner },
				name: seed.name,
				full_name: `${seed.owner}/${seed.name}`,
				ssh_url: bare,
				html_url: `${this.baseUrl}/__local`,
				default_branch: branch,
				has_issues: true,
			},
			issues: [],
			pulls: [],
			comments: {},
			feedback: {},
			labels: (seed.labels ?? []).map((name) => ({ id: this.id(), name })),
		};
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	head(repo: LocalForgejoRepository, ref: string) {
		return this.git.head(repo.repository.ssh_url, ref);
	}
	refresh(repo: LocalForgejoRepository, pr: ForgejoPullRequest) {
		if (pr.state === "open") {
			const { headSha, baseSha, ...mergeability } = this.git.mergeability(
				repo.repository.ssh_url,
				pr.head.ref,
				pr.base.ref,
			);
			pr.head.sha = headSha;
			pr.base.sha = baseSha;
			Object.assign(pr, mergeability);
		}
		return structuredClone(pr);
	}
	merge(repo: LocalForgejoRepository, number: number) {
		const pr = repo.pulls.find((p) => p.number === number);
		if (!pr || pr.state !== "open") throw new Error("Pull request is not open");
		this.refresh(repo, pr);
		pr.merge_commit_sha = this.git.merge(repo.repository.ssh_url, pr.head.ref, pr.base.ref);
		pr.merged = true;
		pr.state = "closed";
		this.save();
		return structuredClone(pr);
	}
	addFeedback(
		repo: LocalForgejoRepository,
		number: number,
		input: Omit<ForgejoFeedbackItem, "id" | "createdAt">,
	) {
		if (!repo.pulls.some((p) => p.number === number)) throw new Error("Unknown PR");
		const value = { ...input, id: this.id(), createdAt: this.timestamp() };
		repo.feedback[number] ??= [];
		repo.feedback[number].push(value);
		this.save();
		return value;
	}
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
	const pull = (owner: string, name: string, number: number) => {
		const value = repo(owner, name).pulls.find((i) => i.number === number);
		if (!value) throw new Error("Unknown local pull request");
		return value;
	};
	const comment = async (owner: string, name: string, number: number, body: string) => {
		const value = {
			id: store.id(),
			body,
			user: { login: "leitwerk-bot" },
			created_at: store.timestamp(),
		};
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
			const number = store.id();
			const value = {
				number,
				title: input.title,
				body: input.body,
				state: "open",
				merged: false,
				merge_commit_sha: null,
				html_url: `${store.baseUrl}/__local#pr-${number}`,
				head: { ref: input.head, sha: store.head(r, input.head) },
				base: { ref: input.base, sha: store.head(r, input.base) },
			};
			r.pulls.push(value);
			store.save();
			return structuredClone(value);
		},
		async getPullRequest(owner, name, number) {
			return store.refresh(repo(owner, name), pull(owner, name, number));
		},
		async listPullRequests(owner, name, state = "open") {
			const r = repo(owner, name);
			return r.pulls
				.filter((p) => state === "all" || p.state === state)
				.map((p) => store.refresh(r, p));
		},
		async updatePullRequest(owner, name, number, patch) {
			const value = pull(owner, name, number);
			for (const key of ["title", "body", "state"] as const)
				if (typeof patch[key] === "string") value[key] = patch[key];
			store.save();
			return store.refresh(repo(owner, name), value);
		},
		addPullRequestComment: comment,
		async addPullRequestFeedbackReaction() {
			return {};
		},
		async replyToPullRequestFeedback(owner, name, number, _feedback, body) {
			return comment(owner, name, number, body);
		},
		async listPullRequestFeedback(owner, name, number) {
			return structuredClone(repo(owner, name).feedback[number] ?? []);
		},
	};
}
