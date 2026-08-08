import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const SOURCE_FILE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".svelte",
]);
const FORBIDDEN_PROCESS_SDK_INTERNAL_PATTERNS = [
	"@leitwerk-dev/process-sdk/internal",
	"markDefinedProcess",
	"setProcessTurnTransitions",
];
const EXTENSION_UI_ALLOWED_RUNTIME_BARE_SPECIFIERS = new Set([
	"@leitwerk-dev/process-sdk/leaf-outcome-renderer",
]);

main();

function main() {
	const rootDir = process.cwd();
	const rootPackageJson = readJson(path.join(rootDir, "package.json"));
	const workspacePatterns = Array.isArray(rootPackageJson.workspaces)
		? rootPackageJson.workspaces.filter((value) => typeof value === "string")
		: [];
	const composition = activateDevelopmentComposition(rootDir);
	const workspaces = dedupeWorkspaceInfos([
		...listWorkspaceInfos(rootDir, workspacePatterns),
		...listComposedWorkspaceInfos(composition),
	]);
	const extensionPackageNames = new Set(
		workspaces
			.filter((workspace) => workspace.kind === "extension")
			.map((workspace) => workspace.name),
	);

	const violations = [
		...checkPackageDependencyBoundaries(workspaces, extensionPackageNames),
		...checkSourceImportBoundaries(rootDir, workspaces, extensionPackageNames),
		...checkExtensionUiRuntimeImportBoundaries(workspaces),
		...checkBuiltExtensionUiBundles(workspaces),
		...checkServerWorkerProductionBoundary(rootDir),
		...checkServerProcessModelPolicyBoundary(rootDir),
		...checkWorkerProductionSurfaceForTestHelpers(rootDir),
		...checkWorkerRuntimeInternalBoundaries(rootDir),
		...checkProcessSdkInternalEscapeHatches(rootDir),
		...checkServerTestGraphShapedFixtures(rootDir),
	];

	if (violations.length === 0) {
		console.info("[check:boundaries] OK");
		return;
	}

	console.error("[check:boundaries] Found boundary violations:\n");
	for (const violation of violations) {
		console.error(`- ${violation}`);
	}
	process.exit(1);
}

function listWorkspaceInfos(rootDir, workspacePatterns) {
	const infos = [];
	for (const pattern of workspacePatterns) {
		if (!pattern.endsWith("/*")) {
			continue;
		}
		const baseDir = path.join(rootDir, pattern.slice(0, -2));
		if (!existsSync(baseDir)) {
			continue;
		}
		for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = path.join(baseDir, entry.name);
			const packageJsonPath = path.join(dir, "package.json");
			if (!existsSync(packageJsonPath)) {
				continue;
			}
			const packageJson = readJson(packageJsonPath);
			if (typeof packageJson.name !== "string") {
				continue;
			}
			infos.push({
				name: packageJson.name,
				dir,
				packageJson,
				kind: dir.includes(`${path.sep}extensions${path.sep}`) ? "extension" : "package",
			});
		}
	}
	return infos.sort((left, right) => left.dir.localeCompare(right.dir));
}

function listComposedWorkspaceInfos(composition) {
	if (!composition) return [];
	const extensionDirs = new Set(composition.extensionDirs);
	return composition.externalPackages.map((entry) => ({
		name: entry.name,
		dir: entry.dir,
		packageJson: entry.packageJson,
		kind: extensionDirs.has(entry.dir) ? "extension" : "package",
	}));
}

function dedupeWorkspaceInfos(workspaces) {
	return [...new Map(workspaces.map((workspace) => [workspace.dir, workspace])).values()].sort(
		(left, right) => left.dir.localeCompare(right.dir),
	);
}

function checkPackageDependencyBoundaries(workspaces, extensionPackageNames) {
	const violations = [];
	for (const workspace of workspaces) {
		if (workspace.kind !== "package") {
			continue;
		}
		for (const fieldName of DEPENDENCY_FIELDS) {
			const field = workspace.packageJson[fieldName];
			if (!isRecord(field)) {
				continue;
			}
			for (const dependencyName of Object.keys(field)) {
				if (extensionPackageNames.has(dependencyName)) {
					violations.push(
						`${relativeToRoot(workspace.dir)} package.json ${fieldName} must not depend on extension workspace '${dependencyName}'`,
					);
				}
			}
		}
	}
	return violations;
}

