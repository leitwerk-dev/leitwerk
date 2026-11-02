import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { listWorkspacePackageDirs } from "./workspace-packages.ts";

export const dependencyFields = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export interface PackageManifest {
	name?: string;
	version?: string;
	private?: boolean;
	workspaces?: string[];
	[key: string]: unknown;
}

export interface WorkspaceManifest {
	path: string;
	manifest: PackageManifest;
}

type JsonRecord = Record<string, unknown>;

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function readJson(filePath: string): JsonRecord {
	return JSON.parse(readFileSync(filePath, "utf8")) as JsonRecord;
}

export function discoverWorkspaces(rootDir: string, rootManifest: PackageManifest) {
	return listWorkspacePackageDirs(rootDir, rootManifest)
		.map((dir) => path.relative(rootDir, dir).split(path.sep).join("/"))
		.sort();
}

export function validateLockstepVersions(input: {
	rootManifest: PackageManifest;
	workspaces: WorkspaceManifest[];
	packageLock: JsonRecord;
	chart: JsonRecord;
	chartValues: JsonRecord;
}): string[] {
	const errors: string[] = [];
	const version = input.rootManifest.version;
	if (typeof version !== "string" || !semverPattern.test(version)) {
		return [`package.json: version '${String(version)}' is not SemVer`];
	}
	const workspaceNames = new Set(input.workspaces.map(({ manifest }) => manifest.name));
	for (const workspace of input.workspaces) {
		if (workspace.manifest.version !== version) {
			errors.push(
				`${workspace.path}/package.json: version '${String(workspace.manifest.version)}' must equal '${version}'`,
			);
		}
		errors.push(
			...validateInternalDependencies(
				`${workspace.path}/package.json`,
				workspace.manifest,
				workspaceNames,
				version,
			),
		);
	}

	if (input.packageLock.version !== version) {
		errors.push(`package-lock.json: version must equal '${version}'`);
	}
	const lockPackages = asRecord(input.packageLock.packages);
	const rootLock = asRecord(lockPackages[""]);
	if (rootLock.version !== version) {
		errors.push(`package-lock.json packages[""]: version must equal '${version}'`);
	}
	for (const workspace of input.workspaces) {
		const lockedWorkspace = asRecord(lockPackages[workspace.path]);
		if (lockedWorkspace.version !== version) {
			errors.push(
				`package-lock.json packages["${workspace.path}"]: version must equal '${version}'`,
			);
		}
		errors.push(
			...validateInternalDependencies(
				`package-lock.json packages["${workspace.path}"]`,
				lockedWorkspace,
				workspaceNames,
				version,
			),
		);
	}

	if (input.chart.version !== version) {
		errors.push(`Chart.yaml: version must equal '${version}'`);
	}
	if (input.chart.appVersion !== version) {
		errors.push(`Chart.yaml: appVersion must equal '${version}'`);
	}
	const serverImage = asRecord(asRecord(input.chartValues.server).image);
	if (serverImage.repository !== "ghcr.io/leitwerk-dev/leitwerk-server") {
		errors.push("values.yaml: server image repository is not the public Leitwerk coordinate");
	}
	if (serverImage.tag !== version) {
		errors.push(`values.yaml: server image tag must equal '${version}'`);
	}
	const workerImage = asRecord(asRecord(input.chartValues.workerRuntimeProfiles).generic).image;
	if (workerImage !== `ghcr.io/leitwerk-dev/leitwerk-worker-generic:${version}`) {
		errors.push(`values.yaml: generic worker image tag must equal '${version}'`);
	}
	return errors;
}

export function validatePublicationWorkflow(workflow: JsonRecord): string[] {
	const jobs = asRecord(workflow.jobs);
	const expectedNeeds: Record<string, string[]> = {
		validate: ["resolve"],
		"inspect-images": ["resolve"],
		"build-images": ["resolve", "inspect-images"],
		"merge-images": ["resolve", "validate", "inspect-images", "build-images"],
		publish: ["resolve", "validate", "merge-images"],
	};
	return Object.entries(expectedNeeds).flatMap(([jobName, expected]) => {
		const configured = asRecord(jobs[jobName]).needs;
		const actual = (Array.isArray(configured) ? configured : [configured])
			.filter((entry): entry is string => typeof entry === "string")
			.sort();
		const sortedExpected = expected.toSorted();
		return actual.length === sortedExpected.length &&
			actual.every((entry, index) => entry === sortedExpected[index])
			? []
			: [
					`.github/workflows/publish.yml: ${jobName}.needs must be [${sortedExpected.join(", ")}], got [${actual.join(", ")}]`,
				];
	});
}

