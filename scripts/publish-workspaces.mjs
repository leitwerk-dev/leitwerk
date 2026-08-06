import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const REQUIRED_FILE_PATTERNS = ["dist/**", "src/**", "!src/**/*.test.ts"];
const STAGED_LICENSE_PATH = "./dist/LICENSE";
const VALID_MODES = new Set(["check", "dry-run", "publish"]);

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

	if (mode === "publish") {
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
	if (process.env.CI && !process.env.NODE_AUTH_TOKEN) {
		fail("[publish:workspaces] NODE_AUTH_TOKEN is required in CI for npm publish.");
	}
	rejectAlreadyPublishedVersions(workspaces);
	publishWorkspaces(rootDir, workspaces);
	console.info(`[publish:workspaces] Published ${workspaces.length} workspaces`);
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
			[packageJson.engines?.node === ">=22", "engines.node must be >=22"],
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

		for (const targetPath of workspace.requiredFiles) {
			const absoluteTargetPath = path.join(dir, targetPath);
			if (!existsSync(absoluteTargetPath)) {
				errors.push(
					`${label}: required package path ${targetPath} is missing; run npm run parity:build`,
				);
				continue;
			}
			if (
				targetPath === STAGED_LICENSE_PATH &&
				rootLicenseText !== null &&
				readFileSync(absoluteTargetPath, "utf8") !== rootLicenseText
			) {
				errors.push(`${label}: ${STAGED_LICENSE_PATH} must match the root LICENSE`);
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
		const requiredFiles = ["package.json", STAGED_LICENSE_PATH.slice(2)];
		const errors = [
			...(packument ? [] : [`${workspace.name}: npm pack did not return a workspace packument`]),
			...requiredFiles
				.filter((filePath) => !filePaths.has(filePath))
				.map((filePath) => `${workspace.name}: npm pack did not include ${filePath}`),
			...workspace.requiredFiles
				.map((filePath) => filePath.slice(2))
				.filter((filePath) => !filePaths.has(filePath))
				.map((filePath) => `${workspace.name}: npm pack did not include required file ${filePath}`),
			...[...filePaths]
				.filter((filePath) => /(^|\/)(tests\/|src\/.*\.test\.ts$)/u.test(filePath))
				.sort((left, right) => left.localeCompare(right))
				.map((filePath) => `${workspace.name}: npm pack unexpectedly included ${filePath}`),
		];
		if (errors.length > 0) {
			fail("[publish:dry-run] Package contents check failed:", errors);
		}
		console.info(`${workspace.name}: dry-run pack OK (${packument.files.length} files)`);
	}
}

function rejectAlreadyPublishedVersions(workspaces) {
	for (const workspace of workspaces) {
		const spec = `${workspace.name}@${workspace.packageJson.version}`;
		const result = runNpm(["view", spec, "version", "--json"], { allowFailure: true });
		if (result.status === 0) {
			fail(`${spec} already exists on npm; refusing to publish over an immutable version.`);
		}
		if (!String(result.stderr).includes("E404") && !String(result.stderr).includes("404")) {
			writeOutput(result.stdout);
			writeOutput(result.stderr);
			fail(`Could not verify whether ${spec} exists on npm.`, [], result.status ?? 1);
		}
	}
}

function publishWorkspaces(rootDir, workspaces) {
	const args = ["publish", "--workspaces", "--access", "public"];
	if (process.env.GITHUB_ACTIONS === "true" && process.env.NPM_PUBLISH_PROVENANCE !== "false") {
		args.push("--provenance");
	}
	console.info(`[publish:workspaces] npm ${args.join(" ")} (${workspaces.length} workspaces)`);
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
