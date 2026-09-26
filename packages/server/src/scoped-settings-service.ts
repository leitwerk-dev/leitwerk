import { normalize } from "node:path";
import type {
	Actor,
	ProcessInstance,
	ResolvedSetting,
	ScopedSettingsSnapshot,
	SettingsContext,
	SettingsOverride,
	SettingsSubject,
} from "@leitwerk-dev/domain";
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
	SettingsPreview,
	SettingsScopesResponse,
} from "@leitwerk-dev/protocol/http-contracts";
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

type SubjectProcess = Pick<ProcessInstance, "id" | "processId" | "metadata">;
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
/** @internal */
export interface ScopedSettingsService extends ScopedSettingsResolver {
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
	preview(subjectId: string, draft?: SettingsOverride): Promise<SettingsPreview>;
	/** @internal */
	write(change: Omit<SettingsWrite, "schemaVersion">): SettingsOverride;
	/** @internal */
	listScopes(): SettingsScopesResponse;
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
	previewDraft(
		change: Omit<SettingsWrite, "schemaVersion" | "expectedRevision">,
	): Promise<SettingsPreview>;
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
	const scopes = new Map([
		["instance", { id: "instance", label: "Instance" }],
		["repository", { id: "repository", label: "Repository" }],
	]);
	const discoveries = new Map<string, Array<() => Promise<readonly SettingsSubjectInput[]>>>();
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
			...(purpose.instructionSettingKeys ?? []),
			...(purpose.modelSettingKey ? [purpose.modelSettingKey] : []),
		]) {
			if (!definitions.has(key)) throw new Error(`Unknown setting '${key}' for '${purpose.id}'`);
		}
		for (const key of purpose.instructionSettingKeys ?? [])
			if (definitions.get(key)?.definition.merge !== "instructions")
				throw new Error(`Instruction setting '${key}' must compose instructions`);
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
			if (definition.merge === "instructions" && typeof parsed !== "string")
				throw new Error("Instructions must be text");
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
		draft?: SettingsOverride,
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
			const subjectId = scopeType === "instance" ? instance.id : context[scopeType];
			if (!subjectId || subjectId === omitSubject) continue;
			const subject = requireSubject(subjectId);
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
			const next = parse(definition, row.value);
			const append = definition.merge === "instructions" && row.mode === "append";
			value = append ? [value, next].filter((part) => part !== "").join("\n\n") : next;
			const source = {
				subjectId,
				scopeType,
				label: subject.label,
				revision: row.revision,
				schemaVersion: row.schemaVersion,
				mode: row.mode,
			};
			sources = append ? [...sources, source] : [source];
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
			for (const alias of aliases) {
				const known = repo.findAlias(alias);
				if (!known) continue;
				if (previous && previous.id !== known.id)
					throw new SettingsError(`Repository alias '${alias}' has conflicting identities`, 409);
				if (known.identity !== subjectInput.identity && !known.identity.startsWith("locator:"))
					throw new SettingsError(
						`Repository alias '${alias}' belongs to another provider identity`,
						409,
					);
				previous ??= known;
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
		delete context.repository;
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
		const { context, subjects, explanations } = forProcess(process);
		const keys = new Set([
			...(purpose.settingKeys ?? []),
			...(includeModelDefault && purpose.modelSettingKey ? [purpose.modelSettingKey] : []),
		]);
		const values = [...keys].map((key) => resolveDefinition(requireDefinition(key), context));
		const instructions: ScopedSettingsSnapshot["instructions"] = [];
		for (const key of purpose.instructionSettingKeys ?? []) {
			const definition = requireDefinition(key) as SettingDefinition<string>;
			const targets =
				definition.scopes.includes("repository") && subjects.length
					? subjects.map(({ subject, project }) => ({
							label: `${project.key} — ${subject.label}`,
							context: { ...context, repository: subject.id },
						}))
					: [{ label: definition.form.label, context }];
			for (const target of targets)
				instructions.push({
					label: target.label,
					setting: resolveDefinition(definition, target.context),
				});
		}
		return { version: 1, purpose: purpose.id, context, values, instructions, explanations };
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
				? contextFor(plan.processInput, plan.projectInputs).context
				: { instance: instance.id };
		const value = resolveDefinition(requireDefinition(purpose.modelSettingKey), context).value;
		if (value !== null && typeof value !== "string")
			throw new SettingsError(`Purpose '${purpose.id}' must select a model profile or null`);
		return value;
	}
	async function preview(subjectId: string, draft?: SettingsOverride): Promise<SettingsPreview> {
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
				choices =
					definition.form.control === "model"
						? (input.modelChoices?.() ?? [])
						: ((await definition.choices?.(context)) ?? []);
				inherited = resolveDefinition(definition, context, undefined, subject.id);
				effective = resolveDefinition(definition, context, draft);
				if (definition.form.control === "model" && effective.value !== null) {
					const selected = choices.find((choice) => choice.value === effective?.value);
					if (selected?.disabledReason)
						error = `${selected.label}: ${selected.disabledReason}. Restore availability or choose another model before execution.`;
				}
			} catch (caught) {
				error = caught instanceof Error ? caught.message : "Could not resolve setting";
			}
			fields.push({
				key: definition.key,
				owner,
				schemaVersion: definition.schemaVersion,
				scopes: definition.scopes,
				merge: definition.merge,
				form: definition.form,
				choices,
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
	function validateWrite(
		subjectId: string,
		key: string,
		value: unknown,
		mode: "append" | "replace",
		reset: boolean,
	) {
		const subject = requireSubject(subjectId);
		const definition = requireDefinition(key);
		if (!definition.scopes.includes(subject.scopeType))
			throw new SettingsError(`'${key}' does not apply to ${subject.scopeType}`);
		if (mode === "append" && definition.merge !== "instructions")
			throw new SettingsError("Only instructions can append inherited values");
		return { definition, value: reset ? null : parse(definition, value) };
	}
	function write(change: {
		subjectId: string;
		key: string;
		value: unknown;
		mode: "append" | "replace";
		reset: boolean;
		expectedRevision: number;
		actor: Actor;
	}) {
		if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0)
			throw new SettingsError("expectedRevision must be a non-negative integer", 400);
		const { definition, value } = validateWrite(
			change.subjectId,
			change.key,
			change.value,
			change.mode,
			change.reset,
		);
		const updated = repos.scopedSettings.write({
			...change,
			value,
			schemaVersion: definition.schemaVersion,
		});
		if (!updated)
			throw new SettingsError(
				"This setting changed since you opened it. Your draft is preserved. Reload the current revision before saving again.",
				409,
			);
		return updated;
	}
	function listScopes(): SettingsScopesResponse {
		discoverLocal();
		return {
			scopes: [...scopes.values()],
			subjects: repos.scopedSettings
				.listSubjects()
				.map((subject) => ({ ...subject, active: scopes.has(subject.scopeType) })),
		};
	}
	function discoverLocal() {
		for (const [key, component] of Object.entries(input.config.components))
			repository({ key, repoLocator: component.repo });
		for (const project of repos.projects.listAll()) repository(project);
	}
	discoverLocal();
	const resolver: ScopedSettingsResolver = {
		resolve: (definition, context) =>
			resolveDefinition(requireDefinition(definition.key) as typeof definition, context),
		discover,
		registerDiscovery(scopeType, discoverer) {
			if (!scopes.has(scopeType)) throw new SettingsError(`Unknown scope '${scopeType}'`);
			discoveries.set(scopeType, [...(discoveries.get(scopeType) ?? []), discoverer]);
		},
	};
	return {
		...resolver,
		capture,
		modelDefault,
		preview,
		write,
		listScopes,
		forProcess,
		forLaunch: (plan) => contextFor(plan.processInput, plan.projectInputs),
		previewProcess(process: SubjectProcess) {
			return [...(catalog.processes.get(process.processId)?.turns.keys() ?? [])].flatMap(
				(turnId) => {
					if (!purposeFor(process.processId, turnId)) return [];
					try {
						return [
							{ turnId, settings: capture(process, turnId) ?? null, error: null as string | null },
						];
					} catch (caught) {
						return [
							{
								turnId,
								settings: null,
								error: caught instanceof Error ? caught.message : "Invalid scoped settings",
							},
						];
					}
				},
			);
		},
		definitions: () =>
			[...definitions].map(([key, { owner, definition }]) => ({
				key,
				owner,
				schemaVersion: definition.schemaVersion,
				scopes: definition.scopes,
				merge: definition.merge,
				form: definition.form,
			})),
		async refresh() {
			discoverLocal();
			for (const [scope, providers] of discoveries)
				for (const provider of providers)
					for (const subject of await provider()) {
						if (subject.scopeType !== scope)
							throw new SettingsError("Discovery returned a different scope type");
						discover(subject);
					}
			return listScopes();
		},
		async previewDraft(change: {
			subjectId: string;
			key: string;
			value: unknown;
			mode: "append" | "replace";
			reset: boolean;
			actor: Actor;
		}) {
			const { definition, value } = validateWrite(
				change.subjectId,
				change.key,
				change.value,
				change.mode,
				change.reset,
			);
			return preview(change.subjectId, {
				...change,
				value,
				revision: 0,
				schemaVersion: definition.schemaVersion,
				createdAt: "",
				updatedAt: "",
			});
		},
	};
}
