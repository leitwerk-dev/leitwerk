import path from "node:path";
import { isPathInside } from "@leitwerk-dev/process-sdk";
import {
	type ComponentCheckoutPlan,
	type ComponentManifest,
	type ComponentManifestEntry,
	deserializeManifest,
	diffManifest,
	type ManifestDiff,
	serializeManifest,
} from "./manifest.js";
import { aggregateAgentsMd, collectSkills } from "./resource-aggregator.js";

/** @internal */
export interface GitOps {
	/** @internal */
	clone(repoLocator: string, targetDir: string): Promise<void>;
	/** @internal */
	checkout(repoDir: string, branch: string): Promise<void>;
	/** Refuse dirty worktrees and pin an exact commit. @internal */
	checkoutRevision?(repoDir: string, revision: string, preserveSubmodules?: boolean): Promise<void>;
	/** @internal */
	createBranch(repoDir: string, branchName: string, startPoint: string): Promise<void>;
	/** @internal */
	branchExists(repoDir: string, branchName: string): Promise<boolean>;
	/** @internal */
	getHeadSha(repoDir: string): Promise<string>;
	/** @internal */
	readFile(repoDir: string, filePath: string): Promise<string | null>;
	/** @internal */
	listFiles(repoDir: string, pattern: string): Promise<string[]>;
	/** @internal */
	listSubmodulePaths?(repoDir: string): Promise<string[]>;
	/** @internal */
	prepareSubmodules?(
		projectKey: string,
		repoDir: string,
		signal?: AbortSignal,
	): Promise<string | undefined>;
}

/** @internal */
export type RunRootGitOps = GitOps & {
	/** @internal */
	writeFile(repoDir: string, filePath: string, content: string): Promise<void>;
	/** @internal */
	configureRepositoryCredentials?(
		credentials: readonly import("@leitwerk-dev/worker-protocol").WorkerRepositoryCredential[],
	): void;
	/** @internal */
	cleanupRepositoryCredentials?(): void;
};

export interface RunRootPlan {
	workspaceRoot: string;
	instanceId: string;
	components: ComponentCheckoutPlan[];
	submodules?: { signal?: AbortSignal };
}

export interface MaterializeResult {
	manifest: ComponentManifest;
	aggregatedAgentsMdSources: string[];
	loadedSkills: string[];
	submoduleWarnings?: string[];
}

export interface ValidationResult {
	valid: boolean;
	diff: ManifestDiff;
	existingManifest: ComponentManifest | null;
}

export class RunRootPreparationError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(`Workspace preparation failed: ${errors.join("; ")}`);
		this.name = "RunRootPreparationError";
		this.errors = [...errors];
	}
}

const MANIFEST_REL = path.join(".leitwerk", "components.json");
const AGGREGATED_AGENTS_REL = "AGENTS.md";
const SKILLS_DIR_REL = path.join(".leitwerk", "skills");

const SKILL_GLOB = "**/.cursor/skills/**/SKILL.md";
const AGENTS_GLOB = "**/AGENTS.md";

function componentDir(workspaceRoot: string, childPath: string): string {
	const root = path.resolve(workspaceRoot);
	const target = path.resolve(root, childPath);
	if (!isPathInside(root, target)) {
		throw new Error(`Component key '${childPath}' resolves outside workspace root '${root}'`);
	}
	return target;
}

function skillIdFromSkillPath(filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	const m = normalized.match(/\.cursor\/skills\/([^/]+)\/SKILL\.md$/);
	return m?.[1] ?? null;
}

