import { spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const REQUIRED_FILE_PATTERNS = ["dist/**", "src/**", "!dist/**/*.test.*", "!src/**/*.test.ts"];
const REPOSITORY_URL = "git+https://github.com/leitwerk-dev/leitwerk.git";
const STAGED_LICENSE_PATH = "./dist/LICENSE";
const VALID_MODES = new Set(["check", "dry-run", "preflight", "publish", "verify"]);

main();

function main() {
	const mode = process.argv[2] ?? "check";
	if (!VALID_MODES.has(mode)) {
		fail(
			`Unknown publish workspace mode '${mode}'. Expected one of: ${[...VALID_MODES].join(", ")}`,
		);
	}

	const rootDir = process.cwd();
	const rootPackageJson = readJson(path.join(rootDir, "package.json"));
	const rootVersion = rootPackageJson.version;
	if (typeof rootVersion !== "string" || rootVersion.length === 0) {
		throw new Error("Expected root package.json version to be a non-empty string");
	}
	const workspaces = listPublishableWorkspaces(rootDir, rootPackageJson);
	const workspaceNames = new Set(workspaces.map((workspace) => workspace.name));
	const errors = validateWorkspaces({ rootDir, rootVersion, workspaces, workspaceNames });

	if (mode === "preflight" || mode === "publish" || mode === "verify") {
		errors.push(...validatePublishRef(rootVersion));
	}
	if (errors.length > 0) {
		fail(`[publish:${mode}] Validation failed:`, errors);
	}
	if (mode === "check") {
		console.info(`[publish:check] OK (${workspaces.length} workspaces)`);
		return;
	}

	if (mode === "dry-run") {
		runPackDryRun(rootDir, workspaces);
		console.info(`[publish:dry-run] OK (${workspaces.length} workspaces)`);
		return;
	}
	const expectedGitSha = readExpectedGitSha(rootDir);
	if (mode === "preflight") {
		const alreadyPublished = findPublishedWorkspaces(workspaces, expectedGitSha);
		console.info(
			`[publish:preflight] OK (${workspaces.length - alreadyPublished.size} unpublished, ${alreadyPublished.size} already published)`,
		);
		return;
	}
	if (mode === "verify") {
		const published = findPublishedWorkspaces(workspaces, expectedGitSha);
		if (published.size !== workspaces.length) {
			fail(
				`[publish:verify] ${workspaces.length - published.size} workspace versions are not public`,
			);
		}
		console.info(`[publish:verify] OK (${published.size} workspaces)`);
		return;
	}
	const alreadyPublished = findPublishedWorkspaces(workspaces, expectedGitSha);
	const unpublished = workspaces.filter((workspace) => !alreadyPublished.has(workspace.name));
	publishWorkspaces(rootDir, unpublished);
	console.info(
		`[publish:workspaces] Complete (${unpublished.length} published, ${alreadyPublished.size} already published)`,
	);
}

function fail(header, errors = [], exitCode = 1) {
	console.error(errors.length > 0 ? `${header}\n- ${errors.join("\n- ")}` : header);
	process.exit(exitCode);
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function listPublishableWorkspaces(rootDir, rootPackageJson) {
	return (Array.isArray(rootPackageJson.workspaces) ? rootPackageJson.workspaces : [])
		.filter((pattern) => typeof pattern === "string" && pattern.endsWith("/*"))
		.flatMap((pattern) => {
			const baseDir = path.join(rootDir, pattern.slice(0, -2));
			if (!existsSync(baseDir)) {
				return [];
			}
			return readdirSync(baseDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(baseDir, entry.name, "package.json"))
				.filter((packageJsonPath) => existsSync(packageJsonPath))
				.map((packageJsonPath) => {
					const packageJson = readJson(packageJsonPath);
					return {
						name: packageJson.name,
						dir: path.dirname(packageJsonPath),
						packageJson,
						requiredFiles: requiredPackageFiles(packageJson),
					};
				})
				.filter((workspace) => typeof workspace.name === "string");
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function dependencyEntries(packageJson, fields) {
	return fields.flatMap((fieldName) =>
		isRecord(packageJson[fieldName])
			? Object.entries(packageJson[fieldName]).map(([name, version]) => [fieldName, name, version])
			: [],
	);
}

function validateWorkspaces({ rootDir, rootVersion, workspaces, workspaceNames }) {
	const rootLicensePath = path.join(rootDir, "LICENSE");
	const rootLicenseText = existsSync(rootLicensePath)
		? readFileSync(rootLicensePath, "utf8")
		: null;
	const errors = rootLicenseText ? [] : ["root LICENSE is missing"];
	for (const workspace of workspaces) {
		const { dir, name, packageJson } = workspace;
		const label = `${relative(rootDir, dir)} (${name})`;
		for (const [ok, message] of [
			[packageJson.private !== true, "must not set private:true"],
			[
				packageJson.version === rootVersion,
				`version '${packageJson.version}' must match root version '${rootVersion}'`,
			],
			[packageJson.license === "Apache-2.0", "license must be Apache-2.0"],
			[packageJson.publishConfig?.access === "public", "publishConfig.access must be public"],
			[packageJson.repository?.url === REPOSITORY_URL, `repository.url must be ${REPOSITORY_URL}`],
			[
				packageJson.repository?.directory === relative(rootDir, dir),
				`repository.directory must be ${relative(rootDir, dir)}`,
			],
			[
				isSupportedNodeRange(packageJson.engines?.node),
				"engines.node must declare an explicit >=22 minimum",
			],
		]) {
			if (!ok) {
				errors.push(`${label}: ${message}`);
			}
		}

		if (!Array.isArray(packageJson.files)) {
			errors.push(`${label}: files must be declared for predictable npm packages`);
		} else {
			for (const pattern of REQUIRED_FILE_PATTERNS) {
				if (!packageJson.files.includes(pattern)) {
					errors.push(`${label}: files must include ${pattern}`);
				}
			}
		}

		for (const [fieldName, dependencyName, dependencyVersion] of dependencyEntries(
			packageJson,
			DEPENDENCY_FIELDS,
		)) {
			if (workspaceNames.has(dependencyName) && dependencyVersion !== rootVersion) {
				errors.push(
					`${label}: ${fieldName}.${dependencyName} must be '${rootVersion}' for lockstep publishing`,
				);
			}
		}
		if (
			name === "@leitwerk-dev/server" &&
			packageJson.optionalDependencies?.["@leitwerk-dev/worker"] !== rootVersion
		) {
			errors.push(
				`${label}: optionalDependencies.@leitwerk-dev/worker must be '${rootVersion}' so the published server can spawn the default worker`,
			);
		}

		for (const targetPattern of workspace.requiredFiles) {
			const targetPaths = expandPackagePattern(dir, targetPattern);
			if (targetPaths.length === 0) {
				errors.push(
					`${label}: required package path ${targetPattern} is missing; run npm run parity:build`,
				);
				continue;
			}
			for (const targetPath of targetPaths) {
				if (
					targetPath === STAGED_LICENSE_PATH &&
					rootLicenseText !== null &&
					readFileSync(path.join(dir, targetPath), "utf8") !== rootLicenseText
				) {
					errors.push(`${label}: ${STAGED_LICENSE_PATH} must match the root LICENSE`);
				}
			}
		}

		const manifest = packageJson.leitwerk?.ui?.import;
		if (typeof manifest === "string" && existsSync(path.join(dir, manifest))) {
			errors.push(...validateExtensionUiManifest(rootDir, path.join(dir, manifest), label));
		}
	}
	return errors;
}

function validateExtensionUiManifest(rootDir, manifestPath, label) {
	const manifest = readJson(manifestPath);
	const moduleRefs = [
		...Object.entries(isRecord(manifest.renderers) ? manifest.renderers : {}).map(([id, ref]) => [
			`renderer '${id}'`,
			ref,
		]),
		...(Array.isArray(manifest.browserModules) ? manifest.browserModules : []).map((ref, index) => [
			`browserModules[${index}]`,
			ref,
		]),
	];
	if (moduleRefs.length === 0) {
		return [`${label}: extension UI manifest must declare at least one renderer or browser module`];
	}
	return moduleRefs.flatMap(([refLabel, ref]) => {
		if (!isRecord(ref) || typeof ref.module !== "string") {
			return [`${label}: ${refLabel} must declare a module path`];
		}
		const modulePath = path.join(path.dirname(manifestPath), ref.module);
		return existsSync(modulePath)
			? []
			: [`${label}: ${refLabel} module ${relative(rootDir, modulePath)} is missing`];
	});
}

function requiredPackageFiles(packageJson) {
	return [
		...new Set([
			STAGED_LICENSE_PATH,
			...collectPackagePaths(packageJson.exports),
			packageJson.leitwerk?.extension?.import,
			packageJson.leitwerk?.extension?.source,
			packageJson.leitwerk?.ui?.import,
			packageJson.leitwerk?.ui?.source,
		]),
	]
		.filter((filePath) => typeof filePath === "string" && filePath.startsWith("./"))
		.sort((left, right) => left.localeCompare(right));
}

function expandPackagePattern(dir, filePattern) {
	if (!/[?*[]/u.test(filePattern)) {
		return existsSync(path.join(dir, filePattern)) ? [filePattern] : [];
	}
	return globSync(filePattern.slice(2), { cwd: dir })
		.filter((filePath) => !/(^|\/)[^/]+\.test\./u.test(filePath))
		.map((filePath) => `./${filePath}`)
		.sort((left, right) => left.localeCompare(right));
}

function isSupportedNodeRange(range) {
	return typeof range === "string" && /^>=\s*22(?:\.\d+(?:\.\d+)?)?(?:\s|$)/u.test(range);
}

function collectPackagePaths(value) {
	if (typeof value === "string") {
		return value.startsWith("./") ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.flatMap(collectPackagePaths);
	}
	return isRecord(value) ? Object.values(value).flatMap(collectPackagePaths) : [];
}

function validatePublishRef(rootVersion) {
	const refType = process.env.GITHUB_REF_TYPE;
	const refName = process.env.GITHUB_REF_NAME;
	const expectedTag = `v${rootVersion}`;
	return refType === "tag" && refName === expectedTag
		? []
		: [
				`publish must run from tag ${expectedTag}; got GITHUB_REF_TYPE=${refType ?? "<unset>"} GITHUB_REF_NAME=${refName ?? "<unset>"}`,
			];
}

function runPackDryRun(rootDir, workspaces) {
	const packumentsByName = new Map(
		JSON.parse(
			runNpm(["pack", "--dry-run", "--workspaces", "--json"], { cwd: rootDir }).stdout,
		).map((packument) => [packument.name, packument]),
	);
	for (const workspace of workspaces) {
		const packument = packumentsByName.get(workspace.name);
		const filePaths = new Set((packument?.files ?? []).map((file) => file.path));
		const requiredFiles = [
			"package.json",
			STAGED_LICENSE_PATH.slice(2),
			...workspace.requiredFiles.flatMap((filePattern) =>
				expandPackagePattern(workspace.dir, filePattern).map((filePath) => filePath.slice(2)),
			),
		];
		const errors = [
			...(packument ? [] : [`${workspace.name}: npm pack did not return a workspace packument`]),
			...requiredFiles
				.filter((filePath) => !filePaths.has(filePath))
				.map((filePath) => `${workspace.name}: npm pack did not include ${filePath}`),
			...[...filePaths]
				.filter((filePath) => /(^|\/)(tests\/|[^/]+\.test\.)/u.test(filePath))
				.sort((left, right) => left.localeCompare(right))
				.map((filePath) => `${workspace.name}: npm pack unexpectedly included ${filePath}`),
		];
		if (errors.length > 0) {
			fail("[publish:dry-run] Package contents check failed:", errors);
		}
		console.info(`${workspace.name}: dry-run pack OK (${packument.files.length} files)`);
	}
}

function findPublishedWorkspaces(workspaces, expectedGitSha) {
	const published = new Set();
	for (const workspace of workspaces) {
		const spec = `${workspace.name}@${workspace.packageJson.version}`;
		const result = runNpm(["view", spec, "version", "gitHead", "--json"], {
			allowFailure: true,
		});
		if (result.status === 0) {
			const metadata = JSON.parse(result.stdout);
			if (metadata.version !== workspace.packageJson.version) {
				fail(`${spec} returned an unexpected version from npm.`);
			}
			if (metadata.gitHead !== expectedGitSha) {
				fail(
					`${spec} already exists for Git revision ${metadata.gitHead ?? "<missing>"}; expected ${expectedGitSha}.`,
				);
			}
			console.info(`[publish:preflight] ${spec} already exists; it will not be republished`);
			published.add(workspace.name);
			continue;
		}
		if (!String(result.stderr).includes("E404") && !String(result.stderr).includes("404")) {
			writeOutput(result.stdout);
			writeOutput(result.stderr);
			fail(`Could not verify whether ${spec} exists on npm.`, [], result.status ?? 1);
		}
	}
	return published;
}

function readExpectedGitSha(rootDir) {
	const configured = process.env.RELEASE_GIT_SHA;
	if (configured) {
		if (!/^[a-f0-9]{40}$/u.test(configured)) fail(`RELEASE_GIT_SHA is invalid: ${configured}`);
		return configured;
	}
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" });
	if (result.status !== 0) fail("Could not resolve the release Git revision.");
	return result.stdout.trim();
}

function publishWorkspaces(rootDir, workspaces) {
	if (workspaces.length === 0) {
		return;
	}
	const workspaceArgs = workspaces.flatMap((workspace) => ["--workspace", workspace.name]);
	const args = ["publish", ...workspaceArgs, "--access", "public"];
	console.info(
		`[publish:workspaces] publishing ${workspaces.length} workspaces in one npm session`,
	);
	runNpm(args, { cwd: rootDir, stdio: "inherit" });
}

function runNpm(args, options = {}) {
	const result = spawnSync("npm", args, {
		cwd: options.cwd,
		encoding: options.stdio ? undefined : "utf8",
		stdio: options.stdio,
	});
	if (!options.allowFailure && result.status !== 0) {
		writeOutput(result.stdout);
		writeOutput(result.stderr);
		process.exit(result.status ?? 1);
	}
	return result;
}

function writeOutput(output) {
	if (output) {
		process.stderr.write(output);
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(rootDir, filePath) {
	return path.relative(rootDir, filePath) || ".";
}
