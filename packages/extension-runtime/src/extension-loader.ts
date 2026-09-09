import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	type CapabilityToken,
	type CatalogExtensionAPI,
	CORE_TOOL_CALL_RENDERERS,
	createCapabilityAccessor,
	createEventBus,
	type EventBus,
	type ExtensionProcessDefinition,
	type LeitwerkExtensionModule,
	type PiServerAdapter,
	type ToolCallRendererDefinition,
	toProcessGraphView,
	validateProcessGraphEntryTurns,
	validateProcessGraphProducts,
	validateProcessGraphTurnTransitions,
	validateToolCallRendererDefinition,
	validateTurnDefinition,
} from "@leitwerk-dev/process-sdk";
import {
	getProcessTurnTransitions,
	isDefinedProcess,
	registerUnique,
} from "@leitwerk-dev/process-sdk/runtime-internals";
import { createJiti } from "jiti";
import { packageDirectorySync } from "pkg-dir";
import { readPackageUpSync } from "read-pkg-up";
import resolvePackagePath from "resolve-package-path";
import * as v from "valibot";
import { type LeitwerkRuntimeLane, resolveRuntimeLane } from "./runtime-lane.js";

interface PackageJsonRecord {
	name?: unknown;
	workspaces?: unknown;
	leitwerk?: {
		extension?: unknown;
		pi?: unknown;
	};
}

interface LeitwerkConditionalExtensionEntryRecord {
	source?: unknown;
	import?: unknown;
}

export interface DiscoveredExtensionEntry {
	packageName: string;
	packageDir: string;
	entryPath: string;
	pi?: DiscoveredPiContribution;
}

export interface DiscoveredPiContribution {
	workerEntryPath?: string;
	serverEntryPath?: string;
	resources: {
		skillDirectories: string[];
		promptDirectories: string[];
	};
}

export interface LoadedExtensionModule {
	packageName: string;
	packageDir: string;
	entryPath: string;
	pi?: DiscoveredPiContribution;
	module: LeitwerkExtensionModule;
}

export interface CatalogPiContribution extends DiscoveredPiContribution {
	ownerExtensionId: string;
	packageName: string;
}

export interface OwnedModelProviderSet {
	ownerExtensionId: string;
	packageName: string;
	resolve: NonNullable<LeitwerkExtensionModule["modelProviders"]>;
}

export interface ExtensionCatalog {
	readonly events: EventBus;
	readonly modules: readonly LoadedExtensionModule[];
	readonly processes: ReadonlyMap<string, ExtensionProcessDefinition>;
	readonly toolRenderers: ReadonlyMap<string, ToolCallRendererDefinition>;
	readonly piContributions: readonly CatalogPiContribution[];
	readonly modelProviders: readonly OwnedModelProviderSet[];
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	require<T>(token: CapabilityToken<T>): T | T[];
}

export interface ResolveExtensionEntriesOptions {
	startDir?: string;
	sources?: readonly string[];
}

export const RUNTIME_EXTENSION_ENTRIES_ENV = "LEITWERK_EXTENSION_ENTRIES_JSON";
export const RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV = "LEITWERK_EXTENSION_ALLOWED_ROOTS_JSON";

const jiti = createJiti(import.meta.url);

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);
const optionalStringArraySchema = v.optional(v.array(v.string()));
const resolvedExtensionEntrySchema = v.object({
	packageName: v.string(),
	packageDir: v.string(),
	entryPath: v.string(),
	pi: v.optional(
		v.object({
			workerEntryPath: v.optional(v.string()),
			serverEntryPath: v.optional(v.string()),
			resources: v.object({
				skillDirectories: v.array(v.string()),
				promptDirectories: v.array(v.string()),
			}),
		}),
	),
});

function isLeitwerkExtensionModule(value: unknown): value is LeitwerkExtensionModule {
	const parsedModule = v.safeParse(unknownRecordSchema, value);
	if (!parsedModule.success) {
		return false;
	}
	const module = parsedModule.output;
	const parsedManifest = v.safeParse(unknownRecordSchema, module.manifest);
	if (!parsedManifest.success) {
		return false;
	}
	const manifest = parsedManifest.output;
	if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
		return false;
	}
	if (!v.is(optionalStringArraySchema, manifest.requires)) {
		return false;
	}
	if (!v.is(optionalStringArraySchema, manifest.optional)) {
		return false;
	}
	return ["setupCatalog", "setupServer", "setupWorker", "modelProviders"].every(
		(key) => module[key] === undefined || typeof module[key] === "function",
	);
}

