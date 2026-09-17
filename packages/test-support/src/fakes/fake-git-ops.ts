import path from "node:path";

/** @internal */
export type RepoTemplate = Record<string, string>;

/**
 * Structurally compatible with RunRootGitOps — call sites annotate
 * `const git: RunRootGitOps = new FakeGitOps(...)` so TS catches drift.
 */
/** @internal */
export class FakeGitOps {
	/** @internal */
	readonly operations: string[] = [];
	private readonly files = new Map<string, string>();
	private readonly repoState = new Map<string, { currentBranch: string; branches: Set<string> }>();

	/** @internal */
	constructor(private readonly templates: Map<string, RepoTemplate>) {}

	private abs(repoDir: string, filePath: string): string {
		return path.normalize(path.join(repoDir, filePath));
	}

	/** @internal */
	async writeFile(repoDir: string, filePath: string, content: string): Promise<void> {
		this.operations.push(`writeFile:${filePath}`);
		this.files.set(this.abs(repoDir, filePath), content);
	}

	/** @internal */
	async readFile(repoDir: string, filePath: string): Promise<string | null> {
		return this.files.get(this.abs(repoDir, filePath)) ?? null;
	}

	/** @internal */
	async clone(repoLocator: string, targetDir: string): Promise<void> {
		this.operations.push(`clone:${path.basename(targetDir)}`);
		const n = path.normalize(targetDir);
		const prefix = n + path.sep;
		for (const k of [...this.files.keys()]) {
			if (k === n || k.startsWith(prefix)) {
				this.files.delete(k);
			}
		}
		const tmpl = this.templates.get(repoLocator);
		if (!tmpl) {
			throw new Error(`unknown repo ${repoLocator}`);
		}
		for (const [rel, content] of Object.entries(tmpl)) {
			this.files.set(path.join(targetDir, rel), content);
		}
		this.repoState.set(n, {
			currentBranch: "main",
			branches: new Set(["main"]),
		});
	}

	/** @internal */
	async checkout(repoDir: string, branch: string): Promise<void> {
		const st = this.repoState.get(path.normalize(repoDir));
		if (!st) {
			throw new Error("not a repo");
		}
		st.branches.add(branch);
		st.currentBranch = branch;
	}

	/** @internal */
	async createBranch(repoDir: string, branchName: string, _startPoint: string): Promise<void> {
		const st = this.repoState.get(path.normalize(repoDir));
		if (!st) {
			throw new Error("not a repo");
		}
		st.branches.add(branchName);
	}

	/** @internal */
	async branchExists(repoDir: string, branchName: string): Promise<boolean> {
		const st = this.repoState.get(path.normalize(repoDir));
		return st?.branches.has(branchName) ?? false;
	}

	/** @internal */
	async getHeadSha(repoDir: string): Promise<string> {
		const st = this.repoState.get(path.normalize(repoDir));
		if (!st) {
			throw new Error("not a repo");
		}
		return Buffer.from(`${repoDir}:${st.currentBranch}`)
			.toString("hex")
			.slice(0, 40)
			.padEnd(40, "0");
	}

	/** @internal */
	async listFiles(repoDir: string, pattern: string): Promise<string[]> {
		const normRoot = path.normalize(repoDir);
		const prefix = normRoot + path.sep;
		const out: string[] = [];
		for (const k of this.files.keys()) {
			if (k !== normRoot && !k.startsWith(prefix)) {
				continue;
			}
			const rel = k === normRoot ? "" : k.slice(prefix.length);
			if (!rel) {
				continue;
			}
			const relPosix = rel.split(path.sep).join("/");
			if (pattern === "**/AGENTS.md") {
				if (relPosix.endsWith("AGENTS.md")) {
					out.push(relPosix);
				}
			} else if (pattern === "**/.cursor/skills/**/SKILL.md") {
				if (/^\.cursor\/skills\/[^/]+\/SKILL\.md$/.test(relPosix)) {
					out.push(relPosix);
				}
			}
		}
		return out.sort((a, b) => a.localeCompare(b));
	}
}
