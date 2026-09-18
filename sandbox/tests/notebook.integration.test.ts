import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Notebook } from "../notebook.js";

it.each([
	"directory",
	"bare repository",
	"seeded repository",
] as const)("resumes initialization after interruption left a %s", (stage) => {
	const root = mkdtempSync(path.join(tmpdir(), "notebook-recovery-"));
	try {
		const notebook = new Notebook(root);
		mkdirSync(notebook.repository, { recursive: true });
		if (stage === "bare repository") {
			notebook.git(notebook.repository, ["init", "--bare", "--initial-branch=main"]);
		}
		if (stage === "seeded repository") {
			notebook.initialize();
			rmSync(notebook.file);
		}
		const recovered = new Notebook(root);
		recovered.initialize();
		expect(JSON.parse(readFileSync(recovered.file, "utf8"))).toEqual({
			version: 1,
			scenarios: {},
		});
		expect(recovered.git(recovered.repository, ["show", "main:notes.txt"])).toContain(
			"Garden notebook",
		);
		const head = recovered.git(recovered.repository, ["rev-parse", "main"]);
		recovered.state.scenarios.review = { name: "review", step: 3 };
		recovered.save();
		const before = readFileSync(recovered.file, "utf8");
		const restarted = new Notebook(root);
		restarted.initialize();
		expect(readFileSync(restarted.file, "utf8")).toBe(before);
		expect(restarted.git(restarted.repository, ["rev-parse", "main"])).toBe(head);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