async function readJsonFile(pathname: string): Promise<unknown> {
	return JSON.parse(await readFile(pathname, "utf8"));
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		return path.resolve(home, p.slice(2));
	}
	return p;
}

function isPathLike(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		source.startsWith("file:")
	);
}

function resolveSourcePath(startDir: string, source: string): string {
	const expanded = expandHome(source);
	if (expanded.startsWith("file:")) {
		return new URL(expanded).pathname;
	}
	return path.isAbsolute(expanded) ? expanded : path.resolve(startDir, expanded);
}

function findPackageDirFromResolvedFile(resolvedPath: string): string {
	const packageDir = packageDirectorySync({ cwd: path.dirname(resolvedPath) });
	if (!packageDir) {
		throw new Error(`Could not locate package.json for resolved path '${resolvedPath}'`);
	}
	return packageDir;
}

function resolveLaneAwareEntryPath(input: {
	packageDir: string;
	packageName: string;
	value: unknown;
	lane: LeitwerkRuntimeLane;
	label: string;
	optional?: boolean;
	contained?: boolean;
}): string | undefined {
	if (input.optional && input.value === undefined) {
		return undefined;
	}
	const parsedEntry = v.safeParse(unknownRecordSchema, input.value);
	if (!parsedEntry.success) {
		throw new Error(
			`Extension package '${input.packageName}' must declare ${input.label} as an object with source and import string paths`,
		);
	}

	const conditionalEntry = parsedEntry.output as LeitwerkConditionalExtensionEntryRecord;
	const selectedPath = input.lane === "source" ? conditionalEntry.source : conditionalEntry.import;
	if (typeof selectedPath !== "string" || selectedPath.trim() === "") {
		throw new Error(
			`Extension package '${input.packageName}' must declare ${input.label}.${input.lane} as a string path`,
		);
	}
	if (input.contained) {
		return assertPackageContainedPath(
			input.packageDir,
			selectedPath,
			`Extension package '${input.packageName}' ${input.label}.${input.lane}`,
		);
	}
	return path.resolve(input.packageDir, selectedPath);
}

function resolveExtensionEntryPath(
	packageDir: string,
	packageName: string,
	extensionValue: unknown,
	lane: LeitwerkRuntimeLane,
): string {
	return resolveLaneAwareEntryPath({
		packageDir,
		packageName,
		value: extensionValue,
		lane,
		label: "leitwerk.extension",
	}) as string;
}

function assertPackageContainedPath(
	packageDir: string,
	declaredPath: string,
	label: string,
): string {
	const resolvedPath = path.resolve(packageDir, declaredPath);
	const relativePath = path.relative(packageDir, resolvedPath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) &&
			relativePath !== ".." &&
			!path.isAbsolute(relativePath))
	) {
		return resolvedPath;
	}
	throw new Error(`${label} must resolve inside extension package '${packageDir}'`);
}

function resolveOptionalPiEntryPath(
	packageDir: string,
	packageName: string,
	value: unknown,
	lane: LeitwerkRuntimeLane,
	label: "worker" | "server",
): string | undefined {
	return resolveLaneAwareEntryPath({
		packageDir,
		packageName,
		value,
		lane,
		label: `leitwerk.pi.${label}`,
		optional: true,
		contained: true,
	});
}

function resolvePiResourceDirectories(
	packageDir: string,
	packageName: string,
	resources: unknown,
): DiscoveredPiContribution["resources"] {
	if (resources === undefined) {
		return { skillDirectories: [], promptDirectories: [] };
	}
	const parsed = v.safeParse(unknownRecordSchema, resources);
	if (!parsed.success) {
		throw new Error(`Extension package '${packageName}' leitwerk.pi.resources must be an object`);
	}
	const resolveList = (key: "skills" | "prompts"): string[] => {
		const value = parsed.output[key];
		if (value === undefined) {
			return [];
		}
		if (
			!Array.isArray(value) ||
			value.some((item) => typeof item !== "string" || item.trim() === "")
		) {
			throw new Error(
				`Extension package '${packageName}' leitwerk.pi.resources.${key} must be an array of string paths`,
			);
		}
		return value.map((declaredPath) =>
			assertPackageContainedPath(
				packageDir,
				declaredPath as string,
				`Extension package '${packageName}' leitwerk.pi.resources.${key}`,
			),
		);
	};
	return { skillDirectories: resolveList("skills"), promptDirectories: resolveList("prompts") };
}

