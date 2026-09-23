import { trimString } from "@leitwerk-dev/domain";
import type {
	LauncherValidationError,
	ProcessLaunchConfig,
	ProcessLauncherDefinition,
} from "@leitwerk-dev/process-sdk";
import { buildAutoWorkBranchFromSeed } from "./auto-work-branch.js";

/** Shared UI mechanics; providers retain credentials, preparation and launch metadata. @internal */
export function createRepositoryChangeUiLauncher<
	P,
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
	assertConfigured(): void;
	/** @internal */
	profiles(): readonly string[];
	/** @internal */
	repositories(profile: string): Promise<readonly R[]>;
	/** @internal */
	resolveProfiles(profile: string): B;
	/** @internal */
	resolveGitIdentity(profile: string): Promise<I>;
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
	launchConfig(params: P, title: string, identity: I): ProcessLaunchConfig<P>;
	/** @internal */
	preparationChecks: NonNullable<ProcessLauncherDefinition<P>["ui"]>["preparationChecks"];
}): ProcessLauncherDefinition<P> {
	const { provider, providerId } = options;
	const profileField = `${providerId}Profile`;
	function validationError(
		fieldId: string,
		message: string,
		code: LauncherValidationError["code"] = "required",
	): LauncherValidationError {
		return { code, fieldId, message };
	}
	return {
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
				return { [profileField]: options.profiles()[0] ?? "", repository: "", prompt: "" };
			},
			async resolveOptions(input) {
				const profile = trimString(input[profileField]);
				return {
					[profileField]: options.profiles().map((value) => ({ value, label: value })),
					repository: (await options.repositories(profile)).map((repository) => ({
						value: repository.full_name,
						label: repository.full_name,
						description: repository.html_url,
					})),
				};
			},
			preparationChecks: options.preparationChecks,
			resolveRelaunchInput(input) {
				return {
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
				options.assertConfigured();
				if (!profile) errors.push(validationError(profileField, `${provider} profile is required`));
				else if (!options.profiles().includes(profile))
					errors.push(
						validationError(profileField, `${provider} profile is not available`, "custom_rule"),
					);
				if (!repositoryName) errors.push(validationError("repository", "Repository is required"));
				if (!prompt) errors.push(validationError("prompt", "Requested change is required"));
				if (errors.length > 0) return { ok: false, errors };
				const repository = (await options.repositories(profile)).find(
					(candidate) => candidate.full_name === repositoryName,
				);
				if (!repository)
					return invalid(
						"repository",
						`Repository is not available to the selected ${provider} profile`,
					);
				let binding: B;
				try {
					binding = options.resolveProfiles(profile);
				} catch (error) {
					return invalid(profileField, (error as Error).message);
				}
				const identity = await options.resolveGitIdentity(profile);
				const workBranch = buildAutoWorkBranchFromSeed(
					prompt,
					`${repository.ssh_url}:${repository.default_branch}`,
				);
				const params = options.params(repository, { ...binding, profile, prompt, workBranch });
				return { ok: true, launchConfig: options.launchConfig(params, prompt, identity) };
			},
		},
	};
}
