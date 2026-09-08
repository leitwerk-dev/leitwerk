import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolingRoot = fileURLToPath(new URL("../", import.meta.url));
const registry = "https://registry.npmjs.org/";
const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const readJson = (filename) => JSON.parse(readFileSync(filename, "utf8"));

export function candidateVersion(version, runId) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
		throw new Error("Release PR must propose a stable X.Y.Z version");
	}
	if (!/^[1-9]\d*$/u.test(runId)) throw new Error("Expected a positive workflow run ID");
	return `${version}-rc.${runId}`;
}

export function validateCandidatePull(pull, repository, expectedSha) {
	if (
		pull.state !== "open" ||
		pull.draft !== false ||
		pull.merged_at ||
		pull.user?.login !== "github-actions[bot]" ||
		pull.head?.ref !== "release-please--branches--main" ||
		pull.head?.repo?.full_name !== repository ||
		pull.base?.ref !== "main" ||
		pull.base?.repo?.full_name !== repository ||
		!/^[a-f0-9]{40}$/u.test(pull.head?.sha)
	)
		throw new Error("Expected an open, same-repository Release Please PR targeting main");
	if (expectedSha && pull.head.sha !== expectedSha) {
		throw new Error("Release PR changed during validation; start a new RC run");
	}
	return pull.head.sha;
}