export function validateReleaseContract(rootDir: string): string[] {
	const rootManifest = readJson(path.join(rootDir, "package.json")) as PackageManifest;
	const workspacePaths = discoverWorkspaces(rootDir, rootManifest);
	const workspaces = workspacePaths.map((workspacePath) => ({
		path: workspacePath,
		manifest: readJson(path.join(rootDir, workspacePath, "package.json")) as PackageManifest,
	}));
	const errors = [
		...validateLockstepVersions({
			rootManifest,
			workspaces,
			packageLock: readJson(path.join(rootDir, "package-lock.json")),
			chart: parseYaml(
				readFileSync(path.join(rootDir, "deploy/kubernetes/helm/leitwerk/Chart.yaml"), "utf8"),
			) as JsonRecord,
			chartValues: parseYaml(
				readFileSync(path.join(rootDir, "deploy/kubernetes/helm/leitwerk/values.yaml"), "utf8"),
			) as JsonRecord,
		}),
		...validatePublicationWorkflow(
			parseYaml(
				readFileSync(path.join(rootDir, ".github/workflows/publish.yml"), "utf8"),
			) as JsonRecord,
		),
	];

	for (const workspacePath of workspacePaths) {
		if (existsSync(path.join(rootDir, workspacePath, "CHANGELOG.md"))) {
			errors.push(`${workspacePath}/CHANGELOG.md: only the root changelog is allowed`);
		}
	}
	return errors;
}

export function calculateConventionalVersion(
	currentVersion: string,
	commits: string[],
): string | null {
	const [major, minor, patch] = stableVersionParts(currentVersion);
	for (const commit of commits.toReversed()) {
		const releaseAs = /^Release-As:[ \t]*(\S+)[ \t]*$/imu.exec(commit)?.[1];
		if (releaseAs) {
			if (compareStableVersions(releaseAs, currentVersion) <= 0) {
				throw new Error(`Release-As must increase ${currentVersion}: ${releaseAs}`);
			}
			return releaseAs;
		}
	}
	const breaking = commits.some(
		(commit) =>
			/^[a-z][a-z0-9-]*(?:\([^\r\n()]+\))?!:/u.test(commit) ||
			/^BREAKING[ -]CHANGE:/imu.test(commit),
	);
	if (breaking) return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
	if (commits.some((commit) => /^feat(?:\([^\r\n()]+\))?:/u.test(commit))) {
		return major === 0 ? `0.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
	}
	if (commits.some((commit) => /^fix(?:\([^\r\n()]+\))?:/u.test(commit))) {
		return `${major}.${minor}.${patch + 1}`;
	}
	return null;
}

/** @internal */
export function compareStableVersions(left: string, right: string): number {
	const a = stableVersionParts(left);
	const b = stableVersionParts(right);
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function stableVersionParts(version: string): [number, number, number] {
	const parts = version.split(".").map(Number);
	if (
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
		!parts.every((part) => Number.isSafeInteger(part) && part < Number.MAX_SAFE_INTEGER)
	) {
		throw new Error(`Expected stable X.Y.Z version: ${version}`);
	}
	return parts as [number, number, number];
}

function validateInternalDependencies(
	label: string,
	manifest: PackageManifest,
	workspaceNames: Set<string | undefined>,
	version: string,
) {
	const errors: string[] = [];
	for (const field of dependencyFields) {
		for (const [name, dependencyVersion] of Object.entries(asRecord(manifest[field]))) {
			if (workspaceNames.has(name) && dependencyVersion !== version) {
				errors.push(`${label}: ${field}.${name} must be exactly '${version}'`);
			}
		}
	}
	return errors;
}

function asRecord(value: unknown): JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const rootDir = process.cwd();
	const errors = validateReleaseContract(rootDir);
	if (errors.length > 0) {
		console.error(`[release:check] Validation failed:\n- ${errors.join("\n- ")}`);
		process.exit(1);
	}
	console.info("[release:check] OK");
}
