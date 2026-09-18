import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { RepositoryFeedbackItem, RepositoryPullRequest } from "@leitwerk-dev/process-sdk";
import { traceTestSubprocess } from "./test-diagnostics.js";

export { createTestDiagnostics } from "./test-diagnostics.js";

/** @public */
export interface LocalRepositorySeed {
	/** @public */
	owner: string;
	/** @public */
	name: string;
	/** @internal */
	defaultBranch?: string;
	/** @public */
	files?: Record<string, string>;
	/** Retain a pre-existing sandbox checkout layout. */
	/** @internal */
	directoryName?: string;
	/** @internal */
	commitMessage?: string;
	/** @internal */
	signoff?: boolean;
}

/** Reject escaping paths and symlinks, including a not-yet-created file's parents. */
/** @public */
export function localPath(root: string, relative: string): string {
	if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
		throw new Error("Local provider storage must not contain symlinks");
	const base = realpathSync(root);
	const target = path.resolve(base, relative);
	if (!target.startsWith(`${base}${path.sep}`))
		throw new Error("Path escapes local provider storage");
	let current = base;
	for (const part of path.relative(base, target).split(path.sep)) {
		current = path.join(current, part);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("Local provider storage must not contain symlinks");
	}
	return target;
}

/** @public */
export function readLocalJson<
	T extends {
		/** @internal */
		version: number;
	},
>(root: string, file: string, initial: T): T {
	const target = localPath(root, file);
	if (!existsSync(target)) return structuredClone(initial);
	const value = JSON.parse(readFileSync(target, "utf8")) as T;
	if (!value || value.version !== initial.version)
		throw new Error(`Unsupported local state version in ${file}`);
	return value;
}

