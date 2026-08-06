import path from "node:path";
import {
	type ComponentManifest,
	type ComponentManifestEntry,
	deserializeManifest,
	diffManifest,
	type ManifestDiff,
	serializeManifest,
} from "./manifest.js";
import { aggregateAgentsMd, collectSkills } from "./resource-aggregator.js";

export interface GitOps {
	clone(repoLocator: string, targetDir: string): Promise<void>;
	checkout(repoDir: string, branch: string): Promise<void>;
	createBranch(repoDir: string, branchName: string, startPoint: string): Promise<void>;
	branchExists(repoDir: string, branchName: string): Promise<boolean>;
	getHeadSha(repoDir: string): Promise<string>;
	readFile(repoDir: string, filePath: string): Promise<string | null>;
	listFiles(repoDir: string, pattern: string): Promise<string[]>;
}

export type RunRootGitOps = GitOps & {
	writeFile(repoDir: string, filePath: string, content: string): Promise<void>;
	configureRepositoryCredentials?(
		credentials: readonly import("@leitwerk-dev/worker-protocol").WorkerGitSshCredential[],
	): void;
	cleanupRepositoryCredentials?(): void;
};

export interface RunRootPlan {
	workspaceRoot: string;
	instanceId: string;
	components: Array<{
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch: string;
	}>;
}

export interface MaterializeResult {
	ok: boolean;
	manifest: ComponentManifest;
	aggregatedAgentsMdSources: string[];
	loadedSkills: string[];
	errors: string[];
}

export interface ValidationResult {
	valid: boolean;
	diff: ManifestDiff;
	existingManifest: ComponentManifest | null;
}

const MANIFEST_REL = path.join(".leitwerk", "components.json");
const AGGREGATED_AGENTS_REL = "AGENTS.md";
const SKILLS_DIR_REL = path.join(".leitwerk", "skills");

const SKILL_GLOB = "**/.cursor/skills/**/SKILL.md";
const AGENTS_GLOB = "**/AGENTS.md";

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function safeJoinInsideWorkspace(workspaceRoot: string, childPath: string): string {
	const root = path.resolve(workspaceRoot);
	const target = path.resolve(root, childPath);
	if (!isPathInside(root, target)) {
		throw new Error(`Component key '${childPath}' resolves outside workspace root '${root}'`);
	}
	return target;
}

function componentDir(workspaceRoot: string, key: string): string {
	return safeJoinInsideWorkspace(workspaceRoot, key);
}

function skillIdFromSkillPath(filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	const m = normalized.match(/\.cursor\/skills\/([^/]+)\/SKILL\.md$/);
	return m?.[1] ?? null;
}

export function planRunRoot(
	workspaceRoot: string,
	instanceId: string,
	projectSnapshots: Array<{
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch: string;
	}>,
): RunRootPlan {
	return {
		workspaceRoot,
		instanceId,
		components: projectSnapshots.map((p) => ({ ...p })),
	};
}

async function materializeComponentEntry(
	plan: RunRootPlan,
	comp: RunRootPlan["components"][number],
	git: RunRootGitOps,
): Promise<ComponentManifestEntry> {
	const dir = componentDir(plan.workspaceRoot, comp.key);
	await git.clone(comp.repoLocator, dir);
	await git.checkout(dir, comp.baseBranch);
	if (await git.branchExists(dir, comp.workBranch)) {
		await git.checkout(dir, comp.workBranch);
	} else {
		await git.createBranch(dir, comp.workBranch, comp.baseBranch);
		await git.checkout(dir, comp.workBranch);
	}
	return {
		key: comp.key,
		repoLocator: comp.repoLocator,
		baseBranch: comp.baseBranch,
		workBranch: comp.workBranch,
		clonedAt: new Date().toISOString(),
		headSha: await git.getHeadSha(dir),
	};
}