function checkSourceImportBoundaries(rootDir, workspaces, extensionPackageNames) {
	const violations = [];
	for (const workspace of workspaces) {
		if (workspace.kind !== "package") {
			continue;
		}
		for (const filePath of walkSourceFiles(workspace.dir)) {
			for (const specifier of extractModuleSpecifiers(readFileSync(filePath, "utf8"))) {
				const extensionPackageName = getBarePackageName(specifier);
				if (extensionPackageName && extensionPackageNames.has(extensionPackageName)) {
					violations.push(`${relativeToRoot(filePath)} imports extension workspace '${specifier}'`);
					continue;
				}
				if (!isPathLike(specifier)) {
					continue;
				}
				const resolved = resolveImportPath(path.dirname(filePath), specifier);
				if (resolved && isWithinExtensionsDir(rootDir, resolved)) {
					violations.push(
						`${relativeToRoot(filePath)} imports extension source path '${specifier}'`,
					);
				}
			}
		}
	}
	return violations;
}

function checkExtensionUiRuntimeImportBoundaries(workspaces) {
	const violations = [];
	for (const workspace of workspaces) {
		if (workspace.kind !== "extension") {
			continue;
		}
		const uiSourceDir = path.join(workspace.dir, "src", "ui");
		if (!existsSync(uiSourceDir)) {
			continue;
		}
		const pendingFiles = walkSourceFiles(uiSourceDir).filter((filePath) =>
			isProductionSourceFile(filePath),
		);
		const visitedFiles = new Set();
		while (pendingFiles.length > 0) {
			const filePath = pendingFiles.shift();
			if (!filePath || visitedFiles.has(filePath)) {
				continue;
			}
			visitedFiles.add(filePath);
			const sourceText = readFileSync(filePath, "utf8");
			for (const moduleImport of extractModuleImports(sourceText)) {
				if (moduleImport.typeOnly) {
					continue;
				}
				const specifier = moduleImport.specifier;
				if (!isPathLike(specifier)) {
					if (!EXTENSION_UI_ALLOWED_RUNTIME_BARE_SPECIFIERS.has(specifier)) {
						violations.push(
							`${relativeToRoot(filePath)} extension UI runtime imports '${specifier}'. Browser renderer code must use relative modules or '${[...EXTENSION_UI_ALLOWED_RUNTIME_BARE_SPECIFIERS].join("', '")}' so built extension UI bundles do not leak unresolved bare specifiers.`,
						);
					}
					continue;
				}
				if (!specifier.startsWith(".") && !specifier.startsWith("file:")) {
					continue;
				}
				const resolved = resolveSourceImportFile(path.dirname(filePath), specifier);
				if (!resolved || !isProductionSourceFile(resolved)) {
					continue;
				}
				if (!isWithinDirectory(workspace.dir, resolved)) {
					violations.push(
						`${relativeToRoot(filePath)} extension UI runtime imports source outside its extension workspace via '${specifier}'`,
					);
					continue;
				}
				if (!visitedFiles.has(resolved)) {
					pendingFiles.push(resolved);
				}
			}
		}
	}
	return violations;
}

function checkBuiltExtensionUiBundles(workspaces) {
	const violations = [];
	for (const workspace of workspaces) {
		if (workspace.kind !== "extension") {
			continue;
		}
		const manifestPath = getExtensionUiManifestPath(workspace);
		if (!manifestPath || !existsSync(manifestPath)) {
			continue;
		}
		const uiOutDir = path.dirname(manifestPath);
		for (const filePath of walkFilesWithExtensions(uiOutDir, new Set([".js"]))) {
			const sourceText = readFileSync(filePath, "utf8");
			for (const moduleImport of extractModuleImports(sourceText)) {
				if (
					!isBrowserResolvableModuleSpecifier(moduleImport.specifier) &&
					!EXTENSION_UI_ALLOWED_RUNTIME_BARE_SPECIFIERS.has(moduleImport.specifier)
				) {
					violations.push(
						`${relativeToRoot(filePath)} built extension UI bundle contains browser-unresolvable bare import '${moduleImport.specifier}'`,
					);
				}
			}
		}
	}
	return violations;
}

