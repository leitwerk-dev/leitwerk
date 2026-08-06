import { parseRepoLocator, trimString } from "@leitwerk-dev/domain";
import type {
	Codec,
	LauncherValidationError,
	ProcessLaunchConfig,
	ProcessLauncherDefinition,
	UiLauncherDefinition,
} from "@leitwerk-dev/process-sdk";

export type RepositoryChangeLaunchKind = "requested_change" | "imported_plan";

export interface RepositoryChangeParamsBase {
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	prompt: string;
	launchKind: RepositoryChangeLaunchKind;
	importedPlanMarkdown?: string;
}

export type RepositoryChangeLaunchParams<TExtra extends object = Record<never, never>> = TExtra &
	Omit<RepositoryChangeParamsBase, "launchKind" | "importedPlanMarkdown"> &
	(
		| { launchKind: "requested_change" }
		| { launchKind: "imported_plan"; importedPlanMarkdown: string }
	);

export interface NormalizedRepositoryChangeParamsInput {
	launchKind: string;
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	prompt: string;
	importedPlanMarkdown: string;
}

export function repositoryChangeParamsRecord(
	value: unknown,
	displayName: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${displayName} params must be an object`);
	}
	return value as Record<string, unknown>;
}

export function normalizeRepositoryChangeParamsInput(
	value: unknown,
	displayName: string,
): NormalizedRepositoryChangeParamsInput {
	const record = repositoryChangeParamsRecord(value, displayName);
	const rawRepoLocator = trimString(record.repoLocator);
	return {
		launchKind: trimString(record.launchKind),
		repoLocator: parseRepoLocator(rawRepoLocator)?.value ?? rawRepoLocator,
		baseBranch: trimString(record.baseBranch) || "main",
		workBranch: trimString(record.workBranch),
		prompt: trimString(record.prompt),
		importedPlanMarkdown: trimString(record.importedPlanMarkdown),
	};
}

export function createRepositoryChangeParamsCodec<T extends RepositoryChangeParamsBase>(input: {
	displayName: string;
	normalize(
		value: unknown,
	): NormalizedRepositoryChangeParamsInput & Omit<T, keyof RepositoryChangeParamsBase>;
}): Codec<T> {
	return {
		parse(value) {
			const { importedPlanMarkdown, ...shared } = input.normalize(value);
			if (shared.launchKind === "requested_change") return shared as T;
			if (shared.launchKind === "imported_plan") {
				return { ...shared, launchKind: shared.launchKind, importedPlanMarkdown } as T;
			}
			throw new Error(`${input.displayName} params require a valid launchKind`);
		},
		serialize: (value) => value,
	};
}

export interface RepositoryChangeLaunchPlannerInput {
	input: Record<string, unknown>;
	metadata?: Record<string, unknown> | null;
}

export type RepositoryChangeLaunchResolution<T extends RepositoryChangeParamsBase> =
	| { ok: true; launchConfig: ProcessLaunchConfig<T> }
	| { ok: false; errors: readonly LauncherValidationError[] };

export interface RepositoryChangeLaunchPlanner<T extends RepositoryChangeParamsBase> {
	plan(input: RepositoryChangeLaunchPlannerInput): RepositoryChangeLaunchResolution<T>;
}

export function formatRepositoryChangeLaunchErrors(
	errors: readonly LauncherValidationError[],
): string {
	return errors.map((error) => `${error.fieldId ?? "launch"}: ${error.message}`).join("; ");
}

export function createRepositoryChangeLaunchPlanner<T extends RepositoryChangeParamsBase>(config: {
	processId: string;
	normalize(input: Record<string, unknown>): T & { importedPlanMarkdown?: string };
	validateRepoLocator(repoLocator: string): string | null;
	validate?(input: Record<string, unknown>, params: T): readonly LauncherValidationError[];
	prepare?(params: T): T;
	deferWithoutWorkBranch?: boolean;
}): RepositoryChangeLaunchPlanner<T> {
	return {
		plan({ input, metadata }) {
			const params = config.normalize(input);
			const errors: LauncherValidationError[] = [];
			if (params.launchKind !== "requested_change" && params.launchKind !== "imported_plan") {
				errors.push({
					code: "custom_rule",
					fieldId: "launchKind",
					message: "launchKind must be requested_change or imported_plan",
				});
			}
			const locatorError = config.validateRepoLocator(params.repoLocator);
			if (locatorError) {
				errors.push({
					code: "invalid_repo_locator",
					fieldId: "repoLocator",
					message: locatorError,
				});
			}
			if (params.workBranch && params.workBranch === params.baseBranch) {
				errors.push({
					code: "custom_rule",
					fieldId: "workBranch",
					message: "workBranch cannot match baseBranch",
				});
			}
			if (!params.prompt) {
				errors.push({ code: "required", fieldId: "prompt", message: "prompt is required" });
			}
			if (params.launchKind === "imported_plan" && !params.importedPlanMarkdown) {
				errors.push({
					code: "required",
					fieldId: "importedPlanMarkdown",
					message: "importedPlanMarkdown is required for imported_plan launches",
				});
			}
			if (params.launchKind === "requested_change" && "importedPlanMarkdown" in input) {
				errors.push({
					code: "custom_rule",
					fieldId: "importedPlanMarkdown",
					message: "importedPlanMarkdown is not allowed for requested_change launches",
				});
			}
			errors.push(...(config.validate?.(input, params) ?? []));
			if (errors.length > 0) return { ok: false, errors };

			const prepared = config.prepare?.(params) ?? params;
			const hasWorkBranch = prepared.workBranch !== "";
			return {
				ok: true,
				launchConfig: {
					processId: config.processId,
					params: prepared,
					startTurnId:
						config.deferWithoutWorkBranch && !hasWorkBranch
							? null
							: prepared.launchKind === "imported_plan"
								? "import_plan"
								: "generate_plan",
					titleSourceFields: [{ label: "Requested change", value: prepared.prompt }],
					metadata: metadata ?? null,
					projects: [
						{
							key: "repo",
							repoLocator: prepared.repoLocator,
							baseBranch: prepared.baseBranch,
							workBranch: hasWorkBranch ? prepared.workBranch : null,
						},
					],
				},
			};
		},
	};
}

export function createRepositoryChangeUiLauncher<T extends RepositoryChangeParamsBase>(config: {
	id: string;
	formId: string;
	title: string;
	workBranchDescription: string;
	sshCredentials?: boolean;
	resolveRelaunchInput?: UiLauncherDefinition<T>["resolveRelaunchInput"];
	resolveLaunchConfig: UiLauncherDefinition<T>["resolveLaunchConfig"];
}): ProcessLauncherDefinition<T> {
	return {
		id: config.id,
		label: config.title,
		description: "Plan, implement, review, and finalize a change in a single git repository",
		visibility: "ui",
		ui: {
			card: {
				title: config.title,
				description:
					"Run a plan → implement → review → finalize loop against any local or remote git repository.",
			},
			launchConfigSchema: {
				id: config.formId,
				title: config.title,
				fields: [
					{
						id: "repoLocator",
						label: "Repository path or URL",
						kind: "text",
						required: true,
						placeholder: "/path/to/repo or https://git.example.com/team/repo.git",
						description: "Use a local checkout path or a remote Git URL.",
						rememberRecentValues: true,
					},
					...(config.sshCredentials
						? [
								{
									id: "sshCredentialRef",
									label: "SSH credential profile",
									kind: "text" as const,
									required: true,
									placeholder: "default",
									description: "Profile from extensions.git-ssh.credentials.",
								},
							]
						: []),
					{
						id: "baseBranch",
						label: "Base branch",
						kind: "text",
						placeholder: "main",
						description: "Leave this as main unless the change should merge somewhere else.",
					},
					{
						id: "workBranch",
						label: "Work branch",
						kind: "text",
						placeholder: "feature/my-change",
						description: config.workBranchDescription,
					},
					{
						id: "prompt",
						label: "Requested change",
						kind: "textarea",
						required: true,
						placeholder: "Describe the change this process should plan, implement, and review.",
					},
				],
				submitLabel: "Start change",
			},
			resolveDefaults: () => ({
				repoLocator: "",
				...(config.sshCredentials ? { sshCredentialRef: "default" } : {}),
				baseBranch: "main",
				workBranch: "",
				prompt: "",
			}),
			resolveRelaunchInput: config.resolveRelaunchInput,
			resolveLaunchConfig: config.resolveLaunchConfig,
		},
	};
}
