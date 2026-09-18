import path from "node:path";
import { LocalGit, readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";

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
	private readonly local: LocalGit;
	constructor(
		readonly directory: string,
		readonly seed: NotebookSeed = { name: "notebook", files: { "notes.txt": "Garden notebook\n" } },
	) {
		if (!/^[a-z0-9-]+$/.test(seed.name)) throw new Error("Invalid notebook name");
		this.local = new LocalGit(directory);
		this.repository = path.join(directory, "repositories", `${seed.name}.git`);
		this.file = path.join(directory, "scenarios.json");
		this.state = readLocalJson(directory, "scenarios.json", { version: 1, scenarios: {} });
	}
	git(directory: string, args: string[]): string {
		return this.local.run(directory, args);
	}
	initialize(): void {
		// A failed startup can leave the directory without a branch or scenario state.
		// LocalGit.seed resumes partial seeds and preserves an already seeded branch.
		this.local.seed({
			...this.seed,
			owner: "local",
			directoryName: this.seed.name,
			commitMessage: "docs: start notebook",
			signoff: true,
		});
		this.git(this.repository, ["config", "user.name", "Sandbox Developer"]);
		this.git(this.repository, ["config", "user.email", "developer@sandbox.invalid"]);
		this.save();
	}
	save(): void {
		writeLocalJson(this.directory, "scenarios.json", this.state);
	}
}
