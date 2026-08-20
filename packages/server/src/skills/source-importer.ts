import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	createCanonicalPiResourceBundle,
	type PiResourceBundle,
} from "@leitwerk-dev/worker-protocol";
import type { SkillRepositoryConfig } from "../config/config-types.js";
import { ResourceCollector, SKILL_RESOURCE_OWNER } from "../pi-resources/resource-collector.js";
import { skillFrontmatter } from "./skill-frontmatter.js";
import { SAFE_SKILL_ID_PATTERN } from "./skill-id.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
const FORBIDDEN_SKILL_NAMES = new Set([".git"]);

export interface ImportedSkill {
	skillId: string;
	label: string;
	description: string | null;
	bundle: PiResourceBundle;
	sourceRevision: string;
}

export interface ImportedRepositorySkill extends ImportedSkill {
	sourcePath: string;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function importSkillDirectory(
	root: string,
	checkoutRoot: string,
	sourceRevision: string,
): Promise<ImportedRepositorySkill> {
	const skillId = path.basename(root);
	const metadata = skillFrontmatter(await readFile(path.join(root, "SKILL.md"), "utf8"));
	const collector = new ResourceCollector();
	await collector.addDirectory(path.resolve(root), `skills/${skillId}`, SKILL_RESOURCE_OWNER, {
		forbiddenNames: FORBIDDEN_SKILL_NAMES,
	});
	const files = collector.toResourceFiles();
	if (!files.some((file) => file.path === `skills/${skillId}/SKILL.md`)) {
		throw new Error(`Skill '${skillId}' must contain a regular root SKILL.md`);
	}
	return {
		skillId,
		label: metadataText(metadata.name) ?? fallbackLabel(skillId),
		description: metadataText(metadata.description),
		bundle: createCanonicalPiResourceBundle(files),
		sourceRevision,
		sourcePath: repositorySourcePath(checkoutRoot, root),
	};
}

async function checkoutGitSource(
	source: { url: string; ref: string },
	root: string,
): Promise<{ root: string; commit: string }> {
	await execFileAsync(
		"git",
		["clone", "--quiet", "--no-checkout", "--filter=blob:none", source.url, root],
		{ env: GIT_ENV },
	);
	await execFileAsync("git", ["-C", root, "checkout", "--quiet", "--detach", source.ref], {
		env: GIT_ENV,
	});
	const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
	return { root, commit: stdout.trim() };
}

function metadataText(value: unknown): string | null {
	return typeof value === "string" ? value.trim() || null : null;
}

function fallbackLabel(id: string): string {
	return id
		.split(/[-_.]+/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

async function discoverSkillRoots(catalogRoot: string): Promise<string[]> {
	const result: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		const skillId = path.basename(directory);
		if (
			SAFE_SKILL_ID_PATTERN.test(skillId) &&
			entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())
		) {
			result.push(directory);
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name !== ".git") {
				await visit(path.join(directory, entry.name));
			}
		}
	};
	await visit(catalogRoot);
	return result;
}

function repositorySourcePath(checkoutRoot: string, skillRoot: string): string {
	return path.relative(checkoutRoot, skillRoot).split(path.sep).join(path.posix.sep);
}

export async function importSkillRepository(
	repository: SkillRepositoryConfig,
): Promise<{ commit: string; skills: ImportedRepositorySkill[] }> {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "leitwerk-skill-repository-"));
	try {
		const checkout = await checkoutGitSource(repository, path.join(tempRoot, "checkout"));
		const catalogRoot = path.resolve(checkout.root, repository.path ?? "skills");
		if (!isWithin(checkout.root, catalogRoot)) {
			throw new Error(`Skill repository '${repository.id}' path escapes its checkout`);
		}
		const skillRoots = await discoverSkillRoots(catalogRoot);
		const rootsById = new Map<string, string>();
		for (const skillRoot of skillRoots) {
			const skillId = path.basename(skillRoot);
			const previous = rootsById.get(skillId);
			if (previous) {
				throw new Error(
					`Skill repository '${repository.id}' contains duplicate skill id '${skillId}' at '${repositorySourcePath(checkout.root, previous)}' and '${repositorySourcePath(checkout.root, skillRoot)}'`,
				);
			}
			rootsById.set(skillId, skillRoot);
		}
		const skills: ImportedRepositorySkill[] = [];
		for (const skillRoot of skillRoots) {
			skills.push(await importSkillDirectory(skillRoot, checkout.root, checkout.commit));
		}
		return { commit: checkout.commit, skills };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}
