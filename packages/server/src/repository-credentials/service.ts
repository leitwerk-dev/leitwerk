import type { ProcessInstance } from "@leitwerk-dev/domain";
import type {
	ExtensionProcessDefinition,
	ProcessLaunchProjectConfig,
	RepositoryCredentialProject,
	RepositoryCredentialProvider,
	RepositoryCredentialRegistrar,
	RepositoryCredentialRequirement,
} from "@leitwerk-dev/process-sdk";
import { repositoryHttpsUrl } from "@leitwerk-dev/process-sdk";
import type { WorkerRepositoryCredential } from "@leitwerk-dev/worker-protocol";

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
		projects: readonly RepositoryCredentialProject[],
	): WorkerRepositoryCredential[] {
		const seen = new Set<string>();
		return requirements.map((requirement) => {
			const correlation = requirement.projectKey;
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
			const project = projects.find((project) => project.key === requirement.projectKey);
			if (!project)
				throw new Error(`Unknown repository credential project '${requirement.projectKey}'`);
			const provider = this.#providers.get(requirement.kind);
			if (!provider) {
				throw new Error(
					`Unknown ${requirement.kind} repository credential '${requirement.credentialRef}'`,
				);
			}
			if (provider.kind === "git_https") {
				const material = provider.resolve(requirement.credentialRef);
				if (!material)
					throw new Error(`Unknown git_https repository credential '${requirement.credentialRef}'`);
				const url = repositoryHttpsUrl(project.repoLocator);
				if (
					url.origin !== material.origin ||
					!material.username ||
					!material.password ||
					/[\r\n\0]/.test(material.username + material.password)
				) {
					throw new Error(
						`Invalid HTTPS credential scope or material for project '${project.key}'`,
					);
				}
				return {
					...requirement,
					kind: "git_https",
					repositoryUrl: url.href,
					username: material.username,
					password: material.password,
				};
			}
			const material = provider.resolve(requirement.credentialRef);
			if (!material)
				throw new Error(`Unknown git_ssh repository credential '${requirement.credentialRef}'`);
			return { ...requirement, kind: "git_ssh", ...material };
		});
	}

	private resolveFor(
		processId: string,
		paramsJson: string | null,
		projects: readonly RepositoryCredentialProject[],
	): WorkerRepositoryCredential[] {
		const definition = this.processDefinitions.get(processId);
		if (!definition?.repositoryCredentials) return [];
		const params = definition.paramsCodec.parse(JSON.parse(paramsJson ?? "{}"));
		return this.resolve(definition.repositoryCredentials({ params, projects }), projects);
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
	}): WorkerRepositoryCredential[] {
		return this.resolveFor(input.process.processId, input.process.paramsJson, input.projects);
	}
}