function resolvePiContribution(
	packageDir: string,
	packageName: string,
	value: unknown,
	lane: LeitwerkRuntimeLane,
): DiscoveredPiContribution | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = v.safeParse(unknownRecordSchema, value);
	if (!parsed.success) {
		throw new Error(`Extension package '${packageName}' leitwerk.pi must be an object`);
	}
	return {
		workerEntryPath: resolveOptionalPiEntryPath(
			packageDir,
			packageName,
			parsed.output.worker,
			lane,
			"worker",
		),
		serverEntryPath: resolveOptionalPiEntryPath(
			packageDir,
			packageName,
			parsed.output.server,
			lane,
			"server",
		),
		resources: resolvePiResourceDirectories(packageDir, packageName, parsed.output.resources),
	};
}

function parsePackageNameFromSpecifier(source: string): string {
	const packageNameMatch = /^(?:@[^/]+\/[^/]+|[^/@][^/]*)/.exec(source);
	if (!packageNameMatch) {
		throw new Error(`Invalid package source '${source}'`);
	}
	return packageNameMatch[0];
}

function resolvePackageDirFromNodeModules(startDir: string, packageName: string): string | null {
	const packageJsonPath = resolvePackagePath(packageName, path.resolve(startDir));
	return packageJsonPath ? path.dirname(packageJsonPath) : null;
}

function resolvePackageDirFromSpecifier(startDir: string, source: string): string {
	const packageName = parsePackageNameFromSpecifier(source);
	const packageDir = resolvePackageDirFromNodeModules(startDir, packageName);
	if (packageDir) {
		return packageDir;
	}

	const nearestPackage = readPackageUpSync({ cwd: path.resolve(startDir), normalize: false });
	const searchedFrom = nearestPackage ? path.dirname(nearestPackage.path) : path.resolve(startDir);
	throw new Error(
		`Could not resolve extension package '${packageName}' from '${searchedFrom}' (source '${source}')`,
	);
}

async function readExtensionEntryFromPackageJson(
	packageJsonPath: string,
	lane: LeitwerkRuntimeLane = resolveRuntimeLane(),
): Promise<DiscoveredExtensionEntry> {
	const parsed = (await readJsonFile(packageJsonPath)) as PackageJsonRecord;
	const packageDir = path.dirname(packageJsonPath);
	const extensionPath = parsed.leitwerk?.extension;
	const packageName = v.safeParse(v.string(), parsed.name);
	if (!packageName.success) {
		throw new Error(`Extension package '${packageDir}' is missing a string 'name' field`);
	}
	return {
		packageName: packageName.output,
		packageDir,
		entryPath: resolveExtensionEntryPath(packageDir, packageName.output, extensionPath, lane),
		pi: resolvePiContribution(packageDir, packageName.output, parsed.leitwerk?.pi, lane),
	};
}

async function resolveConfiguredExtensionSource(
	startDir: string,
	source: string,
	lane: LeitwerkRuntimeLane = resolveRuntimeLane(),
): Promise<DiscoveredExtensionEntry> {
	if (isPathLike(source)) {
		const resolved = resolveSourcePath(startDir, source);
		const statTarget = resolved.endsWith("package.json")
			? resolved
			: existsSync(path.join(resolved, "package.json"))
				? path.join(resolved, "package.json")
				: null;
		if (statTarget) {
			if (!existsSync(statTarget)) {
				throw new Error(
					`Configured extension source '${source}' does not exist at '${statTarget}'`,
				);
			}
			return readExtensionEntryFromPackageJson(statTarget, lane);
		}
		if (!existsSync(resolved)) {
			throw new Error(`Configured extension source '${source}' does not exist at '${resolved}'`);
		}
		const packageDir = findPackageDirFromResolvedFile(resolved);
		const packageJsonPath = path.join(packageDir, "package.json");
		const entry = await readExtensionEntryFromPackageJson(packageJsonPath, lane);
		return {
			...entry,
			entryPath: resolved,
		};
	}

	const packageDir = resolvePackageDirFromSpecifier(startDir, source);
	return readExtensionEntryFromPackageJson(path.join(packageDir, "package.json"), lane);
}