function githubClient(env) {
	if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
		throw new Error("RC publication must be manually dispatched from main");
	}
	if (!env.GITHUB_REPOSITORY || !env.GH_TOKEN)
		throw new Error("GitHub repository and token are required");
	return async (endpoint) => {
		const response = await fetch(
			`${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${endpoint}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${env.GH_TOKEN}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`GitHub RC verification failed: HTTP ${response.status}`);
		return response.json();
	};
}

export async function resolveCandidate(env = process.env) {
	const get = githubClient(env);
	if (!/^[1-9]\d*$/u.test(env.RELEASE_PR)) throw new Error("Expected a release PR number");
	const pull = await get(`pulls/${env.RELEASE_PR}`);
	const sha = validateCandidatePull(pull, env.GITHUB_REPOSITORY, env.RC_GIT_SHA);
	const comparison = await get(`compare/${env.GITHUB_SHA}...${sha}`);
	if (!["ahead", "identical"].includes(comparison.status)) {
		throw new Error("Release PR must include the trusted workflow revision from main");
	}
	const file = await get(`contents/package.json?ref=${sha}`);
	if (file.encoding !== "base64") throw new Error("Expected base64 release package metadata");
	const baseVersion = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version;
	const version = candidateVersion(baseVersion, env.GITHUB_RUN_ID);
	if (env.RC_VERSION && env.RC_VERSION !== version)
		throw new Error("RC version changed during validation");
	return { sha, version, baseVersion };
}

export function workspaceCatalog(root = toolingRoot) {
	return ["packages", "extensions"]
		.flatMap((parent) =>
			readdirSync(path.join(root, parent), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => {
					const directory = `${parent}/${entry.name}`;
					const manifest = readJson(path.join(root, directory, "package.json"));
					if (!/^@leitwerk-dev\/[a-z0-9-]+$/u.test(manifest.name) || manifest.private === true) {
						throw new Error(`Unexpected publishable workspace: ${directory}`);
					}
					return { directory, name: manifest.name };
				}),
		)
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function candidateManifest(manifest, { version, sha, names }) {
	if (!names.has(manifest.name) || !/^[a-f0-9]{40}$/u.test(sha))
		throw new Error("Invalid RC package identity");
	if (!/^\d+\.\d+\.\d+-rc\.[1-9]\d*$/u.test(version))
		throw new Error("Expected an immutable RC version");
	const result = structuredClone(manifest);
	result.version = version;
	result.gitHead = sha;
	result.publishConfig = { access: "public", registry, tag: "next", provenance: true };
	for (const field of fields) {
		for (const name of Object.keys(result[field] ?? {})) {
			if (name.startsWith("@leitwerk-dev/") && !names.has(name)) {
				throw new Error(`Unknown internal RC dependency: ${name}`);
			}
			if (names.has(name)) result[field][name] = version;
		}
	}
	return result;
}

function npm(args, cwd) {
	const cli = process.env.npm_execpath;
	return spawnSync(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function requireSuccess(result) {
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "npm command failed");
	return result.stdout;
}

export function prepareCandidate({
	source,
	destination,
	version,
	sha,
	catalog = workspaceCatalog(),
}) {
	const names = new Set(catalog.map((entry) => entry.name));
	const root = readJson(path.join(source, "package.json"));
	if (!version.startsWith(`${root.version}-rc.`))
		throw new Error("RC must derive from the release PR version");
	mkdirSync(destination, { recursive: true });
	if (readdirSync(destination).length) throw new Error("RC artifact destination must be empty");
	for (const entry of catalog) {
		const filename = path.join(source, entry.directory, "package.json");
		const manifest = readJson(filename);
		if (manifest.name !== entry.name || manifest.version !== root.version) {
			throw new Error(`Release PR workspace differs from trusted catalog: ${entry.directory}`);
		}
		writeFileSync(
			filename,
			`${JSON.stringify(candidateManifest(manifest, { version, sha, names }), null, "\t")}\n`,
		);
	}
	const args = catalog.flatMap((entry) => ["--workspace", entry.name]);
	requireSuccess(
		npm(["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", destination], source),
	);
	return verifyCandidateArchives({ directory: destination, version, sha, catalog });
}

export function verifyCandidateArchives({ directory, version, sha, catalog = workspaceCatalog() }) {
	const names = new Set(catalog.map((entry) => entry.name));
	const files = readdirSync(directory).sort();
	const expected = catalog
		.map((entry) => `${entry.name.replace("@", "").replace("/", "-")}-${version}.tgz`)
		.sort();
	if (JSON.stringify(files) !== JSON.stringify(expected))
		throw new Error("RC artifacts must exactly match the trusted package catalog");
	return catalog.map((entry) => {
		const filename = path.join(
			directory,
			`${entry.name.replace("@", "").replace("/", "-")}-${version}.tgz`,
		);
		const manifest = JSON.parse(
			execFileSync("tar", ["-xOf", filename, "package/package.json"], {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
			}),
		);
		const checked = candidateManifest(manifest, { version, sha, names });
		if (manifest.name !== entry.name || JSON.stringify(checked) !== JSON.stringify(manifest)) {
			throw new Error(
				`RC archive has unexpected identity, version, dependencies, or publish configuration: ${entry.name}`,
			);
		}
		return {
			name: entry.name,
			filename,
			version,
			sha,
			integrity: `sha512-${createHash("sha512").update(readFileSync(filename)).digest("base64")}`,
		};
	});
}

export function validateExistingCandidate(metadata, archive) {
	if (
		metadata.version !== archive.version ||
		metadata.gitHead !== archive.sha ||
		metadata.dist?.integrity !== archive.integrity
	) {
		throw new Error(`Existing ${archive.name}@${archive.version} belongs to different contents`);
	}
}

export function validateNextTag(current, version) {
	if (current === undefined || current === "") return;
	const parse = (value) =>
		/^(\d+)\.(\d+)\.(\d+)-rc\.([1-9]\d*)$/u.exec(value)?.slice(1).map(BigInt);
	const previous = parse(current);
	const target = parse(version);
	if (!previous || !target) throw new Error("Unexpected next tag; refusing to replace it");
	for (let index = 0; index < previous.length; index++) {
		if (previous[index] < target[index]) return;
		if (previous[index] > target[index])
			throw new Error("A newer RC is already under next; start a new run");
	}
}

function registryMetadata(result, allowMissingField = false) {
	if (result.status === 0) {
		if (result.stdout.trim()) {
			const value = JSON.parse(result.stdout);
			if (value !== null) return value;
		}
		if (allowMissingField) return undefined;
		throw new Error("Registry returned no package metadata");
	}
	let error;
	try {
		error = JSON.parse(result.stdout).error;
	} catch {
		/* Fail closed for non-JSON registry errors. */
	}
	if (error?.code === "E404") return undefined;
	requireSuccess(result);
}

export async function publishCandidate(
	env = process.env,
	{ runNpm = npm, catalog = workspaceCatalog() } = {},
) {
	if (env.RC_PUBLISH !== "true")
		throw new Error("Publishing requires explicit RC_PUBLISH=true opt-in");
	await resolveCandidate(env); // Recheck the PR is still open and still points to the validated SHA.
	const archives = verifyCandidateArchives({
		directory: env.RC_ARTIFACTS,
		version: env.RC_VERSION,
		sha: env.RC_GIT_SHA,
		catalog,
	});
	const pending = [];
	// Check every coordinate before the first external write. Never overwrite a partial release.
	for (const archive of archives) {
		const spec = `${archive.name}@${archive.version}`;
		const metadata = registryMetadata(
			runNpm(
				["view", spec, "version", "gitHead", "dist.integrity", "--json", "--registry", registry],
				toolingRoot,
			),
		);
		if (metadata) {
			validateExistingCandidate(
				{ ...metadata, dist: { integrity: metadata["dist.integrity"] } },
				archive,
			);
		} else {
			pending.push(archive);
		}
		validateNextTag(
			registryMetadata(
				runNpm(
					["view", archive.name, "dist-tags.next", "--json", "--registry", registry],
					toolingRoot,
				),
				true,
			),
			archive.version,
		);
	}
	for (const archive of pending) {
		console.info(`Publishing ${archive.name}@${archive.version} under next`);
		requireSuccess(
			runNpm(
				[
					"publish",
					archive.filename,
					"--tag",
					"next",
					"--access",
					"public",
					"--registry",
					registry,
					"--ignore-scripts",
					"--provenance",
				],
				toolingRoot,
			),
		);
	}
	for (const archive of pending) {
		let metadata;
		for (let attempt = 0; attempt < 5; attempt++) {
			metadata = registryMetadata(
				runNpm(
					[
						"view",
						`${archive.name}@${archive.version}`,
						"version",
						"gitHead",
						"dist.integrity",
						"--json",
						"--registry",
						registry,
					],
					toolingRoot,
				),
			);
			if (metadata) break;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		if (!metadata) throw new Error(`Published RC is not visible on npm: ${archive.name}`);
		validateExistingCandidate(
			{ ...metadata, dist: { integrity: metadata["dist.integrity"] } },
			archive,
		);
	}
	console.info(
		`RC publication complete: ${pending.length} published, ${archives.length - pending.length} already present. latest was not changed.`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const command = process.argv[2];
	if (command === "resolve") {
		const result = await resolveCandidate();
		appendFileSync(process.env.GITHUB_OUTPUT, `git_sha=${result.sha}\nversion=${result.version}\n`);
		console.info(`Release PR #${process.env.RELEASE_PR}: ${result.sha} → ${result.version} (next)`);
	} else if (command === "prepare") {
		const archives = prepareCandidate({
			source: process.cwd(),
			destination: path.resolve(process.env.RC_ARTIFACTS),
			version: process.env.RC_VERSION,
			sha: process.env.RC_GIT_SHA,
		});
		console.info(`Prepared ${archives.length} verified RC package archives`);
	} else if (command === "publish") {
		await publishCandidate();
	} else throw new Error("Expected resolve, prepare, or publish");
}
