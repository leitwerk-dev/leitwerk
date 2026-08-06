import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	type LeitwerkRuntimeLane,
	type LoadedExtensionModule,
	resolveRuntimeLane,
} from "@leitwerk-dev/extension-runtime";
import * as v from "valibot";

interface ExtensionPackageJsonRecord {
	leitwerk?: {
		ui?: {
			source?: unknown;
			import?: unknown;
		};
	};
}

interface RawExtensionUiManifest {
	apiVersion?: unknown;
	extensionManifestId?: unknown;
	renderers?: unknown;
	browserModules?: unknown;
}

interface RawExtensionUiRendererManifestEntry {
	kind?: unknown;
	tagName?: unknown;
	module?: unknown;
	rendererApiVersion?: unknown;
}

interface RawExtensionUiBrowserModuleManifestEntry {
	module?: unknown;
	browserApiVersion?: unknown;
}

export interface ExtensionUiRendererDescriptor {
	rendererId: string;
	kind: "custom_element";
	tagName: string;
	modulePath: string;
	rendererApiVersion: number;
	extensionManifestId: string;
}

export interface ExtensionUiRendererLookup {
	rendererId: string;
	kind: "custom_element";
	tagName: string;
	modulePath: string;
	rendererApiVersion: number;
	extensionManifestId: string;
	moduleUrl: string;
}

export interface ExtensionUiBrowserModuleDescriptor {
	extensionManifestId: string;
	modulePath: string;
	browserApiVersion: number;
}

export interface ExtensionUiBrowserModuleLookup extends ExtensionUiBrowserModuleDescriptor {
	moduleUrl: string;
}

export interface ExtensionUiAssetRoot {
	extensionManifestId: string;
	assetRootDir: string;
}

export interface ExtensionUiCatalog {
	getRenderer(rendererId: string): ExtensionUiRendererLookup | null;
	listBrowserModules(): readonly ExtensionUiBrowserModuleLookup[];
	getAssetRoot(extensionManifestId: string): ExtensionUiAssetRoot | null;
}

const CUSTOM_ELEMENT_TAG_RE = /^[a-z](?:[.0-9_a-z]*-)[-.0-9_a-z]*$/;
const MANIFEST_ID_RE = /^[A-Za-z0-9._-]+$/;

const jsonObjectSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

async function readJsonFile(pathname: string): Promise<unknown> {
	return v.parse(v.unknown(), JSON.parse(await readFile(pathname, "utf8")));
}

async function pathExists(pathname: string): Promise<boolean> {
	try {
		await stat(pathname);
		return true;
	} catch {
		return false;
	}
}

function normalizeRelativePosixPath(value: string, fieldLabel: string): string {
	if (value.trim() === "") {
		throw new Error(`${fieldLabel} must be a non-empty relative path`);
	}
	if (value.startsWith("/")) {
		throw new Error(`${fieldLabel} must be relative, got '${value}'`);
	}
	const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized === "."
	) {
		throw new Error(`${fieldLabel} must stay within the declared asset root, got '${value}'`);
	}
	return normalized.replace(/^\.\//, "");
}

function resolveWithinRoot(rootDir: string, relativePath: string, fieldLabel: string): string {
	const resolvedRoot = path.resolve(rootDir);
	const normalizedRelativePath = normalizeRelativePosixPath(relativePath, fieldLabel);
	const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath);
	const relativeToRoot = path.relative(resolvedRoot, resolvedPath);
	if (
		relativeToRoot === ".." ||
		relativeToRoot.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeToRoot)
	) {
		throw new Error(`${fieldLabel} must stay within '${resolvedRoot}', got '${relativePath}'`);
	}
	return resolvedPath;
}

function validateManifestId(value: unknown, packageName: string): string {
	const parsed = v.safeParse(v.pipe(v.string(), v.regex(MANIFEST_ID_RE)), value);
	if (!parsed.success) {
		throw new Error(
			`Extension UI manifest for '${packageName}' must declare a url-safe extensionManifestId`,
		);
	}
	return parsed.output;
}

function validateTagName(value: unknown, rendererId: string): string {
	const parsed = v.safeParse(v.pipe(v.string(), v.regex(CUSTOM_ELEMENT_TAG_RE)), value);
	if (!parsed.success) {
		throw new Error(
			`Renderer '${rendererId}' must declare a valid custom element tagName containing a hyphen`,
		);
	}
	return parsed.output;
}

function validateRendererApiVersion(value: unknown, rendererId: string): number {
	const parsed = v.safeParse(v.pipe(v.number(), v.integer(), v.minValue(1)), value);
	if (!parsed.success) {
		throw new Error(`Renderer '${rendererId}' must declare a positive integer rendererApiVersion`);
	}
	return parsed.output;
}