function dedupeEntries(entries: readonly DiscoveredExtensionEntry[]): DiscoveredExtensionEntry[] {
	const deduped = new Map<string, DiscoveredExtensionEntry>();
	for (const entry of entries) {
		const key = `${entry.packageName}\0${entry.entryPath}`;
		if (!deduped.has(key)) {
			deduped.set(key, entry);
		}
	}
	return [...deduped.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export async function resolveExtensionEntries(
	options: ResolveExtensionEntriesOptions = {},
): Promise<DiscoveredExtensionEntry[]> {
	const lane = resolveRuntimeLane();
	const startDir = options.startDir ?? process.cwd();
	const sources = options.sources ?? [];
	const explicitEntries = await Promise.all(
		sources.map((source) => resolveConfiguredExtensionSource(startDir, source, lane)),
	);
	return dedupeEntries(explicitEntries);
}

export function serializeResolvedExtensionEntries(
	entries: readonly DiscoveredExtensionEntry[],
): string {
	return JSON.stringify(entries);
}

export function parseResolvedExtensionEntries(json: string): DiscoveredExtensionEntry[] {
	const parsed = JSON.parse(json) as unknown;
	if (!v.safeParse(v.array(v.unknown()), parsed).success) {
		throw new Error("Resolved extension entries must be a JSON array");
	}
	return (parsed as unknown[]).map((value, index) => {
		if (!v.safeParse(unknownRecordSchema, value).success) {
			throw new Error(`Resolved extension entry at index ${index} is not an object`);
		}
		const entry = v.safeParse(resolvedExtensionEntrySchema, value);
		if (!entry.success) {
			throw new Error(`Resolved extension entry at index ${index} is invalid`);
		}
		return entry.output;
	});
}

export async function importExtensionModules(
	entries: readonly DiscoveredExtensionEntry[],
): Promise<LoadedExtensionModule[]> {
	const loaded: LoadedExtensionModule[] = [];
	for (const entry of entries) {
		const imported = (await jiti.import(entry.entryPath)) as unknown;
		const importedRecord = v.safeParse(unknownRecordSchema, imported);
		const candidate = isLeitwerkExtensionModule(imported)
			? imported
			: importedRecord.success && isLeitwerkExtensionModule(importedRecord.output.default)
				? importedRecord.output.default
				: null;
		if (!candidate) {
			throw new Error(`Extension '${entry.packageName}' does not export a valid default module`);
		}
		loaded.push({
			packageName: entry.packageName,
			packageDir: entry.packageDir,
			entryPath: entry.entryPath,
			pi: entry.pi,
			module: candidate,
		});
	}
	return loaded;
}

/** Loads one server-only Pi adapter declared by an extension package. */
export async function importPiServerAdapter(entryPath: string): Promise<PiServerAdapter> {
	const imported = (await jiti.import(entryPath)) as unknown;
	const importedRecord = v.safeParse(unknownRecordSchema, imported);
	const candidate =
		importedRecord.success && importedRecord.output.default !== undefined
			? importedRecord.output.default
			: imported;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		Array.isArray(candidate) ||
		typeof (candidate as { generateText?: unknown }).generateText !== "function"
	) {
		throw new Error(`Pi server entry '${entryPath}' does not export a valid server adapter`);
	}
	return candidate as PiServerAdapter;
}

function sortByDependencies(modules: readonly LoadedExtensionModule[]): LoadedExtensionModule[] {
	const byId = new Map(modules.map((loaded) => [loaded.module.manifest.id, loaded]));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const ordered: LoadedExtensionModule[] = [];

	function visit(id: string): void {
		if (visited.has(id)) {
			return;
		}
		if (visiting.has(id)) {
			throw new Error(`Circular extension dependency detected involving '${id}'`);
		}
		const loaded = byId.get(id);
		if (!loaded) {
			throw new Error(`Unknown extension dependency '${id}'`);
		}
		visiting.add(id);
		for (const dependencyId of loaded.module.manifest.requires ?? []) {
			visit(dependencyId);
		}
		for (const dependencyId of loaded.module.manifest.optional ?? []) {
			if (byId.has(dependencyId)) {
				visit(dependencyId);
			}
		}
		visiting.delete(id);
		visited.add(id);
		ordered.push(loaded);
	}

	for (const loaded of modules) {
		visit(loaded.module.manifest.id);
	}

	return ordered;
}

export async function buildExtensionCatalog(
	modules: readonly LoadedExtensionModule[],
): Promise<ExtensionCatalog> {
	const orderedModules = sortByDependencies(modules);
	const events = createEventBus();
	const processes = new Map<string, ExtensionProcessDefinition>();
	const toolRenderers = new Map<string, ToolCallRendererDefinition>(
		CORE_TOOL_CALL_RENDERERS.map((def) => [def.toolName, def]),
	);
	const capabilities = createCapabilityAccessor();
	const piContributions: CatalogPiContribution[] = [];
	const modelProviders: OwnedModelProviderSet[] = [];

	const api = {
		events,
		registerProcess<TParams = unknown, TState = unknown>(
			def: ExtensionProcessDefinition<TParams, TState>,
		) {
			if (!isDefinedProcess(def)) {
				throw new Error("Processes must be created with defineProcess(...)");
			}
			registerUnique(processes, def.id, def as ExtensionProcessDefinition, {
				duplicateMessage: `Process '${def.id}' is already registered`,
			});
		},
		registerToolRenderer(def: ToolCallRendererDefinition) {
			registerUnique(toolRenderers, def.toolName, def, {
				duplicateMessage: `Tool renderer '${def.toolName}' is already registered`,
				validate: (value: ToolCallRendererDefinition) => {
					const validationErrors = validateToolCallRendererDefinition(value);
					if (validationErrors.length > 0) {
						throw new Error(validationErrors.join("; "));
					}
				},
			});
		},
		provide: capabilities.provide,
		get: capabilities.get,
		require: capabilities.require.bind(capabilities),
	} satisfies CatalogExtensionAPI;

	for (const loaded of orderedModules) {
		if (loaded.pi) {
			piContributions.push({
				ownerExtensionId: loaded.module.manifest.id,
				packageName: loaded.packageName,
				...loaded.pi,
			});
		}
		if (loaded.module.modelProviders) {
			modelProviders.push({
				ownerExtensionId: loaded.module.manifest.id,
				packageName: loaded.packageName,
				resolve: loaded.module.modelProviders,
			});
		}
		await loaded.module.setupCatalog?.(api);
	}

	const validationErrors: string[] = [];
	for (const [processId, processDef] of processes) {
		if (processDef.turns.size === 0) {
			validationErrors.push(`Process '${processId}' must declare at least one turn`);
		}
		for (const [turnId, binding] of processDef.turns) {
			if ("transitions" in binding) {
				validationErrors.push(
					`Process '${processId}' turn '${turnId}' must declare routing on the turn definition instead of authored transitions`,
				);
			}
			for (const error of validateTurnDefinition(turnId, binding.definition)) {
				validationErrors.push(error);
			}
			for (const transition of getProcessTurnTransitions(binding)) {
				if (transition.nextTurnId && !processDef.turns.has(transition.nextTurnId)) {
					validationErrors.push(
						`Process '${processId}' turn transition from '${turnId}' references undeclared next turn '${transition.nextTurnId}'`,
					);
				}
			}
		}
		const graph = toProcessGraphView(processDef);
		for (const error of validateProcessGraphEntryTurns(graph)) {
			validationErrors.push(`Process '${processId}' graph error: ${error}`);
		}
		for (const error of validateProcessGraphProducts(graph)) {
			validationErrors.push(`Process '${processId}' graph error: ${error}`);
		}
		for (const error of validateProcessGraphTurnTransitions(graph)) {
			validationErrors.push(`Process '${processId}' graph error: ${error}`);
		}
	}
	if (validationErrors.length > 0) {
		throw new Error(validationErrors.join("; "));
	}

	const catalog = {
		events,
		modules: orderedModules,
		processes: new Map(processes),
		toolRenderers: new Map(toolRenderers),
		piContributions: piContributions,
		modelProviders: modelProviders,
		get: capabilities.get,
		require: capabilities.require.bind(capabilities),
	} satisfies ExtensionCatalog;
	return catalog;
}

export async function loadExtensionCatalog(
	options: ResolveExtensionEntriesOptions = {},
): Promise<ExtensionCatalog> {
	const entries = await resolveExtensionEntries(options);
	const modules = await importExtensionModules(entries);
	return buildExtensionCatalog(modules);
}