/** @public */
export function writeLocalJson(root: string, file: string, value: unknown): void {
	const target = localPath(root, file);
	const temporary = localPath(root, `${file}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, target);
}

/** Persist local adapter state with a shared clock and monotonically increasing ids. */
/** @public */
export class LocalProviderStore<
	S extends {
		/** @internal */
		version: number;
		/** @internal */
		sequence: number;
	},
	O extends {
		/** @internal */
		root: string;
		/** @internal */
		now?: () => number;
		/** @internal */
		nextId?: () => number;
	},
> {
	/** @public */
	readonly git: LocalGit;
	/** @public */
	state: S;
	/** @public */
	constructor(
		/** @public */
		readonly options: O,
		private readonly file: string,
		initial: S,
	) {
		this.git = new LocalGit(options.root);
		this.state = readLocalJson(options.root, file, initial);
	}
	/** @public */
	save() {
		writeLocalJson(this.options.root, this.file, this.state);
	}
	/** @internal */
	id() {
		this.state.sequence = Math.max(this.state.sequence + 1, this.options.nextId?.() ?? 0);
		return this.state.sequence;
	}
	/** @internal */
	timestamp() {
		return new Date(this.options.now?.() ?? Date.now()).toISOString();
	}
}

/** @public */
type LocalPullRequest = Pick<
	RepositoryPullRequest,
	"number" | "title" | "body" | "state" | "merged" | "merge_commit_sha" | "head" | "base"
>;
/** @public */
interface LocalPullRequestRepository<P extends LocalPullRequest> {
	/** @public */
	repository: {
		/** @internal */
		ssh_url: string;
	};
	/** @public */
	pulls: P[];
}

/** Common PR operations; adapters retain their provider-specific state and clients. */
/** @public */
export class LocalForgeStore<
	S extends {
		/** @internal */
		version: number;
		/** @internal */
		sequence: number;
	},
	O extends {
		/** @internal */
		root: string;
		/** @internal */
		baseUrl: string;
		/** @internal */
		now?: () => number;
		/** @internal */
		nextId?: () => number;
	},
> extends LocalProviderStore<S, O> {
	/** @public */
	newRepository(seed: LocalRepositorySeed) {
		const { bare, branch } = this.git.seed(seed);
		return {
			/** @public */
			id: this.id(),
			/** @public */
			owner: {
				/** @internal */
				login: seed.owner,
			},
			/** @public */
			name: seed.name,
			/** @public */
			full_name: `${seed.owner}/${seed.name}`,
			/** @public */
			ssh_url: bare,
			/** @public */
			html_url: `${this.options.baseUrl}/__local`,
			/** @public */
			default_branch: branch,
		};
	}
	/** @internal */
	pullRequestClient<P extends LocalPullRequest>(
		repo: (owner: string, name: string) => LocalPullRequestRepository<P>,
		missing = "Unknown local pull request",
	) {
		const pull = (owner: string, name: string, number: number) => {
			const pr = repo(owner, name).pulls.find((p) => p.number === number);
			if (!pr) throw new Error(missing);
			return pr;
		};
		return {
			/** @internal */
			getPullRequest: async (owner: string, name: string, number: number) =>
				this.refresh(repo(owner, name), pull(owner, name, number)),
			/** @internal */
			listPullRequests: async (owner: string, name: string, state = "open") => {
				const r = repo(owner, name);
				return r.pulls
					.filter((p) => state === "all" || p.state === state)
					.map((p) => this.refresh(r, p));
			},
			/** @internal */
			updatePullRequest: async (
				owner: string,
				name: string,
				number: number,
				patch: Record<string, unknown>,
			) => {
				const pr = pull(owner, name, number);
				for (const key of ["title", "body", "state"] as const)
					if (typeof patch[key] === "string") pr[key] = patch[key];
				this.save();
				return this.refresh(repo(owner, name), pr);
			},
		};
	}
	/** @public */
	refresh<P extends LocalPullRequest>(repo: LocalPullRequestRepository<P>, pr: P): P {
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
	/** @public */
	merge<P extends LocalPullRequest>(repo: LocalPullRequestRepository<P>, number: number): P {
		const pr = repo.pulls.find((p) => p.number === number);
		if (!pr || pr.state !== "open") throw new Error("Pull request is not open");
		this.refresh(repo, pr);
		pr.merge_commit_sha = this.git.merge(repo.repository.ssh_url, pr.head.ref, pr.base.ref);
		pr.merged = true;
		pr.state = "closed";
		this.save();
		return structuredClone(pr);
	}
	/** @public */
	addFeedback<F extends RepositoryFeedbackItem>(
		repo: {
			/** @public */
			pulls: Array<{
				/** @internal */
				number: number;
			}>;
			/** @public */
			feedback: Record<string, F[]>;
		},
		number: number,
		input: Omit<F, "id" | "createdAt">,
	): F {
		if (!repo.pulls.some((p) => p.number === number)) throw new Error("Unknown PR");
		const value = { ...input, id: this.id(), createdAt: this.timestamp() } as F;
		repo.feedback[number] ??= [];
		repo.feedback[number].push(value);
		this.save();
		return value;
	}
	/** @public */
	newComment(body: string) {
		return {
			/** @internal */
			id: this.id(),
			/** @internal */
			body,
			/** @public */
			user: {
				/** @public */
				login: "leitwerk-bot",
			},
			/** @internal */
			created_at: this.timestamp(),
		};
	}
	/** @internal */
	newPullRequest(
		repo: {
			/** @internal */
			repository: {
				/** @internal */
				ssh_url: string;
			};
		},
		input: {
			/** @internal */
			title: string;
			/** @internal */
			body: string;
			/** @internal */
			head: string;
			/** @internal */
			base: string;
		},
	) {
		const number = this.id();
		return {
			/** @internal */
			number,
			/** @internal */
			title: input.title,
			/** @internal */
			body: input.body,
			/** @internal */
			state: "open",
			/** @internal */
			merged: false,
			/** @internal */
			merge_commit_sha: null,
			/** @internal */
			html_url: `${this.options.baseUrl}/__local#pr-${number}`,
			/** @internal */
			head: {
				/** @internal */
				ref: input.head,
				/** @internal */
				sha: this.git.head(repo.repository.ssh_url, input.head),
			},
			/** @internal */
			base: {
				/** @internal */
				ref: input.base,
				/** @internal */
				sha: this.git.head(repo.repository.ssh_url, input.base),
			},
		};
	}
}

