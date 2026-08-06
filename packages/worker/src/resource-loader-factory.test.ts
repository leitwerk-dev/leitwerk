import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLeitwerkResourceLoaderOptions } from "./resource-loader-factory.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "leitwerk-resource-loader-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("buildLeitwerkResourceLoaderOptions", () => {
	it("disables ambient and cwd discovery in favor of managed resources", async () => {
		const workspaceRoot = await createTempWorkspace();
		const agentDir = await createTempWorkspace();
		const options = await buildLeitwerkResourceLoaderOptions(workspaceRoot, agentDir, {
			systemPrompt: "system prompt",
			appendSystemPrompt: "append prompt",
		});

		expect(options).toMatchObject({
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [],
			additionalSkillPaths: [],
			additionalPromptTemplatePaths: [],
			systemPrompt: "system prompt",
			appendSystemPrompt: ["append prompt"],
		});

		const skills = { skills: [], diagnostics: [] };
		const agentsFiles = { agentsFiles: [] };
		expect(options.skillsOverride?.(skills)).toBe(skills);
		expect(options.agentsFilesOverride?.(agentsFiles)).toBe(agentsFiles);
	});

	it("adds aggregated process-workspace skills and AGENTS.md without duplicating AGENTS.md", async () => {
		const workspaceRoot = await createTempWorkspace();
		const skillDir = path.join(workspaceRoot, ".leitwerk", "skills", "recovery-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			path.join(skillDir, "SKILL.md"),
			`---\ndescription: Use this skill for recovery testing.\n---\n\n# Recovery skill\n`,
		);
		const agentsPath = path.join(workspaceRoot, "AGENTS.md");
		await writeFile(agentsPath, "Aggregated process instructions");

		const options = await buildLeitwerkResourceLoaderOptions(
			workspaceRoot,
			await createTempWorkspace(),
		);
		const skills = options.skillsOverride?.({ skills: [], diagnostics: [] });
		expect(skills?.skills.map((skill) => skill.name)).toContain("recovery-skill");
		expect(skills?.diagnostics).toEqual([]);

		const agentsFiles = options.agentsFilesOverride?.({
			agentsFiles: [{ path: "/base/AGENTS.md", content: "base" }],
		});
		expect(agentsFiles?.agentsFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: agentsPath, content: "Aggregated process instructions" }),
			]),
		);

		const alreadyPresent = options.agentsFilesOverride?.({
			agentsFiles: [{ path: agentsPath, content: "already loaded" }],
		});
		expect(alreadyPresent?.agentsFiles).toEqual([{ path: agentsPath, content: "already loaded" }]);
	});
});