function validateBrowserApiVersion(value: unknown, modulePath: string): number {
	const parsed = v.safeParse(v.pipe(v.number(), v.integer(), v.minValue(1)), value);
	if (!parsed.success) {
		throw new Error(
			`Browser module '${modulePath}' must declare a positive integer browserApiVersion`,
		);
	}
	return parsed.output;
}

function buildModuleUrl(extensionManifestId: string, modulePath: string): string {
	const encodedManifestId = encodeURIComponent(extensionManifestId);
	const encodedModulePath = modulePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `/ext-ui/${encodedManifestId}/${encodedModulePath}`;
}

function createCatalog(
	renderers: ReadonlyMap<string, ExtensionUiRendererDescriptor>,
	browserModules: readonly ExtensionUiBrowserModuleDescriptor[],
	assetRoots: ReadonlyMap<string, ExtensionUiAssetRoot>,
): ExtensionUiCatalog {
	return {
		getRenderer(rendererId) {
			const descriptor = renderers.get(rendererId);
			if (!descriptor) {
				return null;
			}
			return {
				...descriptor,
				moduleUrl: buildModuleUrl(descriptor.extensionManifestId, descriptor.modulePath),
			};
		},
		listBrowserModules() {
			return browserModules.map((descriptor) => ({
				...descriptor,
				moduleUrl: buildModuleUrl(descriptor.extensionManifestId, descriptor.modulePath),
			}));
		},
		getAssetRoot(extensionManifestId) {
			return assetRoots.get(extensionManifestId) ?? null;
		},
	};
}

function parseManifestRendererEntries(
	manifest: RawExtensionUiManifest,
	packageName: string,
	extensionManifestId: string,
): Map<string, Omit<ExtensionUiRendererDescriptor, "extensionManifestId">> {
	const parsedRenderers = v.safeParse(
		v.optional(v.record(v.string(), jsonObjectSchema), {}),
		manifest.renderers,
	);
	if (!parsedRenderers.success) {
		throw new Error(`Extension UI manifest for '${packageName}' must declare a renderers object`);
	}
	const renderers = new Map<string, Omit<ExtensionUiRendererDescriptor, "extensionManifestId">>();
	for (const [rendererId, rawEntry] of Object.entries(parsedRenderers.output)) {
		if (!rendererId.trim()) {
			throw new Error(
				`Extension UI manifest '${extensionManifestId}' contains an empty rendererId`,
			);
		}
		const parsedEntry = v.safeParse(jsonObjectSchema, rawEntry);
		if (!parsedEntry.success) {
			throw new Error(`Renderer '${rendererId}' must be an object in the extension UI manifest`);
		}
		const entry = parsedEntry.output as RawExtensionUiRendererManifestEntry;
		if (entry.kind !== "custom_element") {
			throw new Error(`Renderer '${rendererId}' must declare kind='custom_element'`);
		}
		const tagName = validateTagName(entry.tagName, rendererId);
		const modulePath = v.safeParse(v.string(), entry.module);
		if (!modulePath.success) {
			throw new Error(`Renderer '${rendererId}' must declare a string module path`);
		}
		renderers.set(rendererId, {
			rendererId,
			kind: "custom_element",
			tagName,
			modulePath: normalizeRelativePosixPath(modulePath.output, `Renderer '${rendererId}' module`),
			rendererApiVersion: validateRendererApiVersion(entry.rendererApiVersion, rendererId),
		});
	}
	return renderers;
}

function parseManifestBrowserModuleEntries(
	manifest: RawExtensionUiManifest,
	packageName: string,
): Array<Omit<ExtensionUiBrowserModuleDescriptor, "extensionManifestId">> {
	const parsedBrowserModules = v.safeParse(
		v.optional(v.array(jsonObjectSchema), []),
		manifest.browserModules,
	);
	if (!parsedBrowserModules.success) {
		throw new Error(
			`Extension UI manifest for '${packageName}' must declare browserModules as an array`,
		);
	}
	return parsedBrowserModules.output.map((rawEntry, index) => {
		const entry = rawEntry as RawExtensionUiBrowserModuleManifestEntry;
		const modulePath = v.safeParse(v.string(), entry.module);
		if (!modulePath.success) {
			throw new Error(`Browser module at index ${index} must declare a string module path`);
		}
		const normalizedModulePath = normalizeRelativePosixPath(
			modulePath.output,
			`Browser module at index ${index}`,
		);
		return {
			modulePath: normalizedModulePath,
			browserApiVersion: validateBrowserApiVersion(entry.browserApiVersion, normalizedModulePath),
		};
	});
}

export interface BuildExtensionUiCatalogOptions {
	runtimeLane?: LeitwerkRuntimeLane;
}

