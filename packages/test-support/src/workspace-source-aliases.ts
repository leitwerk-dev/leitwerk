import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface RootPackageJson {
	workspaces?: string[] | { packages?: string[] };
}

interface WorkspacePackageJson {
	name?: string;
	exports?: unknown;
}

interface JsonRecord {
	[key: string]: unknown;
}

export interface WorkspaceSourceAlias {
	find: RegExp;
	replacement: string;
}

export function buildWorkspaceSourceAliases(rootDir: string): WorkspaceSourceAlias[] {
	const aliases = listWorkspacePackageDirs(rootDir).flatMap((packageDir) =>
		buildAliasesForPackage(packageDir),
	);

	return aliases.sort((left, right) => {
		const lengthDelta = right.find.source.length - left.find.source.length;
		if (lengthDelta !== 0) {
			return lengthDelta;
		}
		return left.find.source.localeCompare(right.find.source);
	});
}

function buildAliasesForPackage(packageDir: string): WorkspaceSourceAlias[] {
	const packageJson = readJson<WorkspacePackageJson>(path.join(packageDir, "package.json"));
	if (!packageJson.name) {
		return [];
	}

	return listPackageExportTargets(packageJson.name, packageJson.exports).flatMap(
		({ specifier, importTarget }) => {
			const replacement = resolveSourceFile(packageDir, importTarget);
			if (!replacement) {
				return [];
			}
			return [{ find: createExactSpecifierPattern(specifier), replacement }];
		},
	);
}

function listWorkspacePackageDirs(rootDir: string): string[] {
	const rootPackageJson = readJson<RootPackageJson>(path.join(rootDir, "package.json"));
	const workspacePatterns = Array.isArray(rootPackageJson.workspaces)
		? rootPackageJson.workspaces
		: (rootPackageJson.workspaces?.packages ?? []);

	return workspacePatterns
		.flatMap((pattern) => expandWorkspacePattern(rootDir, pattern))
		.filter((packageDir, index, dirs) => dirs.indexOf(packageDir) === index)
		.sort((left, right) => left.localeCompare(right));
}

function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
	if (pattern.endsWith("/*")) {
		const baseDir = path.join(rootDir, pattern.slice(0, -2));
		if (!existsSync(baseDir)) {
			return [];
		}
		return readdirSync(baseDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(baseDir, entry.name))
			.filter((packageDir) => existsSync(path.join(packageDir, "package.json")));
	}

	const packageDir = path.join(rootDir, pattern);
	return existsSync(path.join(packageDir, "package.json")) ? [packageDir] : [];
}

function listPackageExportTargets(
	packageName: string,
	exportsField: unknown,
): Array<{ specifier: string; importTarget: string }> {
	if (!exportsField) {
		return [];
	}

	if (isPackageSubpathExportMap(exportsField)) {
		return Object.entries(exportsField).flatMap(([subpath, exportValue]) => {
			const importTarget = resolveImportTarget(exportValue);
			if (!importTarget) {
				return [];
			}
			const specifier = subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
			return [{ specifier, importTarget }];
		});
	}

	const importTarget = resolveImportTarget(exportsField);
	return importTarget ? [{ specifier: packageName, importTarget }] : [];
}

function isPackageSubpathExportMap(value: unknown): value is JsonRecord {
	if (!isJsonRecord(value)) {
		return false;
	}
	return Object.keys(value).some((key) => key === "." || key.startsWith("./"));
}

function resolveImportTarget(exportValue: unknown): string | null {
	if (typeof exportValue === "string") {
		return exportValue;
	}
	if (!isJsonRecord(exportValue)) {
		return null;
	}
	if (typeof exportValue.import === "string") {
		return exportValue.import;
	}
	if (typeof exportValue.default === "string") {
		return exportValue.default;
	}
	return null;
}

function resolveSourceFile(packageDir: string, importTarget: string): string | null {
	const normalizedTarget = importTarget.startsWith("./") ? importTarget.slice(2) : importTarget;
	for (const candidate of buildSourceCandidates(normalizedTarget)) {
		const absoluteCandidate = path.join(packageDir, candidate);
		if (existsSync(absoluteCandidate)) {
			return absoluteCandidate;
		}
	}
	return null;
}

function buildSourceCandidates(importTarget: string): string[] {
	const srcTarget = importTarget.startsWith("dist/")
		? `src/${importTarget.slice("dist/".length)}`
		: importTarget;
	const extensionlessTarget = srcTarget.replace(/\.(?:[cm]?js)$/, "");

	return [
		`${extensionlessTarget}.ts`,
		`${extensionlessTarget}.tsx`,
		`${extensionlessTarget}.mts`,
		`${extensionlessTarget}.cts`,
		srcTarget,
	];
}

function createExactSpecifierPattern(specifier: string): RegExp {
	return new RegExp(`^${escapeRegExp(specifier)}$`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
