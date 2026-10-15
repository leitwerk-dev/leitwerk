import { normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	ProcessInstance,
	ResolvedSetting,
	ScopedSettingsSnapshot,
	SettingsContext,
	SettingsOverride,
	SettingsSubject,
} from "@leitwerk-dev/domain";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExecutionPurposeDefinition,
	ProcessLaunchPlan,
	ScopedSettingsResolver,
	SettingDefinition,
	SettingsSubjectInput,
} from "@leitwerk-dev/process-sdk";
import { repositorySettingsIdentity } from "@leitwerk-dev/process-sdk";
import type {
	SettingFieldView,
	SettingsOverviewResponse,
	SettingsPreview,
	SettingsScopesResponse,
} from "@leitwerk-dev/protocol/http-contracts";
import { settingSelectionValues } from "@leitwerk-dev/protocol/http-contracts";
import type { LeitwerkConfig } from "./config/config-types.js";
import type { RepositoryBundle } from "./db/repositories.js";
import type { SettingsWrite } from "./db/scoped-settings-repo.js";

/** @internal */
export class SettingsError extends Error {
	constructor(
		message: string,
		readonly statusCode = 422,
	) {
		super(message);
	}
}

// Do not equate SSH/HTTPS, strip .git, resolve symlinks, or case-fold paths.
/** @internal */
export function normalizeSettingsLocator(locator: string): string {
	const value = locator.trim();
	if (/^(\/|\.\/|\.\.\/|~\/)/.test(value)) return normalize(value);
	try {
		const url = new URL(value);
		if (url.password || ((url.protocol === "https:" || url.protocol === "http:") && url.username))
			throw new SettingsError("Repository settings locators must not contain credentials");
		return url.toString();
	} catch (error) {
		if (error instanceof SettingsError) throw error;
		return value;
	}
}

/** @internal */
type SettingsDraft = Omit<SettingsOverride, "actor" | "createdAt" | "updatedAt">;
/** @internal */
type SettingsChange = Omit<SettingsWrite, "schemaVersion" | "mode"> &
	Partial<Pick<SettingsWrite, "mode">>;
/** @internal */
type SubjectProcess = Pick<ProcessInstance, "id" | "processId" | "metadata">;
/** @internal */
type Project = Pick<
	import("@leitwerk-dev/process-sdk").ProcessLaunchProjectConfig,
	"key" | "repoLocator" | "metadata"
>;

/** @internal */
interface ProcessScopeContext {
	/** @internal */
	context: SettingsContext;
	/** @internal */
	subjects: Array<{
		/** @internal */
		project: Project;
		/** @internal */
		subject: SettingsSubject;
	}>;
	/** @internal */
	explanations: string[];
}
/** @internal */
interface ProcessSettingsPreview {
	/** @internal */
	turnId: string;
	/** @internal */
	settings: ScopedSettingsSnapshot | null;
	/** @internal */
	error: string | null;
}
/** Read-only model references without repository discovery or choice providers. @internal */
export interface ScopedModelReference {
	/** @internal */
	key: string;
	/** @internal */
	label: string;
	/** Null for extension-defined defaults. @internal */
	subjectId: string | null;
	/** @internal */
	modelProfileId: string | null;
	/** Invalid schema, version, or override mode; never includes raw values. @internal */
	invalid: boolean;
}
/** @internal */
export interface ScopedSettingsService extends ScopedSettingsResolver {
	/** @internal */
	modelReferences(): ScopedModelReference[];
	/** @internal */
	capture(
		process: SubjectProcess,
		turnId: string,
		includeModelDefault?: boolean,
	): ScopedSettingsSnapshot | undefined;
	/** @internal */
	modelDefault(
		processId: string,
		turnId: string,
		process?: SubjectProcess,
		plan?: ProcessLaunchPlan,
	): string | null;
	/** @internal */
	preview(subjectId: string, draft?: SettingsDraft): Promise<SettingsPreview>;
	/** @internal */
	choices(subjectId: string, key: string, search?: string): Promise<SettingFieldView["choices"]>;
	/** @internal */
	write(change: SettingsChange): SettingsOverride;
	/** @internal */
	listScopes(): SettingsScopesResponse;
	/** @internal */
	overview(scopeType: string): Promise<SettingsOverviewResponse>;
	/** @internal */
	forProcess(process: SubjectProcess): ProcessScopeContext;
	/** @internal */
	forLaunch(plan: ProcessLaunchPlan): ProcessScopeContext;
	/** @internal */
	previewProcess(process: SubjectProcess): ProcessSettingsPreview[];
	/** @internal */
	definitions(): Array<
		Pick<SettingFieldView, "key" | "owner" | "schemaVersion" | "scopes" | "merge" | "form">
	>;
	/** @internal */
	refresh(): Promise<SettingsScopesResponse>;
	/** @internal */
	previewDraft(change: Omit<SettingsChange, "expectedRevision">): Promise<SettingsPreview>;
}
/** @internal */