function getExtensionUiManifestPath(workspace) {
	const leitwerk = workspace.packageJson.leitwerk;
	if (!isRecord(leitwerk) || !isRecord(leitwerk.ui)) {
		return null;
	}
	const manifest = leitwerk.ui.import;
	return typeof manifest === "string" ? path.resolve(workspace.dir, manifest) : null;
}

function checkServerWorkerProductionBoundary(rootDir) {
	const violations = [];
	const serverPackagePath = path.join(rootDir, "packages/server/package.json");
	if (existsSync(serverPackagePath)) {
		const packageJson = readJson(serverPackagePath);
		if (isRecord(packageJson.dependencies) && "@leitwerk-dev/worker" in packageJson.dependencies) {
			violations.push(
				"packages/server/package.json dependencies must not include production dependency '@leitwerk-dev/worker'",
			);
		}
	}

	const serverSrcDir = path.join(rootDir, "packages/server/src");
	if (!existsSync(serverSrcDir)) {
		return violations;
	}
	for (const filePath of walkSourceFiles(serverSrcDir)) {
		const relativePath = relativeToRoot(filePath);
		if (relativePath.includes(".test.")) {
			continue;
		}
		for (const specifier of extractModuleSpecifiers(readFileSync(filePath, "utf8"))) {
			if (getBarePackageName(specifier) === "@leitwerk-dev/worker") {
				violations.push(`${relativePath} production server source must not import '${specifier}'`);
			}
		}
	}
	return violations;
}

function checkServerProcessModelPolicyBoundary(rootDir) {
	const violations = [];
	const moduleDir = path.join(rootDir, "packages/server/src/process-model-policy");
	const serverSrcDir = path.join(rootDir, "packages/server/src");
	if (!existsSync(moduleDir) || !existsSync(serverSrcDir)) {
		return violations;
	}

	const interfacePath = path.join(moduleDir, "index.ts");
	for (const filePath of walkSourceFiles(serverSrcDir)) {
		if (isWithinDirectory(moduleDir, filePath)) {
			continue;
		}
		for (const specifier of extractModuleSpecifiers(readFileSync(filePath, "utf8"))) {
			if (!isPathLike(specifier)) {
				continue;
			}
			const resolved = resolveSourceImportFile(path.dirname(filePath), specifier);
			if (resolved && isWithinDirectory(moduleDir, resolved) && resolved !== interfacePath) {
				violations.push(
					`${relativeToRoot(filePath)} imports process-model-policy implementation '${specifier}'. Import the module interface via process-model-policy/index.js instead.`,
				);
			}
		}
	}
	return violations;
}

function checkWorkerProductionSurfaceForTestHelpers(rootDir) {
	const violations = [];
	const workerPackagePath = path.join(rootDir, "packages/worker/package.json");
	if (existsSync(workerPackagePath)) {
		const packageJson = readJson(workerPackagePath);
		if (isRecord(packageJson.exports) && "./testing" in packageJson.exports) {
			violations.push("packages/worker/package.json must not export './testing'");
		}
	}
	const workerTsupPath = path.join(rootDir, "packages/worker/tsup.config.ts");
	if (existsSync(workerTsupPath)) {
		const sourceText = readFileSync(workerTsupPath, "utf8");
		if (sourceText.includes("src/testing.ts") || sourceText.includes("src/test-helpers")) {
			violations.push(
				"packages/worker/tsup.config.ts must not build worker testing/test-helper entrypoints",
			);
		}
	}
	const forbidden = ["test-helpers", "StubPi", "LEITWERK_TEST_STUB_PI", "schema-driven-stub"];
	const relativeFiles = [
		"packages/worker/src/index.ts",
		"packages/worker/src/entry-runtime.ts",
		"packages/worker/src/worker-entry.ts",
		"packages/worker/src/pi-adapter.ts",
	];
	for (const relativePath of relativeFiles) {
		const filePath = path.join(rootDir, relativePath);
		if (!existsSync(filePath)) {
			continue;
		}
		const sourceText = readFileSync(filePath, "utf8");
		for (const token of forbidden) {
			if (sourceText.includes(token)) {
				violations.push(
					`${relativePath} production worker surface must not reference test helper token '${token}'`,
				);
			}
		}
	}
	return violations;
}