export function planRunRoot(
	workspaceRoot: string,
	instanceId: string,
	projectSnapshots: ComponentCheckoutPlan[],
	submodules?: RunRootPlan["submodules"],
): RunRootPlan {
	return {
		workspaceRoot,
		instanceId,
		components: projectSnapshots.map((p) => ({ ...p })),
		...(submodules ? { submodules } : {}),
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
	if (!(await git.branchExists(dir, comp.workBranch))) {
		await git.createBranch(dir, comp.workBranch, comp.baseBranch);
	}
	await git.checkout(dir, comp.workBranch);
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
	reusable = new Map<string, ComponentManifestEntry>(),
	pin?: { projectKey: string; revision: string },
): Promise<ComponentManifestEntry[]> {
	const entries: ComponentManifestEntry[] = [];
	for (const comp of plan.components) {
		try {
			const entry = reusable.get(comp.key) ?? (await materializeComponentEntry(plan, comp, git));
			const revision = pin?.projectKey === comp.key ? pin.revision : entry.revision;
			if (revision) {
				if (!git.checkoutRevision) throw new Error("Pinned repository checkout is unavailable");
				const dir = componentDir(plan.workspaceRoot, comp.key);
				await git.checkoutRevision(dir, revision, !!plan.submodules);
				const headSha = await git.getHeadSha(dir);
				if (headSha.toLowerCase() !== revision.toLowerCase())
					throw new Error("Checkout HEAD does not match captured commit");
				entries.push({ ...entry, headSha, revision });
			} else entries.push(entry);
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
		const submodulePaths = plan.submodules ? ((await git.listSubmodulePaths?.(root)) ?? []) : [];
		const belongsToParent = (file: string) => !submodulePaths.some((p) => file.startsWith(`${p}/`));
		const agentPaths = await git.listFiles(root, AGENTS_GLOB);
		const sortedAgentPaths = agentPaths.filter(belongsToParent).sort((a, b) => a.localeCompare(b));
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
		for (const p of skillPaths.filter(belongsToParent)) {
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
): Promise<MaterializeResult> {
	const manifest: ComponentManifest = {
		version: 1,
		instanceId: plan.instanceId,
		createdAt: new Date().toISOString(),
		components: entries,
	};

	const submoduleWarnings: string[] = [];
	if (plan.submodules && errors.length === 0) {
		for (const { key } of entries) {
			const warning = git.prepareSubmodules
				? await git.prepareSubmodules(
						key,
						componentDir(plan.workspaceRoot, key),
						plan.submodules.signal,
					)
				: `Submodule preparation in ${key} is unavailable.`;
			if (warning) submoduleWarnings.push(warning);
		}
	}
	const { aggregatedAgentsMdSources, agentsMd, skillsMap } = await gatherAgentsAndSkills(plan, git);
	const instructions = submoduleWarnings.length
		? `${agentsMd}\n\n## Workspace preparation warnings\n\n${submoduleWarnings.map((warning) => `- ${warning}`).join("\n")}\n`
		: agentsMd;
	const loadedSkills = [...skillsMap.keys()].sort((a, b) => a.localeCompare(b));

	try {
		await writeAggregatedArtifacts(plan, git, manifest, instructions, skillsMap);
	} catch (e) {
		errors.push(`write: ${e instanceof Error ? e.message : String(e)}`);
	}

	const expectedKeys = new Set(plan.components.map((component) => component.key));
	const hasAllExpectedEntries =
		entries.length === expectedKeys.size &&
		[...expectedKeys].every((key) => entries.some((entry) => entry.key === key));
	if (errors.length > 0 || !hasAllExpectedEntries) {
		throw new RunRootPreparationError(errors);
	}
	return {
		manifest,
		aggregatedAgentsMdSources,
		loadedSkills,
		...(submoduleWarnings.length ? { submoduleWarnings } : {}),
	};
}

export async function materializeRunRoot(
	plan: RunRootPlan,
	git: RunRootGitOps,
): Promise<MaterializeResult> {
	const errors: string[] = [];
	const entries = await collectMaterializedEntries(plan, git, errors);
	return finalizeRunRoot(plan, git, entries, errors);
}

/** @internal */
export async function prepareOnDemandRunRoot(
	plan: RunRootPlan,
	git: RunRootGitOps,
	projectKey?: string,
	revision?: string,
): Promise<MaterializeResult> {
	if (revision !== undefined && (!projectKey || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)))
		throw new Error("Use a captured full commit SHA");
	if (
		projectKey !== undefined &&
		!plan.components.some((component) => component.key === projectKey)
	)
		throw new Error("Repository is outside this process's authorized scope");
	const validation = await validateRunRoot(plan.workspaceRoot, plan.components, git);
	const existingKeys = new Set(
		validation.existingManifest?.components.map((component) => component.key) ?? [],
	);
	const selected = {
		...plan,
		components: plan.components.filter(
			(component) => existingKeys.has(component.key) || component.key === projectKey,
		),
	};
	// Selection only omits missing components, so retained entries keep the same validation.
	return repairRunRoot(
		validation,
		selected,
		git,
		projectKey && revision ? { projectKey, revision } : undefined,
	);
}

export async function validateRunRoot(
	workspaceRoot: string,
	serverProjects: ComponentCheckoutPlan[],
	git: GitOps,
): Promise<ValidationResult> {
	const raw = await git.readFile(workspaceRoot, MANIFEST_REL);
	const parsed = raw === null ? null : deserializeManifest(raw);
	if (!parsed?.ok) {
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
	validation: ValidationResult,
	plan: RunRootPlan,
	git: RunRootGitOps,
	pin?: { projectKey: string; revision: string },
): Promise<MaterializeResult> {
	const errors: string[] = [];
	const reusable = new Map(
		validation.existingManifest?.components
			.filter((component) => validation.diff.unchanged.includes(component.key))
			.map((component) => [component.key, component]),
	);
	const manifestEntries = await collectMaterializedEntries(plan, git, errors, reusable, pin);

	return finalizeRunRoot(plan, git, manifestEntries, errors);
}