export function createScopedSettingsService(input: {
	repos: RepositoryBundle;
	catalog: ExtensionCatalog;
	config: LeitwerkConfig;
	modelChoices?: () => SettingFieldView["choices"];
}): ScopedSettingsService {
	const { repos, catalog } = input;
	const definitions = new Map<string, { owner: string; definition: SettingDefinition }>();
	const purposes = new Map<string, ExecutionPurposeDefinition>();
	const scopes = new Map<string, SettingsScopesResponse["scopes"][number]>([
		["instance", { id: "instance", label: "Instance" }],
		[
			"repository",
			{
				id: "repository",
				label: "Repository",
				overview: { itemLabel: "Repository", itemLabelPlural: "Repositories" },
			},
		],
	]);
	type DiscoveryProvider = NonNullable<
		Parameters<ScopedSettingsResolver["registerDiscovery"]>[2]
	> & { discover: () => Promise<readonly SettingsSubjectInput[]> };
	const discoveries = new Map<string, DiscoveryProvider[]>();
	for (const loaded of catalog.modules) {
		const owner = loaded.module.manifest.id;
		const declarations = loaded.module.scopedSettings;
		for (const scope of declarations?.scopes ?? []) {
			if (scopes.has(scope.id) || !scope.id.startsWith(`${owner}.`))
				throw new Error(`Invalid or duplicate settings scope '${scope.id}'`);
			scopes.set(scope.id, scope);
		}
		for (const definition of declarations?.settings ?? []) {
			if (definitions.has(definition.key) || !definition.key.startsWith(`${owner}.`))
				throw new Error(`Invalid or duplicate setting '${definition.key}'`);
			if (
				!Number.isSafeInteger(definition.schemaVersion) ||
				definition.schemaVersion < 1 ||
				definition.merge !== "replace" ||
				!definition.scopes.length ||
				new Set(definition.scopes).size !== definition.scopes.length
			)
				throw new Error(`Invalid setting declaration '${definition.key}'`);
			definition.schema.parse(definition.defaultValue);
			definitions.set(definition.key, { owner, definition });
		}
		for (const purpose of declarations?.purposes ?? []) {
			if (purposes.has(purpose.id) || !purpose.id.startsWith(`${owner}.`))
				throw new Error(`Invalid or duplicate execution purpose '${purpose.id}'`);
			purposes.set(purpose.id, purpose);
		}
	}
	for (const { definition } of definitions.values()) {
		for (const scope of definition.scopes)
			if (!scopes.has(scope)) throw new Error(`Unknown scope '${scope}' for '${definition.key}'`);
	}
	for (const purpose of purposes.values()) {
		for (const key of [
			...(purpose.settingKeys ?? []),
			...(purpose.modelSettingKey ? [purpose.modelSettingKey] : []),
		]) {
			if (!definitions.has(key)) throw new Error(`Unknown setting '${key}' for '${purpose.id}'`);
		}
	}
	for (const process of catalog.processes.values())
		for (const binding of process.turns.values()) {
			const def = binding.definition;
			if (def.kind === "llm" && def.executionPurpose && !purposes.has(def.executionPurpose))
				throw new Error(`Unknown execution purpose '${def.executionPurpose}'`);
		}
	const instance =
		repos.scopedSettings.findIdentity("instance", "installation") ??
		repos.scopedSettings.putSubject({
			id: "instance",
			scopeType: "instance",
			identity: "installation",
			label: "Instance",
			context: {},
		});

	const choiceValues = settingSelectionValues;

	function requireSubject(id: string): SettingsSubject {
		const subject = repos.scopedSettings.getSubject(id);
		if (!subject) throw new SettingsError("Settings scope was not found", 404);
		return subject;
	}
	function requireDefinition(key: string): SettingDefinition {
		const definition = definitions.get(key)?.definition;
		if (!definition)
			throw new SettingsError(
				`Setting '${key}' is inactive. Install its owning extension to edit it.`,
				409,
			);
		return definition;
	}
	function contextForSubject(subject: SettingsSubject): SettingsContext {
		return { instance: instance.id, ...subject.context, [subject.scopeType]: subject.id };
	}
	function parse(definition: SettingDefinition, value: unknown): unknown {
		try {
			const parsed = definition.schema.parse(value);
			if (JSON.stringify(parsed) === undefined) throw new Error("Value must be JSON-compatible");
			if (
				definition.form.control === "model" &&
				parsed !== null &&
				(typeof parsed !== "string" ||
					!input.config.pi.model_profiles.some((profile) => profile.id === parsed))
			)
				throw new Error(`Unknown model profile '${String(parsed)}'`);
			return parsed;
		} catch (error) {
			throw new SettingsError(
				`${definition.form.label}: ${error instanceof Error ? error.message : "Invalid value"}. Correct '${definition.key}' in Settings.`,
			);
		}
	}
	function resolveDefinition<T>(
		definition: SettingDefinition<T>,
		context: SettingsContext,
		draft?: SettingsDraft,
		omitSubject?: string,
	): ResolvedSetting<T> {
		let value: unknown = definition.schema.parse(definition.defaultValue);
		let sources: ResolvedSetting["sources"] = [
			{
				subjectId: null,
				scopeType: "default",
				label: "Code default",
				revision: 0,
				schemaVersion: definition.schemaVersion,
				mode: "replace",
			},
		];
		for (const scopeType of definition.scopes) {
			const contextId = scopeType === "instance" ? instance.id : context[scopeType];
			if (!contextId) continue;
			const subject = requireSubject(contextId);
			const subjectId = subject.id;
			if (subjectId === omitSubject) continue;
			if (subject.scopeType !== scopeType)
				throw new SettingsError(`Scope '${subjectId}' does not belong to '${scopeType}'`);
			const row =
				draft?.subjectId === subjectId && draft.key === definition.key
					? draft
					: repos.scopedSettings.getOverride(subjectId, definition.key);
			if (!row || row.reset) continue;
			if (row.schemaVersion !== definition.schemaVersion)
				throw new SettingsError(
					`${definition.form.label} on ${subject.label} uses an incompatible schema. Correct '${definition.key}' in Settings.`,
				);
			if (row.mode !== "replace")
				throw new SettingsError(
					`Append overrides are no longer supported. Reset '${definition.key}' in Settings.`,
				);
			value = parse(definition, row.value);
			const source = {
				subjectId,
				scopeType,
				label: subject.label,
				revision: row.revision,
				schemaVersion: row.schemaVersion,
				mode: row.mode,
			};
			sources = [source];
		}
		return { key: definition.key, value: value as T, sources };
	}
	function discover(subjectInput: SettingsSubjectInput): SettingsSubject {
		if (!scopes.has(subjectInput.scopeType))
			throw new SettingsError(`Unknown settings scope '${subjectInput.scopeType}'`);
		if (!subjectInput.identity.trim() || !subjectInput.label.trim())
			throw new SettingsError("Scope identity and label are required");
		const aliases =
			subjectInput.scopeType === "repository"
				? (subjectInput.aliases ?? []).map(normalizeSettingsLocator)
				: [];
		return repos.transaction((tx) => {
			const repo = tx.scopedSettings;
			let previous = repo.findIdentity(subjectInput.scopeType, subjectInput.identity);
			const candidates = new Map<string, SettingsSubject>();
			if (previous) candidates.set(previous.id, previous);
			for (const alias of aliases) {
				const known = repo.findAlias(alias);
				if (!known) continue;
				if (known.identity !== subjectInput.identity && !known.identity.startsWith("locator:"))
					throw new SettingsError(
						`Repository alias '${alias}' belongs to another provider identity`,
						409,
					);
				candidates.set(known.id, known);
			}
			previous ??= [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id))[0];
			// Only provider-verified aliases can coalesce previously unrecognized locators.
			if (candidates.size > 1) {
				if (subjectInput.identity.startsWith("locator:"))
					throw new SettingsError("Repository aliases require a verified provider identity", 409);
				const overrides = new Map<string, SettingsOverride>();
				for (const candidate of candidates.values()) {
					for (const row of repo.listOverrides(candidate.id)) {
						if (row.reset) continue;
						const saved = overrides.get(row.key);
						if (
							saved &&
							(saved.mode !== row.mode ||
								saved.schemaVersion !== row.schemaVersion ||
								!isDeepStrictEqual(saved.value, row.value))
						)
							throw new SettingsError(
								`Repository aliases have conflicting overrides for '${row.key}'. Compare /settings?scope=${saved.subjectId} and /settings?scope=${row.subjectId}; make the values and modes agree or use inherited value on one scope, then refresh repositories.`,
								409,
							);
						overrides.set(row.key, row);
					}
				}
				for (const candidate of candidates.values())
					if (previous && candidate.id !== previous.id)
						repo.mergeLocatorSubject(candidate.id, previous.id);
			}
			const context = subjectInput.context ?? previous?.context ?? {};
			for (const [type, id] of Object.entries(context))
				if (requireSubject(id).scopeType !== type || type === subjectInput.scopeType)
					throw new SettingsError("Invalid scope ancestry");
			const changed =
				!previous ||
				previous.identity !== subjectInput.identity ||
				previous.label !== subjectInput.label ||
				JSON.stringify(previous.context) !== JSON.stringify(context);
			const subject =
				changed || !previous
					? repo.putSubject({ ...subjectInput, id: previous?.id, context })
					: previous;
			for (const alias of aliases) repo.putAlias(alias, subject.id);
			return subject;
		});
	}
	function repository(project: Project): SettingsSubject {
		const locator = normalizeSettingsLocator(project.repoLocator);
		const binding = project.metadata?.settingsRepository;
		if (
			binding &&
			typeof binding === "object" &&
			"origin" in binding &&
			"repositoryId" in binding &&
			typeof binding.origin === "string" &&
			(typeof binding.repositoryId === "string" || typeof binding.repositoryId === "number")
		) {
			const aliases =
				"aliases" in binding && Array.isArray(binding.aliases)
					? binding.aliases.filter((alias): alias is string => typeof alias === "string")
					: [];
			const identity = repositorySettingsIdentity(binding.origin, binding.repositoryId);
			const known = repos.scopedSettings.findIdentity("repository", identity);
			return discover({
				scopeType: "repository",
				identity,
				label: known?.label ?? locator,
				aliases: [locator, ...aliases],
			});
		}
		const known = repos.scopedSettings.findAlias(locator);
		if (known) return known;
		return discover({
			scopeType: "repository",
			identity: `locator:${locator}`,
			label: locator,
			aliases: [locator],
		});
	}
	function contextFor(
		process: { metadata?: Record<string, unknown> | null },
		projects: readonly Project[],
		preview = false,
	) {
		const supplied = process.metadata?.settingsContext;
		const context: Record<string, string> = { instance: instance.id };
		if (supplied && typeof supplied === "object")
			for (const [type, id] of Object.entries(supplied)) {
				if (typeof id !== "string" || requireSubject(id).scopeType !== type)
					throw new SettingsError("Invalid retained settings context");
				context[type] = id;
			}
		const subjects = projects.map((project) => ({ project, subject: repository(project) }));
		const primaryKey = process.metadata?.primaryRepositoryKey;
		const primary =
			typeof primaryKey === "string"
				? subjects.find((entry) => entry.project.key === primaryKey)
				: subjects.length === 1
					? subjects[0]
					: undefined;
		if (typeof primaryKey === "string" && !primary)
			throw new SettingsError(`Primary repository '${primaryKey}' is no longer bound`);
		// A preview can retain a known repository's settings without clone/branch discovery.
		if (!preview || projects.length > 0) delete context.repository;
		if (primary) context.repository = primary.subject.id;
		return {
			context,
			subjects,
			explanations:
				subjects.length > 1 && !primary
					? ["No primary repository is bound. Process-wide model defaults use Instance settings."]
					: [],
		};
	}
	function purposeFor(processId: string, turnId: string) {
		const turn = catalog.processes.get(processId)?.turns.get(turnId)?.definition;
		return turn?.kind === "llm" && turn.executionPurpose
			? purposes.get(turn.executionPurpose)
			: undefined;
	}
	function forProcess(process: SubjectProcess) {
		return contextFor(process, repos.projects.listByInstance(process.id));
	}
	function capture(
		process: SubjectProcess,
		turnId: string,
		includeModelDefault = true,
	): ScopedSettingsSnapshot | undefined {
		const purpose = purposeFor(process.processId, turnId);
		if (!purpose) return undefined;
		const { context, explanations } = forProcess(process);
		const keys = new Set([
			...(purpose.settingKeys ?? []),
			...(includeModelDefault && purpose.modelSettingKey ? [purpose.modelSettingKey] : []),
		]);
		const values = [...keys].map((key) => resolveDefinition(requireDefinition(key), context));
		return { version: 1, purpose: purpose.id, context, values, explanations };
	}
	function modelDefault(
		processId: string,
		turnId: string,
		process?: SubjectProcess,
		plan?: ProcessLaunchPlan,
	): string | null {
		const purpose = purposeFor(processId, turnId);
		if (!purpose?.modelSettingKey) return null;
		const context = process
			? forProcess(process).context
			: plan
				? contextFor(plan.processInput, plan.projectInputs, plan.preview).context
				: { instance: instance.id };
		const value = resolveDefinition(requireDefinition(purpose.modelSettingKey), context).value;
		if (value !== null && typeof value !== "string")
			throw new SettingsError(`Purpose '${purpose.id}' must select a model profile or null`);
		return value;
	}
	function definitionView(owner: string, definition: SettingDefinition) {
		const { key, schemaVersion, scopes, merge, form } = definition;
		return { key, owner, schemaVersion, scopes, merge, form };
	}
	async function preview(subjectId: string, draft?: SettingsDraft): Promise<SettingsPreview> {
		const subject = requireSubject(subjectId);
		const context = contextForSubject(subject);
		const fields: SettingFieldView[] = [];
		for (const { owner, definition } of definitions.values()) {
			if (!definition.scopes.includes(subject.scopeType)) continue;
			let effective: ResolvedSetting | null = null;
			let inherited: ResolvedSetting | null = null;
			let error: string | null = null;
			let choices: SettingFieldView["choices"] = [];
			try {
				inherited = resolveDefinition(definition, context, undefined, subject.id);
				effective = resolveDefinition(definition, context, draft);
				if (definition.form.control === "model") choices = input.modelChoices?.() ?? [];
				else if (definition.choiceLabel) {
					const label = definition.choiceLabel;
					choices = choiceValues(effective.value).map((value) => ({ value, label: label(value) }));
				}
				if (definition.form.control === "model" && effective.value !== null) {
					const selected = choices.find((choice) => choice.value === effective?.value);
					if (selected?.disabledReason)
						error = `${selected.label}: ${selected.disabledReason}. Restore availability or choose another model before execution.`;
				}
			} catch (caught) {
				error = caught instanceof Error ? caught.message : "Could not resolve setting";
			}
			fields.push({
				...definitionView(owner, definition),
				choices,
				...(definition.choices && definition.form.control !== "model"
					? { choicesDeferred: true }
					: {}),
				inherited,
				effective,
				override: repos.scopedSettings.getOverride(subject.id, definition.key),
				error,
			});
		}
		return {
			subject,
			fields,
			inactive: repos.scopedSettings
				.listOverrides(subjectId)
				.filter((row) => !row.reset && !definitions.has(row.key)),
		};
	}
	async function choices(subjectId: string, key: string, search = "") {
		const subject = requireSubject(subjectId);
		const definition = requireDefinition(key);
		if (!definition.scopes.includes(subject.scopeType))
			throw new SettingsError(`'${key}' does not apply to ${subject.scopeType}`);
		if (definition.form.control === "model") return input.modelChoices?.() ?? [];
		if (search.trim().length < (definition.form.search?.minimumLength ?? 0)) return [];
		const context = contextForSubject(subject);
		const values = choiceValues(resolveDefinition(definition, context).value);
		return (await definition.choices?.(context, { search, values })) ?? [];
	}
	function validateWrite({
		subjectId,
		key,
		value,
		mode,
		reset,
	}: Omit<SettingsChange, "expectedRevision">) {
		const subject = requireSubject(subjectId);
		const definition = requireDefinition(key);
		if (!definition.scopes.includes(subject.scopeType))
			throw new SettingsError(`'${key}' does not apply to ${subject.scopeType}`);
		mode ??= "replace";
		if (mode !== "replace")
			throw new SettingsError("Settings overrides must replace inherited values");
		return {
			subjectId: subject.id,
			value: reset ? null : parse(definition, value),
			mode,
			schemaVersion: definition.schemaVersion,
		};
	}
	function write(change: SettingsChange) {
		if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0)
			throw new SettingsError("expectedRevision must be a non-negative integer", 400);
		const updated = repos.scopedSettings.write({ ...change, ...validateWrite(change) });
		if (!updated)
			throw new SettingsError(
				"This setting changed since you opened it. Your draft is preserved. Reload the current revision before saving again.",
				409,
			);
		return updated;
	}
	function listScopes(): SettingsScopesResponse {
		discoverLocal();
		const scopesWithFields = new Set(
			[...definitions.values()].flatMap(({ definition }) => definition.scopes),
		);
		const subjectsWithInactiveOverrides = new Set(
			repos.scopedSettings
				.listOverrides()
				.filter((row) => !row.reset && !definitions.has(row.key))
				.map((row) => row.subjectId),
		);
		const subjects = repos.scopedSettings.listSubjects();
		const byId = new Map(subjects.map((subject) => [subject.id, subject]));
		return {
			scopes: [...scopes.values()],
			subjects: subjects
				.filter((subject) => {
					const providers = discoveries.get(subject.scopeType);
					if (!providers) return true;
					const context = Object.fromEntries(
						Object.entries(subject.context).flatMap(([scope, id]) => {
							const parent = byId.get(id);
							return parent ? [[scope, parent]] : [];
						}),
					);
					return providers.some(
						({ includesSubject: includes }) => !includes || includes(subject, context),
					);
				})
				.map((subject) => ({
					...subject,
					active: scopes.has(subject.scopeType),
					hasSettings:
						scopesWithFields.has(subject.scopeType) ||
						subjectsWithInactiveOverrides.has(subject.id),
				})),
		};
	}
	function discoverLocal() {
		for (const [key, component] of Object.entries(input.config.components))
			repository({ key, repoLocator: component.repo });
		for (const project of repos.projects.listAll()) {
			try {
				repository(project);
			} catch (error) {
				// Retained conflicts block affected execution, while Settings must stay
				// available so the operator can correct the competing overrides.
				if (!(error instanceof SettingsError) || error.statusCode !== 409) throw error;
			}
		}
	}
	discoverLocal();
	return {
		modelReferences() {
			const references: ScopedModelReference[] = [];
			const append = (
				definition: SettingDefinition,
				value: unknown,
				subjectId: string | null,
				label: string,
				invalid = false,
			) => {
				let modelProfileId: string | null = null;
				try {
					const parsed = definition.schema.parse(value);
					if (parsed !== null && (typeof parsed !== "string" || !parsed.trim())) invalid = true;
					else modelProfileId = typeof parsed === "string" ? parsed.trim() : null;
				} catch {
					invalid = true;
				}
				if (invalid || modelProfileId !== null)
					references.push({ key: definition.key, label, subjectId, modelProfileId, invalid });
			};
			for (const { definition } of definitions.values()) {
				if (definition.form.control === "model")
					append(
						definition,
						definition.defaultValue,
						null,
						`${definition.form.label} (code default)`,
					);
			}
			const subjects = new Map(
				repos.scopedSettings.listSubjects().map((subject) => [subject.id, subject]),
			);
			for (const override of repos.scopedSettings.listOverrides()) {
				const definition = definitions.get(override.key)?.definition;
				const subject = subjects.get(override.subjectId);
				if (override.reset || !subject || definition?.form.control !== "model") continue;
				append(
					definition,
					override.value,
					subject.id,
					`${subject.label}: ${definition.form.label}`,
					override.schemaVersion !== definition.schemaVersion || override.mode !== "replace",
				);
			}
			return references;
		},
		async overview(scopeType) {
			const subjects = listScopes().subjects.filter(
				(subject) => subject.scopeType === scopeType && subject.hasSettings,
			);
			return {
				items: await Promise.all(
					subjects.map(async (subject) => {
						const result = await preview(subject.id);
						const mappingFields = result.fields.filter(
							(field) => field.form.overview === "repository-mapping",
						);
						return {
							subjectId: subject.id,
							customized: [
								...result.fields
									.filter((field) => field.override && !field.override.reset)
									.map((field) => field.form.label),
								...result.inactive.map((field) => field.key),
							],
							...(mappingFields.length
								? {
										mapping: mappingFields.flatMap((field) =>
											settingSelectionValues(field.effective?.value).map(
												(value) =>
													field.choices.find((choice) => choice.value === value) ?? {
														value,
														label: "Unavailable repository",
													},
											),
										),
									}
								: {}),
							errors: result.fields.flatMap((field) => (field.error ? [field.error] : [])),
						};
					}),
				),
			};
		},
		resolve: (definition, context) =>
			resolveDefinition(requireDefinition(definition.key) as typeof definition, context),
		findSubject: (scopeType, identity) => repos.scopedSettings.findIdentity(scopeType, identity),
		getSubject: (id) => repos.scopedSettings.getSubject(id),
		seedOverride(subjectId, definition, value) {
			const subject = requireSubject(subjectId);
			if (repos.scopedSettings.getOverride(subject.id, definition.key)) return false;
			write({
				subjectId: subject.id,
				key: definition.key,
				value,
				mode: "replace",
				reset: false,
				expectedRevision: 0,
				actor: SYSTEM_ACTOR,
			});
			return true;
		},
		discover,
		registerDiscovery(scopeType, discoverer, options) {
			if (!scopes.has(scopeType)) throw new SettingsError(`Unknown scope '${scopeType}'`);
			discoveries.set(scopeType, [
				...(discoveries.get(scopeType) ?? []),
				{ discover: discoverer, includesSubject: options?.includesSubject },
			]);
		},
		capture,
		modelDefault,
		preview,
		choices,
		write,
		listScopes,
		forProcess,
		forLaunch: (plan) => contextFor(plan.processInput, plan.projectInputs, plan.preview),
		previewProcess(process: SubjectProcess) {
			return [...(catalog.processes.get(process.processId)?.turns.keys() ?? [])]
				.filter((turnId) => purposeFor(process.processId, turnId))
				.map((turnId) => {
					try {
						return { turnId, settings: capture(process, turnId) ?? null, error: null };
					} catch (caught) {
						return {
							turnId,
							settings: null,
							error: caught instanceof Error ? caught.message : "Invalid scoped settings",
						};
					}
				});
		},
		definitions: () =>
			[...definitions.values()].map(({ owner, definition }) => definitionView(owner, definition)),
		async refresh() {
			discoverLocal();
			for (const [scope, providers] of discoveries)
				for (const { discover: provider } of providers)
					for (const subject of await provider()) {
						if (subject.scopeType !== scope)
							throw new SettingsError("Discovery returned a different scope type");
						discover(subject);
					}
			return listScopes();
		},
		async previewDraft(change) {
			return preview(change.subjectId, {
				...change,
				...validateWrite(change),
				revision: 0,
			});
		},
	};
}
