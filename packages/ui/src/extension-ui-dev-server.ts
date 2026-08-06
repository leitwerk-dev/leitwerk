import path from "node:path";

const EXTENSION_MANIFEST_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEV_UI_SOURCES_ENV = "LEITWERK_DEV_EXTENSION_UI_SOURCES_JSON";

export interface ExtensionUiDevSource {
	extensionManifestId: string;
	assetRootDir: string;
	packageRootDir: string;
}

export interface ResolvedExtensionUiDevRequest {
	filePath: string;
	search: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
	const relative = path.relative(rootDir, targetPath);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

export function parseExtensionUiDevSources(raw: string | undefined): ExtensionUiDevSource[] {
	if (!raw) return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(`${DEV_UI_SOURCES_ENV} must be a JSON array`);
	}
	const seenIds = new Set<string>();
	return parsed.map((value, index) => {
		if (!isRecord(value)) {
			throw new Error(`${DEV_UI_SOURCES_ENV}[${index}] must be an object`);
		}
		const { extensionManifestId, assetRootDir, packageRootDir } = value;
		if (
			typeof extensionManifestId !== "string" ||
			!EXTENSION_MANIFEST_ID_RE.test(extensionManifestId)
		) {
			throw new Error(`${DEV_UI_SOURCES_ENV}[${index}].extensionManifestId must be URL-safe`);
		}
		if (seenIds.has(extensionManifestId)) {
			throw new Error(`${DEV_UI_SOURCES_ENV} contains duplicate id '${extensionManifestId}'`);
		}
		if (typeof assetRootDir !== "string" || assetRootDir.trim() === "") {
			throw new Error(`${DEV_UI_SOURCES_ENV}[${index}].assetRootDir must be a path`);
		}
		if (typeof packageRootDir !== "string" || packageRootDir.trim() === "") {
			throw new Error(`${DEV_UI_SOURCES_ENV}[${index}].packageRootDir must be a path`);
		}
		seenIds.add(extensionManifestId);
		return {
			extensionManifestId,
			assetRootDir: path.resolve(assetRootDir),
			packageRootDir: path.resolve(packageRootDir),
		};
	});
}

export function resolveExtensionUiDevRequest(
	rawUrl: string,
	sources: readonly ExtensionUiDevSource[],
): ResolvedExtensionUiDevRequest | null {
	let url: URL;
	try {
		url = new URL(rawUrl, "http://leitwerk.local");
	} catch {
		return null;
	}
	const segments = url.pathname.split("/");
	if (segments.length < 4 || segments[1] !== "ext-ui") return null;

	let extensionManifestId: string;
	let requestedPath: string;
	try {
		extensionManifestId = decodeURIComponent(segments[2] ?? "");
		requestedPath = segments
			.slice(3)
			.map((segment) => decodeURIComponent(segment))
			.join("/");
	} catch {
		return null;
	}
	if (!requestedPath || requestedPath.includes("\0")) return null;
	const source = sources.find((candidate) => candidate.extensionManifestId === extensionManifestId);
	if (!source) return null;

	const filePath = path.resolve(source.assetRootDir, requestedPath);
	if (!isWithinDirectory(source.assetRootDir, filePath) || filePath === source.assetRootDir) {
		return null;
	}
	return { filePath, search: url.search };
}
