import { trimString } from "@leitwerk-dev/domain";
import {
	type LauncherValidationError,
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	type ProcessLauncherDefinition,
	type RepositoryIssue,
	type RepositoryIssueWatcherConfig,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import { buildAutoWorkBranchFromSeed } from "./auto-work-branch.js";
import {
	type RepositoryChangeLaunchParams,
	type RepositoryIssueOriginParams,
	type RepositoryUiOriginParams,
	repositoryChangeOptionFields,
	repositoryChangeOptions,
	repositoryChangeWorkflow,
} from "./repository-change-launch-internal.js";

/** Shared launch mechanics; providers retain credentials, preparation and launch metadata. @internal */
export function createRepositoryChangeLauncher<
	P extends RepositoryChangeLaunchParams<{
		/** @internal */ owner: string;
		/** @internal */ repo: string;
	}> &
		(RepositoryIssueOriginParams | RepositoryUiOriginParams),
	D,
	R extends {
		/** @internal */
		full_name: string;
		/** @internal */
		html_url: string;
		/** @internal */
		ssh_url: string;
		/** @internal */
		default_branch: string;
	},
	B,
	I,
>(options: {
	/** @internal */
	id: string;
	/** @internal */
	provider: string;
	/** @internal */
	providerId: string;
	/** @internal */
	integration(dependencies: D): {
		/** @internal */ profiles?(): readonly string[];
		/** @internal */ client(profile: string): {
			/** @internal */ listRepositories(): Promise<readonly R[]>;
			/** @internal */ resolveGitIdentity(profile: string): Promise<I>;
			/** @internal */ getIssue(
				owner: string,
				repo: string,
				number: number,
			): Promise<Pick<RepositoryIssue, "html_url" | "labels">>;
		};
	};
	/** @internal */
	profile(params: P): string;
	/** @internal */
	resolveProfiles(profile: string, dependencies: D): B;
	/** @internal */
	params(
		repository: R,
		input: B & {
			/** @internal */
			profile: string;
			/** @internal */
			prompt: string;
			/** @internal */
			workBranch: string;
		},
	): P;
	/** @internal */
	launchConfig(
		params: P,
		title: string,
		identity: I,
		repository: NoInfer<R>,
	): ProcessLaunchConfig<P>;
	/** @internal */
	preparationChecks(params: P, dependencies: () => D): readonly LaunchPreparationCheck<P>[];
}) {
	const { provider, providerId } = options;
	const profileField = `${providerId}Profile`;
	let dependencies: D | null = null;
	function requireDependencies(): D {
		if (!dependencies) throw new Error(`${provider} repository launcher is not configured`);
		return dependencies;
	}
	const integration = () => options.integration(requireDependencies());
	const profiles = () => integration().profiles?.() ?? [];
	async function repositories(profile: string): Promise<readonly R[]> {
		return profile && profiles().includes(profile)
			? integration().client(profile).listRepositories()
			: [];
	}
	/** @internal */
	function resolveProfiles(profile: string) {
		if (!profiles().includes(profile)) throw new Error(`${provider} profile is not available`);
		return options.resolveProfiles(profile, requireDependencies());
	}
	/** @internal */
	async function resolveGitIdentity(profile: string): Promise<I> {
		if (!profile) throw new Error(`A ${provider} profile is required to resolve Git identity`);
		return integration().client(profile).resolveGitIdentity(profile);
	}
	/** @internal */
	function preparationChecks(
		_input: unknown,
		{ params }: ProcessLaunchConfig<P>,
	): LaunchPreparationCheck<P>[] {
		return [
			{
				id: "repository_visibility",
				label: "Check repository visibility",
				async run({ signal }) {
					signal.throwIfAborted();
					const visible = (await repositories(options.profile(params))).some(
						(candidate) => candidate.full_name === `${params.owner}/${params.repo}`,
					);
					signal.throwIfAborted();
					if (!visible)
						throw new SafeLaunchPreparationError(
							"Repository is not visible",
							`Grant the selected ${provider} profile access to the repository, then try again.`,
						);
				},
			},
			...options.preparationChecks(params, requireDependencies),
		];
	}
	function validationError(
		fieldId: string,
		message: string,
		code: LauncherValidationError["code"] = "required",
	): LauncherValidationError {
		return { code, fieldId, message };
	}
	const launcher: ProcessLauncherDefinition<P> & {
		/** @internal */
		resolveIssueLaunchConfig(event: {
			/** @internal */ profile: string;
			/** @internal */ repository: R;
			/** @internal */ issue: Pick<RepositoryIssue, "number" | "title" | "body" | "html_url">;
			/** @internal */ labels: RepositoryIssueWatcherConfig["labels"];
		}): Promise<ProcessLaunchConfig<P>>;
	} = {
		async resolveIssueLaunchConfig({ profile, repository, issue, labels }) {
			const title = issue.title.trim();
			const body = issue.body?.trim() ?? "";
			const binding = resolveProfiles(profile);
			const identity = await resolveGitIdentity(profile);
			return options.launchConfig(
				{
					...options.params(repository, {
						...binding,
						profile,
						workBranch: `leitwerk/issue-${issue.number}`,
						prompt: `${title}${body ? `\n\n${body}` : ""}`,
					}),
					origin: "issue",
					issueNumber: issue.number,
					issueUrl: issue.html_url,
					triggerLabel: labels.trigger,
					doneLabel: labels.done,
				},
				title,
				identity,
				repository,
			);
		},
		id: options.id,
		label: `${provider} Repo Change`,
		description: `Plan, implement, review, and publish a ${provider} change without a source issue`,
		visibility: "ui",
		ui: {
			card: {
				title: `${provider} Repo Change`,
				description: `Start a repository change and publish it as a ${provider} pull request.`,
			},
			launchConfigSchema: {
				id: `${providerId}_repo_change_form`,
				title: `${provider} Repo Change`,
				fields: [
					...repositoryChangeOptionFields,
					{
						id: profileField,
						label: `${provider} profile`,
						kind: "select",
						required: true,
						description: `${provider} profile with server-configured CI and Git SSH access.`,
					},
					{
						id: "repository",
						label: "Repository",
						kind: "select",
						required: true,
						description: `Repository visible to the selected ${provider} profile.`,
					},
					{
						id: "prompt",
						label: "Requested change",
						kind: "textarea",
						required: true,
						placeholder: "Describe the change to plan, implement, review, and publish.",
					},
				],
				submitLabel: "Start change",
			},
			resolveDefaults() {
				return {
					[profileField]: profiles()[0] ?? "",
					repository: "",
					prompt: "",
					...repositoryChangeOptions({}),
				};
			},
			async resolveOptions(input) {
				const profile = trimString(input[profileField]);
				return {
					[profileField]: profiles().map((value) => ({ value, label: value })),
					repository: (await repositories(profile)).map((repository) => ({
						value: repository.full_name,
						label: repository.full_name,
						description: repository.html_url,
					})),
				};
			},
			preparationChecks,
			resolveRelaunchInput(input) {
				return {
					...repositoryChangeOptions(input),
					[profileField]: trimString(input[profileField]),
					repository: trimString(input.repository),
					prompt: trimString(input.prompt),
				};
			},
			async resolveLaunchConfig(input) {
				const profile = trimString(input[profileField]);
				const repositoryName = trimString(input.repository);
				const prompt = trimString(input.prompt);
				const errors: LauncherValidationError[] = [];
				const invalid = (fieldId: string, message: string) => ({
					ok: false as const,
					errors: [validationError(fieldId, message, "custom_rule")],
				});
				requireDependencies();
				if (!profile) errors.push(validationError(profileField, `${provider} profile is required`));
				else if (!profiles().includes(profile))
					errors.push(
						validationError(profileField, `${provider} profile is not available`, "custom_rule"),
					);
				if (!repositoryName) errors.push(validationError("repository", "Repository is required"));
				if (!prompt) errors.push(validationError("prompt", "Requested change is required"));
				if (errors.length > 0) return { ok: false, errors };
				const repository = (await repositories(profile)).find(
					(candidate) => candidate.full_name === repositoryName,
				);
				if (!repository)
					return invalid(
						"repository",
						`Repository is not available to the selected ${provider} profile`,
					);
				let binding: B;
				try {
					binding = resolveProfiles(profile);
				} catch (error) {
					return invalid(profileField, (error as Error).message);
				}
				const identity = await resolveGitIdentity(profile);
				const workBranch = buildAutoWorkBranchFromSeed(
					prompt,
					`${repository.ssh_url}:${repository.default_branch}`,
				);
				const params = {
					...options.params(repository, { ...binding, profile, prompt, workBranch }),
					...repositoryChangeOptions(input),
				};
				return {
					ok: true,
					launchConfig: options.launchConfig(params, prompt, identity, repository),
				};
			},
		},
	};
	return {
		/** @internal */ configure(value: D | null) {
			dependencies = value;
		},
		/** @internal */ preparationChecks,
		/** @internal */ resolveProfiles,
		/** @internal */ resolveGitIdentity,
		/** @internal */ launcher,
		/** @internal */ workflow: repositoryChangeWorkflow(async (params: P) => {
			if (params.origin !== "issue") throw new Error(`Missing ${provider} source issue`);
			const issue = await integration()
				.client(options.profile(params))
				.getIssue(params.owner, params.repo, params.issueNumber);
			if (issue.html_url !== params.issueUrl)
				throw new Error(`${provider} source issue installation changed`);
			return issue.labels.map((label) => label.name);
		}),
	};
}