/** Real Git with file-only transport and no ambient credentials or hooks. */
/** @public */
export class LocalGit {
	/** @public */
	constructor(
		/** @internal */
		readonly root: string,
	) {
		if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("Local Git root must not be a symlink");
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	/** @public */
	run(directory: string, args: string[]): string {
		const base = realpathSync(this.root);
		const directoryPath = path.resolve(directory);
		const relative = path.relative(
			directoryPath.startsWith(`${base}${path.sep}`) ? base : path.resolve(this.root),
			directoryPath,
		);
		const cwd = localPath(this.root, relative);
		return traceTestSubprocess(`git ${args[0] ?? ""}`, () =>
			execFileSync(
				"git",
				["-c", "protocol.file.allow=always", "-c", "core.hooksPath=/dev/null", ...args],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						PATH: process.env.PATH,
						HOME: this.root,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_ALLOW_PROTOCOL: "file",
						GIT_AUTHOR_NAME: "Sandbox Developer",
						GIT_AUTHOR_EMAIL: "developer@sandbox.invalid",
						GIT_COMMITTER_NAME: "Sandbox Developer",
						GIT_COMMITTER_EMAIL: "developer@sandbox.invalid",
					},
				},
			).trim(),
		);
	}
	/** @public */
	head(directory: string, ref: string): string {
		if (!/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.startsWith("-")) throw new Error("Invalid Git ref");
		return this.run(directory, ["rev-parse", "--verify", `${ref}^{commit}`]);
	}
	/** @internal */
	isAncestor(directory: string, ancestor: string, descendant: string): boolean {
		return this.isAncestorCommit(
			directory,
			this.head(directory, ancestor),
			this.head(directory, descendant),
		);
	}
	private isAncestorCommit(directory: string, ancestor: string, descendant: string): boolean {
		if (ancestor === descendant) return true;
		try {
			this.run(directory, ["merge-base", "--is-ancestor", ancestor, descendant]);
			return true;
		} catch (error) {
			if ((error as { status?: number }).status === 1) return false;
			throw error;
		}
	}
	/** @internal */
	mergeability(
		directory: string,
		head: string,
		base: string,
	): {
		/** @internal */
		headSha: string;
		/** @internal */
		baseSha: string;
		/** @internal */
		mergeable: boolean;
		/** @internal */
		mergeable_state: string;
	} {
		const headSha = this.head(directory, head),
			baseSha = this.head(directory, base);
		const revisions = { headSha, baseSha };
		if (this.isAncestorCommit(directory, baseSha, headSha))
			return { ...revisions, mergeable: true, mergeable_state: "clean" };
		try {
			this.run(directory, ["merge-tree", "--write-tree", baseSha, headSha]);
		} catch (error) {
			if ((error as { status?: number }).status === 1)
				return { ...revisions, mergeable: false, mergeable_state: "dirty" };
			throw error;
		}
		return { ...revisions, mergeable: true, mergeable_state: "behind" };
	}
	/** @internal */
	merge(directory: string, head: string, base: string): string {
		const h = this.head(directory, head),
			b = this.head(directory, base);
		let commit = h;
		if (!this.isAncestorCommit(directory, b, h)) {
			const tree = this.run(directory, ["merge-tree", "--write-tree", b, h]).split("\n")[0];
			commit = this.run(directory, [
				"commit-tree",
				tree,
				"-p",
				b,
				"-p",
				h,
				"-m",
				"Merge local pull request",
			]);
		}
		this.run(directory, ["update-ref", `refs/heads/${base}`, commit, b]);
		return commit;
	}
	/** @internal */
	seed(seed: LocalRepositorySeed): {
		/** @internal */
		bare: string;
		/** @internal */
		worktree: string;
		/** @internal */
		branch: string;
	} {
		for (const value of [seed.owner, seed.name, seed.directoryName ?? seed.name])
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
				throw new Error("Invalid local repository name");
		const name = seed.directoryName ?? `${seed.owner}--${seed.name}`;
		const bare = localPath(this.root, `repositories/${name}.git`);
		const worktree = localPath(this.root, `seeds/${name}`);
		const branch = seed.defaultBranch ?? "main";
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(branch)) throw new Error("Invalid default branch");
		mkdirSync(bare, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		if (!existsSync(path.join(bare, "HEAD")))
			this.run(bare, ["init", "--bare", `--initial-branch=${branch}`]);
		try {
			this.head(bare, branch);
			return { bare, worktree, branch };
		} catch {
			/* Resume an interrupted seed. */
		}
		if (!existsSync(path.join(worktree, ".git")))
			this.run(worktree, ["init", `--initial-branch=${branch}`]);
		for (const [name, contents] of Object.entries(
			seed.files ?? { "README.md": `# ${seed.name}\n` },
		)) {
			if (name.split(/[\\/]/).includes(".git"))
				throw new Error("Seed must not write Git configuration");
			const target = localPath(worktree, name);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}
		this.run(worktree, ["add", "."]);
		this.run(worktree, [
			"commit",
			"--allow-empty",
			...(seed.signoff ? ["--signoff"] : []),
			"-m",
			seed.commitMessage ?? "chore: seed local repository",
		]);
		if (!this.run(worktree, ["remote"]).split("\n").includes("origin"))
			this.run(worktree, ["remote", "add", "origin", bare]);
		this.run(worktree, ["push", bare, `HEAD:refs/heads/${branch}`]);
		return { bare, worktree, branch };
	}
}