async function collectMaterializedEntries(
	plan: RunRootPlan,
	git: RunRootGitOps,
	errors: string[],
	shouldMaterialize: (componentKey: string) => boolean = () => true,
	existingEntryForKey?: (componentKey: string) => ComponentManifestEntry | null,
): Promise<ComponentManifestEntry[]> {
	const entries: ComponentManifestEntry[] = [];
	for (const comp of plan.components) {
		if (!shouldMaterialize(comp.key)) {
			const existing = existingEntryForKey?.(comp.key) ?? null;
			if (existing) {
				entries.push(existing);
			} else {
				errors.push(`${comp.key}: no existing manifest entry for unchanged key`);
			}
			continue;
		}
		try {
			entries.push(await materializeComponentEntry(plan, comp, git));
		} catch (e) {
			errors.push(`${comp.key}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return entries;
}

async function gatherAgentsAndSkills(
	plan: RunRootPlan,
	git: RunRootGitOps,
): Promise<{
	aggregatedAgentsMdSources: string[];
	agentsMd: string;
	skillsMap: Map<string, { content: string; source: string }>;
}> {
	const agentSources: Array<{
		componentKey: string;
		filePath: string;
		content: string;
	}> = [];
	const skillSources: Array<{
		componentKey: string;
		skillId: string;
		content: string;
	}> = [];
	const aggregatedAgentsMdSources: string[] = [];

	for (const comp of plan.components) {
		const root = componentDir(plan.workspaceRoot, comp.key);
		const agentPaths = await git.listFiles(root, AGENTS_GLOB);
		const sortedAgentPaths = [...agentPaths].sort((a, b) => a.localeCompare(b));
		for (const p of sortedAgentPaths) {
			const content = await git.readFile(root, p);
			if (content !== null) {
				agentSources.push({
					componentKey: comp.key,
					filePath: p,
					content,
				});
				aggregatedAgentsMdSources.push(`${comp.key}/${p}`);
			}
		}

		const skillPaths = await git.listFiles(root, SKILL_GLOB);
		for (const p of skillPaths) {
			const skillId = skillIdFromSkillPath(p);
			if (!skillId) {
				continue;
			}
			const content = await git.readFile(root, p);
			if (content !== null) {
				skillSources.push({ componentKey: comp.key, skillId, content });
			}
		}
	}

	const agentsMd = aggregateAgentsMd(agentSources);
	const skillsMap = collectSkills(skillSources);
	aggregatedAgentsMdSources.sort((a, b) => a.localeCompare(b));
	return { aggregatedAgentsMdSources, agentsMd, skillsMap };
}

async function writeAggregatedArtifacts(
	plan: RunRootPlan,
	git: RunRootGitOps,
	manifest: ComponentManifest,
	agentsMd: string,
	skillsMap: Map<string, { content: string; source: string }>,
): Promise<void> {
	const root = plan.workspaceRoot;
	await git.writeFile(root, MANIFEST_REL, serializeManifest(manifest));
	await git.writeFile(root, AGGREGATED_AGENTS_REL, agentsMd);
	for (const [skillId, { content }] of skillsMap) {
		const rel = path.join(SKILLS_DIR_REL, `${skillId}.md`);
		await git.writeFile(root, rel, content);
	}
}

async function finalizeRunRoot(
	plan: RunRootPlan,
	git: RunRootGitOps,
	entries: ComponentManifestEntry[],
	errors: string[],
) {
	const manifest: ComponentManifest = {
		version: 1,
		instanceId: plan.instanceId,
		createdAt: new Date().toISOString(),
		components: entries,
	};

	const { aggregatedAgentsMdSources, agentsMd, skillsMap } = await gatherAgentsAndSkills(plan, git);
	const loadedSkills = [...skillsMap.keys()].sort((a, b) => a.localeCompare(b));

	try {
		await writeAggregatedArtifacts(plan, git, manifest, agentsMd, skillsMap);
	} catch (e) {
		errors.push(`write: ${e instanceof Error ? e.message : String(e)}`);
	}

	return { manifest, aggregatedAgentsMdSources, loadedSkills };
}

export async function materializeRunRoot(
	plan: RunRootPlan,
	git: RunRootGitOps,
): Promise<MaterializeResult> {
	const errors: string[] = [];
	const entries = await collectMaterializedEntries(plan, git, errors);
	const { manifest, aggregatedAgentsMdSources, loadedSkills } = await finalizeRunRoot(
		plan,
		git,
		entries,
		errors,
	);

	const ok = errors.length === 0 && plan.components.length === entries.length;
	return {
		ok,
		manifest,
		aggregatedAgentsMdSources,
		loadedSkills,
		errors,
	};
}

export async function validateRunRoot(
	workspaceRoot: string,
	serverProjects: Array<{
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch: string;
	}>,
	git: GitOps,
): Promise<ValidationResult> {
	const raw = await git.readFile(workspaceRoot, MANIFEST_REL);
	if (raw === null) {
		return {
			valid: false,
			diff: {
				stale: [],
				missing: serverProjects.map((p) => p.key),
				extra: [],
				unchanged: [],
			},
			existingManifest: null,
		};
	}
	const parsed = deserializeManifest(raw);
	if (!parsed.ok) {
		return {
			valid: false,
			diff: {
				stale: [],
				missing: serverProjects.map((p) => p.key),
				extra: [],
				unchanged: [],
			},
			existingManifest: null,
		};
	}
	const diff = diffManifest(parsed.manifest, serverProjects);
	const valid = diff.stale.length === 0 && diff.missing.length === 0 && diff.extra.length === 0;
	return {
		valid,
		diff,
		existingManifest: parsed.manifest,
	};
}

export async function repairRunRoot(
	_workspaceRoot: string,
	validation: ValidationResult,
	plan: RunRootPlan,
	git: RunRootGitOps,
): Promise<MaterializeResult> {
	const errors: string[] = [];
	const toRepair = new Set([...validation.diff.stale, ...validation.diff.missing]);
	const manifestEntries = await collectMaterializedEntries(
		plan,
		git,
		errors,
		(componentKey) => toRepair.has(componentKey),
		(componentKey) =>
			validation.existingManifest?.components.find((component) => component.key === componentKey) ??
			null,
	);

	const { manifest, aggregatedAgentsMdSources, loadedSkills } = await finalizeRunRoot(
		plan,
		git,
		manifestEntries,
		errors,
	);

	const expectedKeys = new Set(plan.components.map((c) => c.key));
	const ok =
		errors.length === 0 &&
		manifestEntries.length === plan.components.length &&
		[...expectedKeys].every((k) => manifestEntries.some((e) => e.key === k));

	return {
		ok,
		manifest,
		aggregatedAgentsMdSources,
		loadedSkills,
		errors,
	};
}
