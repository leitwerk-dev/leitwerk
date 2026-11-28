import path from "node:path";
import { isPathInside } from "@leitwerk-dev/process-sdk";
import {
	type ComponentCheckoutPlan,
	type ComponentManifest,
	type ComponentManifestEntry,
	deserializeManifest,
	serializeManifest,
} from "./manifest.js";
import { aggregateAgentsMd, collectSkills } from "./resource-aggregator.js";

/** @internal */
export interface GitOps {
	/** @internal */
	clone(repoLocator: string, targetDir: string): Promise<void>;
	/** @internal */
	checkout(repoDir: string, branch: string): Promise<void>;
	/** Refuse dirty worktrees, pin an exact commit, and return the verified SHA. @internal */
	checkoutRevision?(
		repoDir: string,
		revision: string,
		preserveSubmodules?: boolean,
	): Promise<string>;
	/** @internal */
	createBranch(repoDir: string, branchName: string, startPoint: string): Promise<void>;
	/** @internal */
	branchExists(repoDir: string, branchName: string): Promise<boolean>;
	/** @internal */
	getHeadSha(repoDir: string): Promise<string>;
	/** @internal */
	readFile(repoDir: string, filePath: string): Promise<string | null>;
	/** @internal */
	listFiles(repoDir: string, patterns: string[], excludeSubmodules?: boolean): Promise<string[]>;
	/** @internal */
	prepareSubmodules(
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
	existing?: ReadonlyMap<string, ComponentManifestEntry>,
	pin?: { projectKey: string; revision: string },
): Promise<ComponentManifestEntry[]> {
	const entries: ComponentManifestEntry[] = [];
	for (const comp of plan.components) {
		try {
			const retained = existing?.get(comp.key);
			const entry =
				retained?.repoLocator === comp.repoLocator &&
				retained.baseBranch === comp.baseBranch &&
				retained.workBranch === comp.workBranch
					? retained
					: await materializeComponentEntry(plan, comp, git);
			const revision = pin?.projectKey === comp.key ? pin.revision : entry.revision;
			if (revision) {
				if (!git.checkoutRevision) throw new Error("Pinned repository checkout is unavailable");
				const dir = componentDir(plan.workspaceRoot, comp.key);
				const headSha = await git.checkoutRevision(dir, revision, !!plan.submodules);
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
	for (const comp of plan.components) {
		const root = componentDir(plan.workspaceRoot, comp.key);
		for (const p of await git.listFiles(root, [AGENTS_GLOB, SKILL_GLOB], !!plan.submodules)) {
			const content = await git.readFile(root, p);
			if (content === null) continue;
			if (path.posix.basename(p) === "AGENTS.md") {
				agentSources.push({ componentKey: comp.key, filePath: p, content });
			} else {
				const skillId = skillIdFromSkillPath(p);
				if (skillId) skillSources.push({ componentKey: comp.key, skillId, content });
			}
		}
	}

	const agentsMd = aggregateAgentsMd(agentSources);
	const skillsMap = collectSkills(skillSources);
	const aggregatedAgentsMdSources = agentSources
		.map(({ componentKey, filePath }) => `${componentKey}/${filePath}`)
		.sort((a, b) => a.localeCompare(b));
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
			const dir = componentDir(plan.workspaceRoot, key);
			const warning = await git.prepareSubmodules(key, dir, plan.submodules.signal);
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
	const existing = await readManifestEntries(plan.workspaceRoot, git);
	const selected = {
		...plan,
		components: plan.components.filter(
			(component) => existing.has(component.key) || component.key === projectKey,
		),
	};
	const pin = projectKey && revision ? { projectKey, revision } : undefined;
	return materializeSelection(selected, git, existing, pin);
}

async function readManifestEntries(workspaceRoot: string, git: GitOps) {
	const raw = await git.readFile(workspaceRoot, MANIFEST_REL);
	const parsed = raw === null ? null : deserializeManifest(raw);
	return new Map(parsed?.ok ? parsed.manifest.components.map((entry) => [entry.key, entry]) : []);
}

export async function materializeRunRoot(plan: RunRootPlan, git: RunRootGitOps, resume = false) {
	return materializeSelection(
		plan,
		git,
		resume ? await readManifestEntries(plan.workspaceRoot, git) : undefined,
	);
}

async function materializeSelection(
	plan: RunRootPlan,
	git: RunRootGitOps,
	existing?: ReadonlyMap<string, ComponentManifestEntry>,
	pin?: { projectKey: string; revision: string },
): Promise<MaterializeResult> {
	const errors: string[] = [];
	const entries = await collectMaterializedEntries(plan, git, errors, existing, pin);
	return finalizeRunRoot(plan, git, entries, errors);
}
