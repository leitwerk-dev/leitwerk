import {
	LocalGit,
	type LocalRepositorySeed,
	readLocalJson,
	writeLocalJson,
} from "@leitwerk-dev/test-support/local-git";
import type { GitHubClientLike } from "./capability.js";
import type {
	GitHubCheckSummary,
	GitHubFeedbackItem,
	GitHubIssue,
	GitHubPullRequest,
	GitHubRelease,
} from "./client.js";

export interface LocalGitHubRepository {
	repository: {
		id: number;
		owner: { login: string };
		name: string;
		full_name: string;
		ssh_url: string;
		html_url: string;
		default_branch: string;
	};
	issues: GitHubIssue[];
	pulls: GitHubPullRequest[];
	comments: Record<
		string,
		Array<{ id: number; body: string; user: { login: string }; created_at: string }>
	>;
	feedback: Record<string, GitHubFeedbackItem[]>;
	checks: Record<string, GitHubCheckSummary>;
	releases: GitHubRelease[];
	assets: Record<string, string>;
}
export interface LocalGitHubState {
	version: 1;
	sequence: number;
	repositories: LocalGitHubRepository[];
	failAfterPullRequestWrite: boolean;
}
export interface LocalGitHubOptions {
	root: string;
	baseUrl: string;
	now?: () => number;
	nextId?: () => number;
	seeds?: LocalRepositorySeed[];
}

/** Persistent local GitHub with actual commit ancestry and configurable release assets. */
export class LocalGitHubAdapter {
	readonly git: LocalGit;
	state: LocalGitHubState;
	constructor(readonly options: LocalGitHubOptions) {
		this.git = new LocalGit(options.root);
		this.state = readLocalJson(options.root, "github.json", {
			version: 1,
			sequence: 0,
			repositories: [],
			failAfterPullRequestWrite: false,
		});
		for (const seed of options.seeds ?? []) this.seed(seed);
	}
	save() {
		writeLocalJson(this.options.root, "github.json", this.state);
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
		if (!repo) throw new Error("Unknown local GitHub repository");
		return repo;
	}
	seed(seed: LocalRepositorySeed) {
		const existing = this.state.repositories.find(
			(r) => r.repository.full_name === `${seed.owner}/${seed.name}`,
		);
		if (existing) return existing;
		const { bare, branch } = this.git.seed(seed);
		const repo: LocalGitHubRepository = {
			repository: {
				id: this.id(),
				owner: { login: seed.owner },
				name: seed.name,
				full_name: `${seed.owner}/${seed.name}`,
				ssh_url: bare,
				html_url: `${this.options.baseUrl}/__local`,
				default_branch: branch,
			},
			issues: [],
			pulls: [],
			comments: {},
			feedback: {},
			checks: {},
			releases: [],
			assets: {},
		};
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	refresh(repo: LocalGitHubRepository, pr: GitHubPullRequest) {
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
	merge(repo: LocalGitHubRepository, number: number) {
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
		repo: LocalGitHubRepository,
		number: number,
		input: Omit<GitHubFeedbackItem, "id" | "createdAt">,
	) {
		if (!repo.pulls.some((p) => p.number === number)) throw new Error("Unknown PR");
		const value = { ...input, id: this.id(), createdAt: this.timestamp() };
		repo.feedback[number] ??= [];
		repo.feedback[number].push(value);
		this.save();
		return value;
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
	client(): GitHubClientLike {
		const repo = (owner: string, name: string) => this.repo(owner, name);
		const pull = (owner: string, name: string, number: number) => {
			const value = repo(owner, name).pulls.find((p) => p.number === number);
			if (!value) throw new Error("Unknown local GitHub pull request");
			return value;
		};
		return {
			profile: { apiBaseUrl: this.options.baseUrl, token: "", botLogin: "leitwerk-bot" },
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
				const value = {
					id: this.id(),
					body,
					user: { login: "leitwerk-bot" },
					created_at: this.timestamp(),
				};
				r.comments[number] ??= [];
				r.comments[number].push(value);
				this.save();
				return structuredClone(value);
			},
			createPullRequest: async (owner, name, input) => {
				const r = repo(owner, name);
				const number = this.id();
				const pr: GitHubPullRequest = {
					number,
					title: input.title,
					body: input.body,
					state: "open",
					merged: false,
					merge_commit_sha: null,
					html_url: `${this.options.baseUrl}/__local#pr-${number}`,
					head: { ref: input.head, sha: this.git.head(r.repository.ssh_url, input.head) },
					base: { ref: input.base, sha: this.git.head(r.repository.ssh_url, input.base) },
				};
				r.pulls.push(pr);
				const fail = this.state.failAfterPullRequestWrite;
				this.state.failAfterPullRequestWrite = false;
				this.save();
				if (fail) throw new Error("Local GitHub: response lost after PR creation");
				return this.refresh(r, pr);
			},
			getPullRequest: async (owner, name, number) =>
				this.refresh(repo(owner, name), pull(owner, name, number)),
			listPullRequests: async (owner, name, state = "open") =>
				repo(owner, name)
					.pulls.filter((p) => state === "all" || p.state === state)
					.map((p) => this.refresh(repo(owner, name), p)),
			updatePullRequest: async (owner, name, number, patch) => {
				const value = pull(owner, name, number);
				for (const key of ["title", "body", "state"] as const)
					if (typeof patch[key] === "string") value[key] = patch[key];
				this.save();
				return this.refresh(repo(owner, name), value);
			},
			listPullRequestFeedback: async (owner, name, number) =>
				structuredClone([
					...(repo(owner, name).feedback[number] ?? []),
					...(repo(owner, name).comments[number] ?? []).map((c) => ({
						kind: "conversation" as const,
						id: c.id,
						body: c.body,
						author: c.user.login,
						createdAt: c.created_at,
					})),
				]),
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
	}
}
