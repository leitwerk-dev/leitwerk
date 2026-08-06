import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	createCanonicalPiResourceBundle,
	type PiResourceBundle,
} from "@leitwerk-dev/worker-protocol";
import type {
	SkillConfig,
	SkillRepositoryConfig,
	SkillSourceConfig,
} from "../config/config-types.js";
import { ResourceCollector, SKILL_RESOURCE_OWNER } from "../pi-resources/resource-collector.js";
import { SAFE_SKILL_ID_PATTERN } from "./skill-id.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
const FORBIDDEN_SKILL_NAMES = new Set([".git"]);

export interface ImportedSkill {
	skillId: string;
	label: string;
	description: string | null;
	bundle: PiResourceBundle;
	sourceRevision: string | null;
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
	skill: SkillConfig,
	sourceRevision: string | null,
): Promise<ImportedSkill> {
	const collector = new ResourceCollector();
	await collector.addDirectory(path.resolve(root), `skills/${skill.id}`, SKILL_RESOURCE_OWNER, {
		forbiddenNames: FORBIDDEN_SKILL_NAMES,
	});
	const files = collector.toResourceFiles();
	if (!files.some((file) => file.path === `skills/${skill.id}/SKILL.md`)) {
		throw new Error(`Skill '${skill.id}' must contain a regular root SKILL.md`);
	}
	return {
		skillId: skill.id,
		label: skill.label ?? skill.id,
		description: skill.description ?? null,
		bundle: createCanonicalPiResourceBundle(files),
		sourceRevision,
	};
}

async function checkoutGitSource(
	source: Extract<SkillSourceConfig, { kind: "git" }>,
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

function metadataValue(markdown: string, key: string): string | null {
	if (!markdown.startsWith("---")) return null;
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) return null;
	const match = markdown
		.slice(3, end)
		.match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "m"));
	return match?.[1]?.trim() || null;
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
			directory !== catalogRoot &&
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
		const checkout = await checkoutGitSource(
			{ kind: "git", url: repository.url, ref: repository.ref, path: repository.path ?? "skills" },
			path.join(tempRoot, "checkout"),
		);
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
			const skillId = path.basename(skillRoot);
			const markdown = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
			const imported = await importSkillDirectory(
				skillRoot,
				{
					id: skillId,
					label: metadataValue(markdown, "name") ?? fallbackLabel(skillId),
					description: metadataValue(markdown, "description") ?? undefined,
					source: { kind: "local", path: skillRoot },
				},
				checkout.commit,
			);
			skills.push({
				...imported,
				sourcePath: repositorySourcePath(checkout.root, skillRoot),
			});
		}
		return { commit: checkout.commit, skills };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

export async function importConfiguredSkills(
	skills: readonly SkillConfig[],
	configRoot: string,
): Promise<ImportedSkill[]> {
	let tempRoot: string | null = null;
	const checkouts = new Map<string, { root: string; commit: string }>();
	try {
		const result: ImportedSkill[] = [];
		for (const skill of skills) {
			if (skill.source.kind === "local") {
				result.push(
					await importSkillDirectory(path.resolve(configRoot, skill.source.path), skill, null),
				);
				continue;
			}
			const key = `${skill.source.url}\0${skill.source.ref}`;
			let checkout = checkouts.get(key);
			if (!checkout) {
				tempRoot ??= await mkdtemp(path.join(tmpdir(), "leitwerk-skills-"));
				checkout = await checkoutGitSource(
					skill.source,
					path.join(tempRoot, String(checkouts.size)),
				);
				checkouts.set(key, checkout);
			}
			const selected = path.resolve(checkout.root, skill.source.path);
			if (!isWithin(checkout.root, selected)) {
				throw new Error(`Skill '${skill.id}' Git path escapes its checkout`);
			}
			result.push(await importSkillDirectory(selected, skill, checkout.commit));
		}
		return result;
	} finally {
		if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	}
}
