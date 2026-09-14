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

export interface LocalRepositorySeed {
	owner: string;
	name: string;
	defaultBranch?: string;
	files?: Record<string, string>;
	/** Retain a pre-existing sandbox checkout layout. */
	directoryName?: string;
	commitMessage?: string;
	signoff?: boolean;
}

/** Reject escaping paths and symlinks, including a not-yet-created file's parents. */
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

export function readLocalJson<T extends { version: number }>(
	root: string,
	file: string,
	initial: T,
): T {
	const target = localPath(root, file);
	if (!existsSync(target)) return structuredClone(initial);
	const value = JSON.parse(readFileSync(target, "utf8")) as T;
	if (!value || value.version !== initial.version)
		throw new Error(`Unsupported local state version in ${file}`);
	return value;
}

export function writeLocalJson(root: string, file: string, value: unknown): void {
	const target = localPath(root, file);
	const temporary = localPath(root, `${file}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, target);
}

/** Persist local adapter state with a shared clock and monotonically increasing ids. */
export class LocalProviderStore<
	S extends { version: number; sequence: number },
	O extends { root: string; now?: () => number; nextId?: () => number },
> {
	readonly git: LocalGit;
	state: S;
	constructor(
		readonly options: O,
		private readonly file: string,
		initial: S,
	) {
		this.git = new LocalGit(options.root);
		this.state = readLocalJson(options.root, file, initial);
	}
	save() {
		writeLocalJson(this.options.root, this.file, this.state);
	}
	id() {
		this.state.sequence = Math.max(this.state.sequence + 1, this.options.nextId?.() ?? 0);
		return this.state.sequence;
	}
	timestamp() {
		return new Date(this.options.now?.() ?? Date.now()).toISOString();
	}
}

/** Real Git with file-only transport and no ambient credentials or hooks. */
export class LocalGit {
	constructor(readonly root: string) {
		if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("Local Git root must not be a symlink");
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	run(directory: string, args: string[]): string {
		const base = realpathSync(this.root);
		const directoryPath = path.resolve(directory);
		const relative = path.relative(
			directoryPath.startsWith(`${base}${path.sep}`) ? base : path.resolve(this.root),
			directoryPath,
		);
		const cwd = localPath(this.root, relative);
		return execFileSync(
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
		).trim();
	}
	head(directory: string, ref: string): string {
		if (!/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.startsWith("-")) throw new Error("Invalid Git ref");
		return this.run(directory, ["rev-parse", "--verify", `${ref}^{commit}`]);
	}
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
	mergeability(
		directory: string,
		head: string,
		base: string,
	): { headSha: string; baseSha: string; mergeable: boolean; mergeable_state: string } {
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
	seed(seed: LocalRepositorySeed): { bare: string; worktree: string; branch: string } {
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
