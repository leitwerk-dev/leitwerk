import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSkillPackManifest } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";

const output = path.resolve(import.meta.dirname, "../dist/skills");

describe("adapted Matt Pocock skills", () => {
	it("ships a complete, selectable architecture workflow with Markdown reports", async () => {
		const manifest = parseSkillPackManifest(
			JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")),
		);
		const architecture = manifest.skills.find(
			(skill) => skill.id === "mattpocock-improve-codebase-architecture",
		);
		expect(architecture?.dependencies).toEqual([
			"mattpocock-codebase-design",
			"mattpocock-grilling",
			"mattpocock-domain-modeling",
		]);
		const allMarkdown: string[] = [];
		for (const skill of manifest.skills) {
			const directory = path.join(output, skill.directory);
			const instructions = await readFile(path.join(directory, "SKILL.md"), "utf8");
			expect(instructions).toContain(`name: ${skill.id}`);
			expect(instructions).not.toContain("disable-model-invocation: true");
			expect(await readFile(path.join(directory, "licenses/LICENSE"), "utf8")).toContain(
				"Copyright (c) 2026 Matt Pocock",
			);
			for (const name of await readdir(directory)) {
				if (name.endsWith(".md"))
					allMarkdown.push(await readFile(path.join(directory, name), "utf8"));
			}
		}
		expect(allMarkdown.join("\n")).not.toMatch(
			/HTML-REPORT|Tailwind|CDN|xdg-open|Skill tool|sub-agent/i,
		);
		const report = await readFile(
			path.join(output, "mattpocock-improve-codebase-architecture/MARKDOWN-REPORT.md"),
			"utf8",
		);
		expect(report).toContain("```mermaid");
		expect(report).toContain("result-publication");
	});
});
