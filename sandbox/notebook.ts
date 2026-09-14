import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { sandboxEnvironment } from "@leitwerk-dev/dev-sandbox/launcher";
import { assertSandboxPath } from "@leitwerk-dev/dev-sandbox/storage";

export interface NotebookSeed {
	name: string;
	files: Record<string, string>;
}
export interface ScenarioProgress {
	name: string;
	step: number;
}
export class Notebook {
	readonly repository: string;
	readonly file: string;
	readonly state: { version: 1; scenarios: Record<string, ScenarioProgress> };
	constructor(
		readonly directory: string,
		readonly seed: NotebookSeed = { name: "notebook", files: { "notes.txt": "Garden notebook\n" } },
	) {
		if (!/^[a-z0-9-]+$/.test(seed.name)) throw new Error("Invalid notebook name");
		this.repository = path.join(directory, "repositories", `${seed.name}.git`);
		this.file = path.join(directory, "scenarios.json");
		assertSandboxPath(directory, this.file);
		this.state = existsSync(this.file)
			? JSON.parse(readFileSync(this.file, "utf8"))
			: { version: 1, scenarios: {} };
		if (this.state.version !== 1) throw new Error("Unsupported notebook scenario state version");
	}
	git(directory: string, args: string[]): string {
		assertSandboxPath(this.directory, directory);
		const resolved = realpathSync(directory);
		return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: resolved,
			encoding: "utf8",
			env: sandboxEnvironment(this.directory),
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	}
	initialize(): void {
		assertSandboxPath(this.directory, this.repository);
		if (existsSync(this.repository)) return;
		mkdirSync(path.dirname(this.repository), { recursive: true });
		this.git(this.directory, ["init", "--bare", "--initial-branch=main", this.repository]);
		const seed = path.join(this.directory, "seeds", this.seed.name);
		assertSandboxPath(this.directory, seed);
		mkdirSync(seed, { recursive: true });
		this.git(seed, ["init", "--initial-branch=main"]);
		this.git(this.repository, ["config", "user.name", "Sandbox Developer"]);
		this.git(this.repository, ["config", "user.email", "developer@sandbox.invalid"]);
		for (const [name, contents] of Object.entries(this.seed.files)) {
			const file = path.resolve(seed, name);
			assertSandboxPath(seed, file);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		this.git(seed, ["add", "."]);
		this.git(seed, ["commit", "--signoff", "-m", "docs: start notebook"]);
		this.git(seed, ["remote", "add", "origin", this.repository]);
		this.git(seed, ["push", "origin", "main"]);
		this.save();
	}
	save(): void {
		assertSandboxPath(this.directory, `${this.file}.tmp`);
		writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
	}
}