export async function buildExtensionUiCatalog(
	loadedModules: readonly LoadedExtensionModule[],
	options: BuildExtensionUiCatalogOptions = {},
): Promise<ExtensionUiCatalog> {
	const rendererDescriptors = new Map<string, ExtensionUiRendererDescriptor>();
	const browserModules: ExtensionUiBrowserModuleDescriptor[] = [];
	const assetRoots = new Map<string, ExtensionUiAssetRoot>();
	const runtimeLane = options.runtimeLane ?? resolveRuntimeLane();
	const manifestField = runtimeLane === "source" ? "source" : "import";

	for (const loadedModule of loadedModules) {
		const packageDir = path.resolve(loadedModule.packageDir);
		const packageJsonPath = path.join(packageDir, "package.json");
		if (!(await pathExists(packageJsonPath))) {
			continue;
		}

		const packageJson = (await readJsonFile(packageJsonPath)) as ExtensionPackageJsonRecord;
		const uiMetadata = packageJson.leitwerk?.ui;
		if (uiMetadata === undefined) {
			continue;
		}
		const parsedManifestRelativePath = v.safeParse(v.string(), uiMetadata[manifestField]);
		if (!parsedManifestRelativePath.success) {
			throw new Error(
				`Extension package '${loadedModule.packageName}' must declare leitwerk.ui.${manifestField} as a string path`,
			);
		}

		const manifestPath = resolveWithinRoot(
			packageDir,
			parsedManifestRelativePath.output,
			`leitwerk.ui.${manifestField} for '${loadedModule.packageName}'`,
		);
		if (!(await pathExists(manifestPath))) {
			throw new Error(
				`Extension UI manifest '${manifestPath}' for '${loadedModule.packageName}' does not exist`,
			);
		}

		const manifest = (await readJsonFile(manifestPath)) as RawExtensionUiManifest;
		if (!v.safeParse(v.literal(1), manifest.apiVersion).success) {
			throw new Error(
				`Extension UI manifest for '${loadedModule.packageName}' must declare apiVersion=1`,
			);
		}
		const extensionManifestId = validateManifestId(
			manifest.extensionManifestId,
			loadedModule.packageName,
		);
		if (assetRoots.has(extensionManifestId)) {
			throw new Error(
				`Duplicate extensionManifestId '${extensionManifestId}' found while loading extension UI manifests`,
			);
		}

		const assetRootDir = path.dirname(manifestPath);
		assetRoots.set(extensionManifestId, {
			extensionManifestId,
			assetRootDir,
		});

		const renderers = parseManifestRendererEntries(
			manifest,
			loadedModule.packageName,
			extensionManifestId,
		);
		for (const renderer of renderers.values()) {
			if (rendererDescriptors.has(renderer.rendererId)) {
				throw new Error(
					`Duplicate extension UI rendererId '${renderer.rendererId}' found while loading extension UI manifests`,
				);
			}
			const moduleFilePath = resolveWithinRoot(
				assetRootDir,
				renderer.modulePath,
				`Renderer '${renderer.rendererId}' module`,
			);
			if (!(await pathExists(moduleFilePath))) {
				throw new Error(
					`Renderer '${renderer.rendererId}' points to missing browser module '${moduleFilePath}'`,
				);
			}
			rendererDescriptors.set(renderer.rendererId, {
				...renderer,
				extensionManifestId,
			});
		}

		for (const browserModule of parseManifestBrowserModuleEntries(
			manifest,
			loadedModule.packageName,
		)) {
			const moduleFilePath = resolveWithinRoot(
				assetRootDir,
				browserModule.modulePath,
				`Browser module '${browserModule.modulePath}'`,
			);
			if (!(await pathExists(moduleFilePath))) {
				throw new Error(
					`Browser module '${browserModule.modulePath}' points to missing file '${moduleFilePath}'`,
				);
			}
			browserModules.push({
				...browserModule,
				extensionManifestId,
			});
		}
	}

	return createCatalog(rendererDescriptors, browserModules, assetRoots);
}

export function resolveExtensionUiAssetPath(
	catalog: ExtensionUiCatalog,
	extensionManifestId: string,
	requestedPath: string,
): string | null {
	const assetRoot = catalog.getAssetRoot(extensionManifestId);
	if (!assetRoot) {
		return null;
	}
	if (requestedPath.trim() === "") {
		return null;
	}
	try {
		return resolveWithinRoot(
			assetRoot.assetRootDir,
			requestedPath,
			`Requested asset path for extensionManifestId='${extensionManifestId}'`,
		);
	} catch {
		return null;
	}
}

export function inferExtensionUiAssetContentType(pathname: string): string {
	switch (path.extname(pathname).toLowerCase()) {
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
		case ".map":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".ogg":
			return "audio/ogg";
		default:
			return "application/octet-stream";
	}
}