function checkWorkerRuntimeInternalBoundaries(rootDir) {
	const violations = [];
	const internalDir = path.join(rootDir, "packages/worker/src/runtime");
	const runtimeEntrypoint = path.join(internalDir, "index.ts");
	const publicEntrypoints = new Set([
		path.join(rootDir, "packages/worker/src/index.ts"),
		path.join(rootDir, "packages/worker/src/entry-runtime.ts"),
	]);
	for (const relativeScanDir of ["packages", "extensions", "tests"]) {
		const scanDir = path.join(rootDir, relativeScanDir);
		if (!existsSync(scanDir)) continue;
		for (const filePath of walkSourceFiles(scanDir)) {
			if (isWithinDirectory(internalDir, filePath)) continue;
			for (const specifier of extractModuleSpecifiers(readFileSync(filePath, "utf8"))) {
				if (specifier.startsWith("@leitwerk-dev/worker/runtime")) {
					violations.push(
						`${relativeToRoot(filePath)} must import the public '@leitwerk-dev/worker' interface, not '${specifier}'`,
					);
					continue;
				}
				const resolved = isPathLike(specifier)
					? resolveSourceImportFile(path.dirname(filePath), specifier)
					: null;
				if (
					resolved &&
					isWithinDirectory(internalDir, resolved) &&
					!(resolved === runtimeEntrypoint && publicEntrypoints.has(filePath))
				) {
					violations.push(
						`${relativeToRoot(filePath)} must not import internal module '${specifier}'`,
					);
				}
			}
		}
	}
	return violations;
}

function checkProcessSdkInternalEscapeHatches(rootDir) {
	const violations = [];
	for (const relativeDir of ["packages/server", "extensions", "tests"]) {
		const absoluteDir = path.join(rootDir, relativeDir);
		if (!existsSync(absoluteDir)) {
			continue;
		}
		for (const filePath of walkSourceFiles(absoluteDir)) {
			const sourceText = readFileSync(filePath, "utf8");
			for (const forbidden of FORBIDDEN_PROCESS_SDK_INTERNAL_PATTERNS) {
				if (sourceText.includes(forbidden)) {
					violations.push(`${relativeToRoot(filePath)} must not reference '${forbidden}'`);
				}
			}
		}
	}
	return violations;
}

function checkServerTestGraphShapedFixtures(rootDir) {
	const violations = [];
	const roots = [path.join(rootDir, "packages/server/src"), path.join(rootDir, "tests")];
	for (const root of roots) {
		if (!existsSync(root)) {
			continue;
		}
		for (const filePath of walkSourceFiles(root)) {
			const relativePath = relativeToRoot(filePath);
			const isServerTestSource =
				relativePath.includes(".test.") ||
				relativePath.startsWith("packages/server/src/test-helpers/");
			const isTopLevelTestSource = relativePath.startsWith("tests/");
			if (!isServerTestSource && !isTopLevelTestSource) {
				continue;
			}
			const sourceText = readFileSync(filePath, "utf8");
			if (/\btransitions\s*:/u.test(sourceText)) {
				violations.push(
					`${relativePath} must author process routes with defineProcess turn outcomes/actions instead of graph-shaped transitions`,
				);
			}
		}
	}
	return violations;
}

function walkSourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "dist" || entry.name === "node_modules") {
			continue;
		}
		const absolutePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkSourceFiles(absolutePath));
			continue;
		}
		if (!SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
			continue;
		}
		files.push(absolutePath);
	}
	return files;
}

