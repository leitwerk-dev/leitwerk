import type { ProcessInstance } from "@leitwerk-dev/domain";
import type {
	ExtensionProcessDefinition,
	ProcessLaunchProjectConfig,
	RepositoryCredentialProject,
	RepositoryCredentialProvider,
	RepositoryCredentialRegistrar,
	RepositoryCredentialRequirement,
} from "@leitwerk-dev/process-sdk";
import type { WorkerGitSshCredential } from "@leitwerk-dev/worker-protocol";

/** Server-owned provider registry and process credential resolver. */
export class RepositoryCredentialService implements RepositoryCredentialRegistrar {
	readonly #providers = new Map<string, RepositoryCredentialProvider>();

	constructor(
		private readonly processDefinitions: ReadonlyMap<string, ExtensionProcessDefinition>,
	) {}

	register(provider: RepositoryCredentialProvider): void {
		if (this.#providers.has(provider.kind)) {
			throw new Error(
				`Repository credential provider '${provider.kind}' is registered more than once`,
			);
		}
		this.#providers.set(provider.kind, provider);
	}

	private resolve(
		requirements: readonly RepositoryCredentialRequirement[],
	): WorkerGitSshCredential[] {
		const seen = new Set<string>();
		return requirements.map((requirement) => {
			const correlation = `${requirement.projectKey}:${requirement.kind}`;
			if (seen.has(correlation)) {
				throw new Error(
					`Duplicate repository credential requirement for project '${requirement.projectKey}'`,
				);
			}
			seen.add(correlation);
			if (!requirement.credentialRef.trim()) {
				throw new Error(
					`Repository credential reference for project '${requirement.projectKey}' is blank`,
				);
			}
			const material = this.#providers.get(requirement.kind)?.resolve(requirement.credentialRef);
			if (!material) {
				throw new Error(
					`Unknown ${requirement.kind} repository credential '${requirement.credentialRef}'`,
				);
			}
			return { ...requirement, ...material };
		});
	}

	private resolveFor(
		processId: string,
		paramsJson: string | null,
		projects: readonly RepositoryCredentialProject[],
	): WorkerGitSshCredential[] {
		const definition = this.processDefinitions.get(processId);
		if (!definition?.repositoryCredentials) return [];
		const params = definition.paramsCodec.parse(JSON.parse(paramsJson ?? "{}"));
		return this.resolve(definition.repositoryCredentials({ params, projects }));
	}

	validateLaunch(input: {
		processId: string;
		paramsJson: string | null;
		projects: readonly ProcessLaunchProjectConfig[];
	}): void {
		this.resolveFor(
			input.processId,
			input.paramsJson,
			input.projects.map((project) => ({
				...project,
				workBranch: project.workBranch ?? null,
			})),
		);
	}

	resolveWorkerCredentials(input: {
		process: ProcessInstance;
		projects: readonly RepositoryCredentialProject[];
	}): WorkerGitSshCredential[] {
		return this.resolveFor(input.process.processId, input.process.paramsJson, input.projects);
	}
}
