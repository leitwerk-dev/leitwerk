import { LocalForgeStore, type LocalRepositorySeed } from "@leitwerk-dev/test-support/local-git";
import type { GitHubClientLike } from "./capability.js";
import type {
	GitHubCheckSummary,
	GitHubFeedbackItem,
	GitHubIssue,
	GitHubPullRequest,
	GitHubRelease,
} from "./client.js";

export interface LocalGitHubRepository {
	repository: ReturnType<LocalGitHubAdapter["newRepository"]>;
	issues: GitHubIssue[];
	pulls: GitHubPullRequest[];
	comments: Record<string, Array<ReturnType<LocalGitHubAdapter["newComment"]>>>;
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
export class LocalGitHubAdapter extends LocalForgeStore<LocalGitHubState, LocalGitHubOptions> {
	constructor(options: LocalGitHubOptions) {
		super(options, "github.json", {
			version: 1,
			sequence: 0,
			repositories: [],
			failAfterPullRequestWrite: false,
		});
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
	client(): GitHubClientLike {
		const repo = (owner: string, name: string) => this.repo(owner, name);
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
				const value = this.newComment(body);
				r.comments[number] ??= [];
				r.comments[number].push(value);
				this.save();
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
