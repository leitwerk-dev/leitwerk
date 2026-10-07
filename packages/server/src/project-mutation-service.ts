import type { ProcessProject } from "@leitwerk-dev/domain";
import type { DurableWsFrameInput } from "@leitwerk-dev/protocol";
import type {
	CreateProcessProjectInput,
	RepositoryBundle,
	UpdateProcessProjectInput,
} from "./db/repositories.js";
import type { PostCommitEffect } from "./effects/post-commit-effect.js";
import { runPostCommitEffectList } from "./effects/post-commit-runner.js";
import type { Broadcaster } from "./ws/broadcast.js";

/** @internal */
export type ProjectUpdatedFrameInput = Extract<DurableWsFrameInput, { type: "project.updated" }>;

/** @internal */
export interface ProjectMutationCommit {
	/** @internal */
	project: ProcessProject | null;
	/** @internal */
	effects: PostCommitEffect[];
}

/** @internal */
export interface ProjectMutationService {
	/** @internal */
	create(input: CreateProcessProjectInput): ProcessProject;
	/** @internal */
	update(id: string, input: UpdateProcessProjectInput): ProcessProject | null;
	/** @internal */
	getById(id: string): ProcessProject | null;
	/** @internal */
	getByInstanceAndKey(instanceId: string, key: string): ProcessProject | null;
	/** @internal */
	listByInstance(instanceId: string): ProcessProject[];
}

/** @internal */
export interface ProjectMutationServiceDeps
	extends Pick<RepositoryBundle, "projects" | "transaction"> {
	/** @internal */
	broadcaster: Broadcaster;
	/** @internal */
	onProjectMutated?: (project: ProcessProject) => void;
}

/** @internal */
export function buildProjectUpdatedFrame(project: ProcessProject): ProjectUpdatedFrameInput {
	return {
		type: "project.updated",
		payload: {
			projectId: project.key,
			project: {
				key: project.key,
				repoLocator: project.repoLocator,
				repoLocatorKind: project.repoLocatorKind,
				branch: project.workBranch ?? project.baseBranch,
				baseBranch: project.baseBranch,
				workBranch: project.workBranch,
				externalId: project.externalId,
				externalUrl: project.externalUrl,
				pipelineStatus: project.pipelineStatus,
			},
		},
		instanceId: project.instanceId,
	};
}

/** @internal */
export function buildProjectUpdatedEffect(project: ProcessProject): PostCommitEffect {
	return { kind: "broadcast", frame: buildProjectUpdatedFrame(project) };
}

/** @internal */
export function commitProjectCreate(
	deps: Pick<RepositoryBundle, "projects">,
	input: CreateProcessProjectInput,
): ProjectMutationCommit & {
	/** @internal */
	project: ProcessProject;
} {
	const project = deps.projects.create(input);
	return { project, effects: [buildProjectUpdatedEffect(project)] };
}

/** @internal */
export function commitProjectUpdate(
	deps: Pick<RepositoryBundle, "projects">,
	id: string,
	input: UpdateProcessProjectInput,
): ProjectMutationCommit {
	const project = deps.projects.update(id, input);
	return { project, effects: project ? [buildProjectUpdatedEffect(project)] : [] };
}

function runProjectMutationPostCommitEffects(
	deps: Pick<ProjectMutationServiceDeps, "broadcaster">,
	effects: readonly PostCommitEffect[],
): void {
	if (effects.length === 0) {
		return;
	}
	void runPostCommitEffectList(
		{
			broadcaster: deps.broadcaster,
			getSupervisor: () => undefined,
		},
		effects,
	);
}

/** @internal */
export function createProjectMutationService(
	deps: ProjectMutationServiceDeps,
): ProjectMutationService {
	return {
		create(input) {
			const commit = deps.transaction((repos) => commitProjectCreate(repos, input));
			runProjectMutationPostCommitEffects(deps, commit.effects);
			deps.onProjectMutated?.(commit.project);
			return commit.project;
		},

		update(id, input) {
			const commit = deps.transaction((repos) => commitProjectUpdate(repos, id, input));
			runProjectMutationPostCommitEffects(deps, commit.effects);
			if (commit.project) deps.onProjectMutated?.(commit.project);
			return commit.project;
		},

		getById(id) {
			return deps.projects.getById(id);
		},

		getByInstanceAndKey(instanceId, key) {
			return deps.projects.getByInstanceAndKey(instanceId, key);
		},

		listByInstance(instanceId) {
			return deps.projects.listByInstance(instanceId);
		},
	};
}