function walkFilesWithExtensions(dir, extensions) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") {
			continue;
		}
		const absolutePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkFilesWithExtensions(absolutePath, extensions));
			continue;
		}
		if (extensions.has(path.extname(entry.name))) {
			files.push(absolutePath);
		}
	}
	return files;
}

function extractModuleSpecifiers(sourceText) {
	return [
		...new Set(extractModuleImports(sourceText).map((moduleImport) => moduleImport.specifier)),
	];
}

function extractModuleImports(sourceText) {
	const imports = [];
	const seen = new Set();
	const patterns = [
		{ typeOnly: true, pattern: /\bimport\s+type\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu },
		{ typeOnly: false, pattern: /\bimport\s+(?!type\b)(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu },
		{ typeOnly: true, pattern: /\bexport\s+type\s+[^"']+?\s+from\s+["']([^"']+)["']/gu },
		{ typeOnly: false, pattern: /\bexport\s+(?!type\b)(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu },
		{ typeOnly: false, pattern: /\bimport\(\s*["']([^"']+)["']\s*\)/gu },
	];
	for (const { typeOnly, pattern } of patterns) {
		let match = pattern.exec(sourceText);
		while (match !== null) {
			if (match[1]) {
				const key = `${typeOnly ? "type" : "runtime"}:${match[1]}`;
				if (!seen.has(key)) {
					seen.add(key);
					imports.push({ specifier: match[1], typeOnly });
				}
			}
			match = pattern.exec(sourceText);
		}
	}
	return imports;
}

function getBarePackageName(specifier) {
	if (isPathLike(specifier) || specifier.startsWith("#")) {
		return null;
	}
	if (!specifier.startsWith("@")) {
		return specifier.split("/")[0] ?? null;
	}
	const parts = specifier.split("/");
	if (parts.length < 2) {
		return null;
	}
	return `${parts[0]}/${parts[1]}`;
}

function isPathLike(specifier) {
	return (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/") ||
		specifier.startsWith("file:")
	);
}

function resolveImportPath(fromDir, specifier) {
	if (specifier.startsWith("file:")) {
		return new URL(specifier).pathname;
	}
	return path.resolve(fromDir, specifier);
}

function resolveSourceImportFile(fromDir, specifier) {
	const resolvedPath = stripSpecifierSuffix(resolveImportPath(fromDir, specifier));
	for (const candidate of buildSourceImportCandidates(resolvedPath)) {
		if (isExistingFile(candidate)) {
			return candidate;
		}
	}
	return null;
}

function stripSpecifierSuffix(specifier) {
	return specifier.split(/[?#]/u)[0] ?? specifier;
}

function buildSourceImportCandidates(resolvedPath) {
	const extension = path.extname(resolvedPath);
	if (extension) {
		const candidates = [resolvedPath];
		if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
			const extensionlessPath = resolvedPath.slice(0, -extension.length);
			for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts", ".svelte"]) {
				candidates.push(`${extensionlessPath}${sourceExtension}`);
			}
		}
		return candidates;
	}
	const candidates = [];
	for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
		candidates.push(`${resolvedPath}${sourceExtension}`);
	}
	for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
		candidates.push(path.join(resolvedPath, `index${sourceExtension}`));
	}
	return candidates;
}

function isExistingFile(filePath) {
	try {
		return existsSync(filePath) && statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isBrowserResolvableModuleSpecifier(specifier) {
	return (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/") ||
		specifier.startsWith("http://") ||
		specifier.startsWith("https://") ||
		specifier.startsWith("data:") ||
		specifier.startsWith("blob:")
	);
}

function isProductionSourceFile(filePath) {
	const basename = path.basename(filePath);
	return !basename.includes(".test.") && !basename.includes(".spec.");
}

function isWithinDirectory(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isWithinExtensionsDir(rootDir, targetPath) {
	const extensionsDir = path.join(rootDir, "extensions");
	const relative = path.relative(extensionsDir, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeToRoot(targetPath) {
	return path.relative(process.cwd(), targetPath) || ".";
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
